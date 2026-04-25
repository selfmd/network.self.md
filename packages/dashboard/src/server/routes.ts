import Fastify from 'fastify';
import cors from '@fastify/cors';
import type Database from 'better-sqlite3';
import type { ApiStatus, ApiPeer, ApiState, ApiActivity, ApiDiscoveredState } from './types.js';

function bytesToHex(bytes: Buffer | Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

export interface DashboardDb {
  db: Database.Database;
}

export async function buildApp({ db }: DashboardDb) {
  const app = Fastify();

  await app.register(cors);

  const identityRow = db
    .prepare('SELECT * FROM identity WHERE id = 1')
    .get() as { ed_public_key: Buffer; display_name: string | null } | undefined;

  const fingerprint = identityRow
    ? bytesToHex(identityRow.ed_public_key).slice(0, 32)
    : 'unknown';

  let agentFingerprint = fingerprint;
  let agentDisplayName = identityRow?.display_name ?? undefined;

  if (identityRow) {
    const { fingerprintFromPublicKey } = await import('@networkselfmd/core');
    agentFingerprint = fingerprintFromPublicKey(new Uint8Array(identityRow.ed_public_key));
  }

  const startedAt = Date.now();

  app.get('/api/status', async (): Promise<ApiStatus> => {
    const peers = db.prepare('SELECT * FROM peers').all() as Array<{ last_seen: number | null }>;
    const states = db.prepare('SELECT * FROM groups').all();
    const onlineThreshold = Date.now() - 3_600_000;
    const peersOnline = peers.filter((p) => p.last_seen && p.last_seen > onlineThreshold).length;

    return {
      agentFingerprint,
      agentDisplayName,
      peersOnline,
      peersTotal: peers.length,
      stateCount: states.length,
      uptime: Date.now() - startedAt,
    };
  });

  app.get('/api/peers', async (): Promise<ApiPeer[]> => {
    const peers = db
      .prepare('SELECT * FROM peers ORDER BY last_seen DESC')
      .all() as Array<{
        public_key: Buffer;
        fingerprint: string;
        display_name: string | null;
        trusted: number;
        last_seen: number | null;
      }>;

    const onlineThreshold = Date.now() - 3_600_000;

    return peers.map((p) => ({
      fingerprint: p.fingerprint,
      displayName: p.display_name ?? undefined,
      online: !!(p.last_seen && p.last_seen > onlineThreshold),
      lastSeen: p.last_seen ?? 0,
      trusted: p.trusted === 1,
    }));
  });

  app.get('/api/states', async (): Promise<ApiState[]> => {
    const seen = new Map<string, ApiState>();

    // Local states (agent is a member)
    const locals = db
      .prepare('SELECT * FROM groups ORDER BY joined_at DESC')
      .all() as Array<{
        group_id: Buffer;
        name: string;
        role: string;
        created_at: number;
        joined_at: number | null;
        is_public: number;
        self_md: string | null;
      }>;

    for (const g of locals) {
      const lastMsg = db
        .prepare('SELECT timestamp FROM messages WHERE group_id = ? ORDER BY timestamp DESC LIMIT 1')
        .get(g.group_id) as { timestamp: number } | undefined;

      const memberCount = db
        .prepare('SELECT COUNT(*) as count FROM group_members WHERE group_id = ?')
        .get(g.group_id) as { count: number };

      seen.set(bytesToHex(g.group_id), {
        id: bytesToHex(g.group_id),
        name: g.name,
        memberCount: memberCount.count,
        role: g.role as 'admin' | 'member',
        lastActivity: lastMsg?.timestamp ?? g.created_at,
        selfMd: g.self_md ?? undefined,
        isPublic: g.is_public === 1,
      });
    }

    // Discovered states (from network announcements)
    const tableExists = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='discovered_groups'")
      .get();

    if (tableExists) {
      const discovered = db
        .prepare('SELECT * FROM discovered_groups ORDER BY last_announced DESC')
        .all() as Array<{
          group_id: Buffer;
          name: string;
          self_md: string | null;
          member_count: number;
          last_announced: number;
        }>;

      for (const g of discovered) {
        const id = bytesToHex(g.group_id);
        if (!seen.has(id)) {
          seen.set(id, {
            id,
            name: g.name,
            memberCount: g.member_count,
            role: 'member',
            lastActivity: g.last_announced,
            selfMd: g.self_md ?? undefined,
            isPublic: true,
          });
        }
      }
    }

    return [...seen.values()];
  });

  app.get('/api/activity', async (): Promise<ApiActivity[]> => {
    const messages = db
      .prepare('SELECT id, group_id, sender_public_key, timestamp, type FROM messages ORDER BY timestamp DESC LIMIT 50')
      .all() as Array<{
        id: string;
        group_id: Buffer | null;
        sender_public_key: Buffer | null;
        timestamp: number;
        type: string;
      }>;

    const peers = db
      .prepare('SELECT public_key, fingerprint, display_name FROM peers')
      .all() as Array<{
        public_key: Buffer;
        fingerprint: string;
        display_name: string | null;
      }>;

    const peerMap = new Map<string, { fingerprint: string; displayName?: string }>();
    for (const p of peers) {
      peerMap.set(bytesToHex(p.public_key), {
        fingerprint: p.fingerprint,
        displayName: p.display_name ?? undefined,
      });
    }

    const stateRows = db
      .prepare('SELECT group_id, name FROM groups')
      .all() as Array<{ group_id: Buffer; name: string }>;
    const stateMap = new Map<string, string>();
    for (const g of stateRows) {
      stateMap.set(bytesToHex(g.group_id), g.name);
    }

    return messages.map((m): ApiActivity => {
      let actor: string | undefined;
      let actorName: string | undefined;
      if (m.sender_public_key) {
        const key = bytesToHex(m.sender_public_key);
        const peer = peerMap.get(key);
        actor = peer?.fingerprint ?? key.slice(0, 16);
        actorName = peer?.displayName;
      }

      const target = m.group_id ? stateMap.get(bytesToHex(m.group_id)) : undefined;

      return {
        timestamp: m.timestamp,
        type: (m.type as ApiActivity['type']) || 'message',
        actor,
        actorName,
        target,
      };
    });
  });

  app.get('/api/discovered-states', async (): Promise<ApiDiscoveredState[]> => {
    const tableExists = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='discovered_groups'")
      .get();

    if (!tableExists) return [];

    const rows = db
      .prepare('SELECT * FROM discovered_groups ORDER BY last_announced DESC')
      .all() as Array<{
        group_id: Buffer;
        name: string;
        self_md: string | null;
        member_count: number;
        last_announced: number;
      }>;

    return rows.map((g) => ({
      id: bytesToHex(g.group_id),
      name: g.name,
      selfMd: g.self_md,
      memberCount: g.member_count,
      lastAnnounced: g.last_announced,
    }));
  });

  return app;
}
