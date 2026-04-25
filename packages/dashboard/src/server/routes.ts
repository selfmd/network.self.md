import Fastify from 'fastify';
import cors from '@fastify/cors';
import type { Agent } from '@networkselfmd/node';
import type { ApiStatus, ApiPeer, ApiState } from './types.js';

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

  app.get('/api/status', async (): Promise<ApiStatus> => {
    const peers = agent.listPeers();
    const states = agent.listGroups();
    const discovered = agent.listDiscoveredGroups();

    return {
      agentFingerprint: agent.identity.fingerprint,
      agentDisplayName: agent.identity.displayName,
      peersOnline: peers.filter((p) => p.online).length,
      peersTotal: peers.length,
      stateCount: states.length + discovered.length,
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
    const byName = new Map<string, ApiState>();

    // Own states
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

    // Discovered states from network
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
  });

  return app;
}
