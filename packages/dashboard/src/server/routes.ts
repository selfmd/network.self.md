import Fastify from 'fastify';
import cors from '@fastify/cors';
import type { Agent } from '@networkselfmd/node';
import type { ApiStatus, ApiPeer, ApiState, ApiStateDetail } from './types.js';

function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

export interface DashboardAgent {
  agent: Agent;
}

export async function buildApp({ agent }: DashboardAgent) {
  const app = Fastify();

  await app.register(cors);

  const startedAt = Date.now();

  function getMergedStates(): ApiState[] {
    const byName = new Map<string, ApiState>();

    for (const s of agent.listGroups()) {
      byName.set(s.name, {
        id: bytesToHex(s.groupId),
        name: s.name,
        memberCount: s.memberCount,
        lastActivity: s.joinedAt,
        selfMd: s.selfMd,
        isPublic: s.isPublic ?? false,
      });
    }

    for (const d of agent.listDiscoveredGroups()) {
      const existing = byName.get(d.name);
      if (existing) {
        existing.memberCount = Math.max(existing.memberCount, d.memberCount);
        if (!existing.selfMd && d.selfMd) existing.selfMd = d.selfMd;
      } else {
        byName.set(d.name, {
          id: bytesToHex(d.groupId),
          name: d.name,
          memberCount: d.memberCount,
          lastActivity: Date.now(),
          selfMd: d.selfMd ?? undefined,
          isPublic: true,
        });
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
    };
  });

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

  app.get<{ Params: { id: string } }>('/api/states/:id', async (request, reply): Promise<ApiStateDetail> => {
    const { id } = request.params;

    // Find in own groups first
    const ownGroups = agent.listGroups();
    const ownGroup = ownGroups.find((g) => bytesToHex(g.groupId) === id);

    if (!ownGroup) {
      // Check discovered
      const discovered = agent.listDiscoveredGroups();
      const disc = discovered.find((g) => bytesToHex(g.groupId) === id);
      if (!disc) {
        reply.status(404);
        return { id, name: '', memberCount: 0, lastActivity: 0, isPublic: false, members: [], messages: [] };
      }

      return {
        id,
        name: disc.name,
        memberCount: disc.memberCount,
        lastActivity: Date.now(),
        selfMd: disc.selfMd ?? undefined,
        isPublic: true,
        members: [],
        messages: [],
      };
    }

    // Get members
    const members = agent.getGroupMembers(id).map((m) => ({
      fingerprint: m.fingerprint,
      displayName: m.displayName,
      role: m.role,
    }));

    // Get messages
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
