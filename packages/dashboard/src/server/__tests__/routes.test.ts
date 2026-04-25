import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { buildApp } from '../routes.js';
import type { FastifyInstance } from 'fastify';

function seedTestDb(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS identity (
      id INTEGER PRIMARY KEY,
      ed_private_key BLOB NOT NULL,
      ed_public_key BLOB NOT NULL,
      display_name TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS peers (
      public_key BLOB PRIMARY KEY,
      fingerprint TEXT NOT NULL,
      display_name TEXT,
      trusted INTEGER DEFAULT 0,
      last_seen INTEGER
    );
    CREATE TABLE IF NOT EXISTS groups (
      group_id BLOB PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      created_at INTEGER NOT NULL,
      joined_at INTEGER,
      is_public INTEGER DEFAULT 0,
      self_md TEXT
    );
    CREATE TABLE IF NOT EXISTS group_members (
      group_id BLOB NOT NULL,
      public_key BLOB NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      PRIMARY KEY (group_id, public_key)
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      group_id BLOB,
      sender_public_key BLOB,
      peer_public_key BLOB,
      content TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      type TEXT NOT NULL DEFAULT 'group'
    );
    CREATE TABLE IF NOT EXISTS discovered_groups (
      group_id BLOB PRIMARY KEY,
      name TEXT NOT NULL,
      self_md TEXT,
      member_count INTEGER NOT NULL DEFAULT 0,
      last_announced INTEGER NOT NULL
    );
  `);

  const now = Date.now();
  const onlinePeerKey = Buffer.alloc(32, 1);
  const offlinePeerKey = Buffer.alloc(32, 2);
  const groupId = Buffer.alloc(16, 0xab);
  const identityKey = Buffer.alloc(32, 0x42);

  // Identity
  db.prepare('INSERT INTO identity (id, ed_private_key, ed_public_key, display_name, created_at) VALUES (1, ?, ?, ?, ?)')
    .run(identityKey, identityKey, 'TestAgent', now);

  // Peers
  db.prepare('INSERT INTO peers (public_key, fingerprint, display_name, trusted, last_seen) VALUES (?, ?, ?, ?, ?)')
    .run(onlinePeerKey, 'peer1fp', 'Peer One', 1, now);
  db.prepare('INSERT INTO peers (public_key, fingerprint, display_name, trusted, last_seen) VALUES (?, ?, ?, ?, ?)')
    .run(offlinePeerKey, 'peer2fp', null, 0, now - 7200000);

  // Groups + members
  db.prepare('INSERT INTO groups (group_id, name, role, created_at, joined_at, is_public, self_md) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(groupId, 'Test Group', 'admin', now - 86400000, now - 86400000, 1, 'A test group');
  db.prepare('INSERT INTO group_members (group_id, public_key, role) VALUES (?, ?, ?)')
    .run(groupId, onlinePeerKey, 'admin');
  db.prepare('INSERT INTO group_members (group_id, public_key, role) VALUES (?, ?, ?)')
    .run(groupId, offlinePeerKey, 'member');
  db.prepare('INSERT INTO group_members (group_id, public_key, role) VALUES (?, ?, ?)')
    .run(groupId, identityKey, 'admin');

  // Messages
  db.prepare('INSERT INTO messages (id, group_id, sender_public_key, content, timestamp, type) VALUES (?, ?, ?, ?, ?, ?)')
    .run('msg1', groupId, onlinePeerKey, 'This is secret content that should NOT appear', now - 5000, 'message');

  // Discovered group with same name — should merge
  const discoveredGroupId = Buffer.alloc(16, 0xcd);
  db.prepare('INSERT INTO discovered_groups (group_id, name, self_md, member_count, last_announced) VALUES (?, ?, ?, ?, ?)')
    .run(discoveredGroupId, 'Test Group', 'A test group discovered', 10, now - 10000);

  // Discovered group with unique name — should appear separately
  const uniqueGroupId = Buffer.alloc(16, 0xef);
  db.prepare('INSERT INTO discovered_groups (group_id, name, self_md, member_count, last_announced) VALUES (?, ?, ?, ?, ?)')
    .run(uniqueGroupId, 'Public Only', 'Only in discovered', 5, now - 20000);
}

describe('Dashboard API routes', () => {
  let app: FastifyInstance;
  let db: Database.Database;

  beforeAll(async () => {
    db = new Database(':memory:');
    seedTestDb(db);
    app = await buildApp({ db });
  });

  afterAll(() => {
    db.close();
  });

  it('GET /api/status returns correct counts', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/status' });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.agentFingerprint).toBeDefined();
    expect(body.agentDisplayName).toBe('TestAgent');
    expect(body.peersOnline).toBe(1);
    expect(body.peersTotal).toBe(2);
    // Merged: "Test Group" (local+discovered) + "Public Only" = 2
    expect(body.stateCount).toBe(2);
  });

  it('GET /api/peers returns peer list', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/peers' });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body).toHaveLength(2);

    const online = body.find((p: any) => p.fingerprint === 'peer1fp');
    expect(online).toBeDefined();
    expect(online.online).toBe(true);
    expect(online.displayName).toBe('Peer One');
    expect(online.trusted).toBe(true);
    expect(online.publicKey).toBeUndefined();
    expect(online.public_key).toBeUndefined();

    const offline = body.find((p: any) => p.fingerprint === 'peer2fp');
    expect(offline).toBeDefined();
    expect(offline.online).toBe(false);
  });

  it('GET /api/states merges local and discovered by name', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/states' });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body).toHaveLength(2);

    const merged = body.find((s: any) => s.name === 'Test Group');
    expect(merged).toBeDefined();
    // memberCount should be max of local (3) and discovered (10)
    expect(merged.memberCount).toBe(10);
    expect(merged.isPublic).toBe(true);
    // role should NOT be exposed on public dashboard
    expect(merged.role).toBeUndefined();

    const discoveredOnly = body.find((s: any) => s.name === 'Public Only');
    expect(discoveredOnly).toBeDefined();
    expect(discoveredOnly.memberCount).toBe(5);
    expect(discoveredOnly.isPublic).toBe(true);
  });

  it('does not expose message content', async () => {
    const statesRes = await app.inject({ method: 'GET', url: '/api/states' });
    expect(statesRes.payload).not.toContain('secret content');
  });
});
