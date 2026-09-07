import { buildPublicObservation, validatePublicPublicationConfig, type PublicPublicationConfig } from './publicNetwork.js';
import { createHash, timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Agent } from '@networkselfmd/node';
import type { ApiStatus, ApiPeer, ApiState, ApiStateDetail, ApiDiscoveredState, ApiJoinResponse, ApiIdentity } from './types.js';
import { validateOperatorOrigin, type DashboardBasicAuth } from './config.js';

declare module 'fastify' {
  interface FastifyContextConfig { publicSiteAsset?: boolean; }
}

function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const LOCAL_ORIGIN_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function isAllowedLocalOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  try {
    const url = new URL(origin);
    return (url.protocol === 'http:' || url.protocol === 'https:') && LOCAL_ORIGIN_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

function originHeader(request: FastifyRequest): string | undefined {
  const origin = request.headers.origin;
  return Array.isArray(origin) ? origin[0] : origin;
}

const LOCALHOST_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

async function requireMutationOrigin(request: FastifyRequest, reply: FastifyReply, operatorOrigin?: string): Promise<void> {
  const origin = originHeader(request);
  if (origin) {
    if (!isAllowedLocalOrigin(origin) && origin !== operatorOrigin) {
      await reply.status(403).send({ error: { code: 'forbidden-origin', message: 'mutations require a localhost or configured operator origin' } });
    }
    return;
  }
  // No Origin header (non-browser client) — verify the request comes from localhost
  if (!request.ip || !LOCALHOST_IPS.has(request.ip)) {
    await reply.status(403).send({ error: { code: 'forbidden-origin', message: 'mutations require a localhost or configured operator origin' } });
  }
}

function isHexId(id: string): boolean {
  return id.length >= 2 && id.length <= 128 && id.length % 2 === 0 && /^[0-9a-f]+$/i.test(id);
}

export interface DashboardAgent {
  agent: Agent;
  auth?: DashboardBasicAuth;
  publication?: PublicPublicationConfig;
  operatorOrigin?: string;
  publicSite?: boolean;
}

function credentialDigest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function basicCredentials(header: string | undefined): string {
  if (!header) return '';
  const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/.exec(header);
  if (!match) return '';
  try {
    return Buffer.from(match[1], 'base64').toString('utf8');
  } catch {
    return '';
  }
}

export async function buildApp({ agent, auth, publication, operatorOrigin, publicSite = false }: DashboardAgent) {
  if (operatorOrigin !== undefined) {
    operatorOrigin = validateOperatorOrigin(operatorOrigin);
    if (!auth) throw new Error('An operator origin requires dashboard authentication');
  }
  if (publicSite && (!auth || publication === undefined)) {
    throw new Error('Public site requires dashboard authentication and explicit publication configuration');
  }
  const approvedPublication = validatePublicPublicationConfig(publication);
  const app = Fastify();

  if (auth) {
    const expected = credentialDigest(`${auth.username}:${auth.password}`);
    app.addHook('onRequest', async (request, reply) => {
      const route = request.routeOptions.url;
      if (route === '/healthz') return;
      if (publicSite && (request.method === 'GET' || request.method === 'HEAD') &&
          (route === '/api/public/network' || request.routeOptions.config.publicSiteAsset === true)) return;
      const actual = credentialDigest(
        basicCredentials(request.headers.authorization),
      );
      if (!timingSafeEqual(expected, actual)) {
        await reply
          .header('WWW-Authenticate', 'Basic realm="network.self.md", charset="UTF-8"')
          .status(401)
          .send({ error: { code: 'unauthorized', message: 'Authentication required' } });
      }
    });
  }

  await app.register(cors, {
    origin: (origin, callback) => {
      callback(null, isAllowedLocalOrigin(origin) || (operatorOrigin !== undefined && origin === operatorOrigin));
    },
  });

  await app.register(helmet, { global: false });
  app.addHook('onRequest', async (request, reply) => {
    // Safari/WebKit upgrades even loopback asset URLs when this CSP directive
    // is present. The local dashboard serves HTTP and has no TLS listener.
    const localHttp = request.protocol === 'http' &&
      ['localhost', '127.0.0.1', '::1', '[::1]'].includes(request.hostname);
    await reply.helmet(localHttp ? {
      contentSecurityPolicy: { directives: { 'upgrade-insecure-requests': null } },
      strictTransportSecurity: false,
    } : {});
  });
  await app.register(rateLimit, { max: 100, timeWindow: '1 minute' });

  const startedAt = Date.now();

  app.get('/healthz', async () => ({ ok: true, uptime: Date.now() - startedAt }));

  function getOwnStates(): ApiState[] {
    return agent.listGroups().map((s) => ({
      id: bytesToHex(s.groupId),
      name: s.name,
      memberCount: s.memberCount,
      lastActivity: s.joinedAt,
      selfMd: s.selfMd,
      isPublic: s.isPublic ?? false,
    }));
  }

  function getDiscoveredStates(): ApiDiscoveredState[] {
    return agent.listDiscoveredGroups().map((d) => ({
      id: bytesToHex(d.groupId),
      name: d.name,
      memberCount: d.memberCount,
      lastActivity: Date.now(),
      selfMd: d.selfMd ?? undefined,
      isPublic: true,
      discoveredAt: Date.now(),
    }));
  }

  function getMergedStates(): ApiState[] {
    const byId = new Map<string, ApiState>();

    for (const s of getOwnStates()) {
      byId.set(s.id, s);
    }

    for (const d of getDiscoveredStates()) {
      // Names are not unique; joined metadata is authoritative for this ID.
      if (!byId.has(d.id)) byId.set(d.id, d);
    }

    return [...byId.values()];
  }

  app.get('/api/public/network', async (_request, reply) => {
    const observedAt = new Date().toISOString();
    reply.header('Cache-Control', 'no-store');
    return buildPublicObservation({ states: getMergedStates(), peers: agent.listPeers(), observedAt }, approvedPublication);
  });

  app.get('/api/status', async (): Promise<ApiStatus> => {
    const peers = agent.listPeers();
    const states = getMergedStates();

    return {
      agentFingerprint: agent.identity.fingerprint,
      agentDisplayName: agent.identity.displayName,
      peersOnline: peers.filter((p) => p.online).length,
      peersTotal: peers.length,
      stateCount: states.length,
      uptime: Date.now() - startedAt,
      online: agent.isRunning,
      syncPct: null,
      latencyMsP50: null,
      latencyMsP95: null,
      capabilities: {
        wireTrace: false,
        keyRotation: false,
        keyRevoke: false,
        keyExport: false,
        discovery: true,
      },
    };
  });

  app.get('/api/identity', async (): Promise<ApiIdentity> => ({
    fingerprint: agent.identity.fingerprint,
    displayName: agent.identity.displayName,
  }));

  app.get('/api/peers', async (): Promise<ApiPeer[]> => {
    return agent.listPeers().map((p) => ({
      fingerprint: p.fingerprint,
      displayName: p.displayName,
      online: p.online,
      lastSeen: p.lastSeen,
      trusted: p.trusted,
    }));
  });

  app.get('/api/states', async (): Promise<ApiState[]> => {
    return getMergedStates();
  });

  app.get('/api/discovery/states', async (): Promise<ApiDiscoveredState[]> => {
    return getDiscoveredStates();
  });

  app.post<{ Params: { id: string } }>('/api/discovery/states/:id/join', { preHandler: (request, reply) => requireMutationOrigin(request, reply, operatorOrigin) }, async (request, reply): Promise<ApiJoinResponse> => {
    const { id } = request.params;
    if (!isHexId(id)) {
      reply.status(400);
      return { ok: false, reason: 'invalid', message: 'invalid public state id' };
    }

    const discovered = getDiscoveredStates().find((s) => s.id === id);
    if (!discovered) {
      reply.status(404);
      return { ok: false, reason: 'unknown', message: 'public state not found' };
    }

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) =>
        timeoutId = setTimeout(() => reject(new Error('Join group timed out')), 30_000)
      );
      await Promise.race([agent.joinPublicGroup(id), timeout]);
      const state = getMergedStates().find((s) => s.id === id) ?? discovered;
      return { ok: true, state };
    } catch (err) {
      console.error('[API Error]', errorMessage(err));
      reply.status(502);
      return { ok: false, reason: 'unreachable', message: 'Failed to join group' };
    } finally {
      clearTimeout(timeoutId);
    }
  });

  app.get('/api/wire/events', async (_request, reply) => {
    reply.status(501);
    return { error: { code: 'wire-trace-unavailable', message: 'wire trace is not implemented in the Agent API yet' } };
  });

  app.get('/api/security/keys', async (_request, reply) => {
    reply.status(501);
    return { error: { code: 'security-keys-unavailable', message: 'key rotation/revoke/export APIs are not implemented yet' } };
  });

  app.get<{ Params: { id: string } }>('/api/states/:id', async (request, reply): Promise<ApiStateDetail> => {
    const { id } = request.params;

    const ownGroups = agent.listGroups();
    const ownGroup = ownGroups.find((g) => bytesToHex(g.groupId) === id);

    if (!ownGroup) {
      const disc = getDiscoveredStates().find((g) => g.id === id);
      if (!disc) {
        reply.status(404);
        return { id, name: '', memberCount: 0, lastActivity: 0, isPublic: false, members: [], messages: [] };
      }

      return {
        id,
        name: disc.name,
        memberCount: disc.memberCount,
        lastActivity: disc.lastActivity,
        selfMd: disc.selfMd,
        isPublic: true,
        members: [],
        messages: [],
      };
    }

    const members = agent.getGroupMembers(id).map((m) => ({
      fingerprint: m.fingerprint,
      displayName: m.displayName,
      role: m.role,
    }));

    const peerMap = new Map<string, string>();
    for (const p of agent.listPeers()) {
      peerMap.set(bytesToHex(p.publicKey), p.displayName ?? p.fingerprint.slice(0, 8));
    }

    const rawMessages = agent.getMessages({ groupId: id, limit: 100 });
    const messages = rawMessages.map((m) => {
      const senderHex = m.senderPublicKey ? bytesToHex(m.senderPublicKey) : undefined;
      return {
        id: m.id,
        senderFingerprint: senderHex?.slice(0, 16),
        senderName: senderHex ? peerMap.get(senderHex) : undefined,
        content: m.content,
        timestamp: m.timestamp,
      };
    });

    return {
      id,
      name: ownGroup.name,
      memberCount: ownGroup.memberCount,
      lastActivity: ownGroup.joinedAt ?? ownGroup.createdAt,
      selfMd: ownGroup.selfMd,
      isPublic: ownGroup.isPublic ?? false,
      members,
      messages,
    };
  });

  return app;
}
