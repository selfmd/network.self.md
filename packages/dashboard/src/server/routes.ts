import Fastify from 'fastify';
import cors from '@fastify/cors';
import type Database from 'better-sqlite3';
import type { ApiStatus, ApiPeer, ApiState } from './types.js';

function bytesToHex(bytes: Buffer | Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

export interface DashboardDb {
  db: Database.Database;
}

interface MergedState {
  id: string;
  name: string;
  memberCount: number;
  lastActivity: number;
  selfMd?: string;
  isPublic: boolean;
}

function getMergedStates(db: Database.Database): MergedState[] {
  const byName = new Map<string, MergedState>();

  // Local states (agent is a member — richer data)
  const locals = db
    .prepare('SELECT * FROM groups ORDER BY joined_at DESC')
    .all() as Array<{
      group_id: Buffer;
      name: string;
      created_at: number;
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

    const existing = byName.get(g.name);
    const entry: MergedState = {
      id: bytesToHex(g.group_id),
      name: g.name,
      memberCount: existing ? Math.max(existing.memberCount, memberCount.count) : memberCount.count,
      lastActivity: lastMsg?.timestamp ?? g.created_at,
      selfMd: g.self_md ?? existing?.selfMd ?? undefined,
      isPublic: g.is_public === 1,
    };

    if (existing) {
      entry.lastActivity = Math.max(existing.lastActivity, entry.lastActivity);
      entry.isPublic = existing.isPublic || entry.isPublic;
    }

    byName.set(g.name, entry);
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
      const existing = byName.get(g.name);
      if (existing) {
        existing.memberCount = Math.max(existing.memberCount, g.member_count);
        existing.lastActivity = Math.max(existing.lastActivity, g.last_announced);
        if (!existing.selfMd && g.self_md) existing.selfMd = g.self_md;
      } else {
        byName.set(g.name, {
          id: bytesToHex(g.group_id),
          name: g.name,
          memberCount: g.member_count,
          lastActivity: g.last_announced,
          selfMd: g.self_md ?? undefined,
          isPublic: true,
        });
      }
    }
  }

  return [...byName.values()];
}

export async function buildApp({ db }: DashboardDb) {
  const app = Fastify();

  await app.register(cors);

  const identityRow = db
    .prepare('SELECT * FROM identity WHERE id = 1')
    .get() as { ed_public_key: Buffer; display_name: string | null } | undefined;

  let agentFingerprint = identityRow
    ? bytesToHex(identityRow.ed_public_key).slice(0, 32)
    : 'unknown';
  const agentDisplayName = identityRow?.display_name ?? undefined;

  if (identityRow) {
    const { fingerprintFromPublicKey } = await import('@networkselfmd/core');
    agentFingerprint = fingerprintFromPublicKey(new Uint8Array(identityRow.ed_public_key));
  }

  const startedAt = Date.now();
  const onlineThreshold = () => Date.now() - 3_600_000;

  app.get('/api/status', async (): Promise<ApiStatus> => {
    const peers = db.prepare('SELECT * FROM peers').all() as Array<{ last_seen: number | null }>;
    const states = getMergedStates(db);
    const threshold = onlineThreshold();
    const peersOnline = peers.filter((p) => p.last_seen && p.last_seen > threshold).length;

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

    const threshold = onlineThreshold();

    return peers.map((p) => ({
      fingerprint: p.fingerprint,
      displayName: p.display_name ?? undefined,
      online: !!(p.last_seen && p.last_seen > threshold),
      lastSeen: p.last_seen ?? 0,
      trusted: p.trusted === 1,
    }));
  });

  app.get('/api/states', async (): Promise<ApiState[]> => {
    return getMergedStates(db);
  });

  return app;
}
