import Fastify from 'fastify';
import cors from '@fastify/cors';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Agent } from '@networkselfmd/node';
import type { ApiStatus, ApiPeer, ApiState, ApiStateDetail, ApiDiscoveredState, ApiJoinResponse, ApiIdentity } from './types.js';

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

async function requireLocalMutationOrigin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const origin = originHeader(request);
  if (origin) {
    if (!isAllowedLocalOrigin(origin)) {
      await reply.status(403).send({ error: { code: 'forbidden-origin', message: 'mutations require a localhost origin' } });
    }
    return;
  }
  // No Origin header (non-browser client) — verify the request comes from localhost
  if (!request.ip || !LOCALHOST_IPS.has(request.ip)) {
    await reply.status(403).send({ error: { code: 'forbidden-origin', message: 'mutations require a localhost origin' } });
  }
}

function isHexId(id: string): boolean {
  return id.length >= 2 && id.length <= 128 && id.length % 2 === 0 && /^[0-9a-f]+$/i.test(id);
}

export interface DashboardAgent {
  agent: Agent;
}

export async function buildApp({ agent }: DashboardAgent) {
  const app = Fastify();

  await app.register(cors, {
    origin: (origin, callback) => {
      callback(null, isAllowedLocalOrigin(origin));
    },
  });

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
    const byName = new Map<string, ApiState>();

    for (const s of getOwnStates()) {
      byName.set(s.name, s);
    }

    for (const d of getDiscoveredStates()) {
      const existing = byName.get(d.name);
      if (existing) {
        existing.memberCount = Math.max(existing.memberCount, d.memberCount);
        if (!existing.selfMd && d.selfMd) existing.selfMd = d.selfMd;
      } else {
        byName.set(d.name, d);
      }
    }

    return [...byName.values()];
  }

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
      syncPct: 100,
      latencyMsP50: 0,
      latencyMsP95: 0,
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

  app.post<{ Params: { id: string } }>('/api/discovery/states/:id/join', { preHandler: requireLocalMutationOrigin }, async (request, reply): Promise<ApiJoinResponse> => {
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

    try {
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Join group timed out')), 30_000)
      );
      await Promise.race([agent.joinPublicGroup(id), timeout]);
      const state = getMergedStates().find((s) => s.id === id || s.name === discovered.name) ?? discovered;
      return { ok: true, state };
    } catch (err) {
      console.error('[API Error]', errorMessage(err));
      reply.status(502);
      return { ok: false, reason: 'unreachable', message: 'Failed to join group' };
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
