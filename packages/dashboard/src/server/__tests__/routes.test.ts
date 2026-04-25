import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { buildApp } from '../routes.js';
import type { FastifyInstance } from 'fastify';

function seedTestDb(db: Database.Database) {
  // Create schema
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
      joined_at INTEGER
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
    .run(offlinePeerKey, 'peer2fp', null, 0, now - 3600000);

  // Groups + members
  db.prepare('INSERT INTO groups (group_id, name, role, created_at, joined_at) VALUES (?, ?, ?, ?, ?)')
    .run(groupId, 'Test Group', 'admin', now - 86400000, now - 86400000);
  db.prepare('INSERT INTO group_members (group_id, public_key, role) VALUES (?, ?, ?)')
    .run(groupId, onlinePeerKey, 'admin');
  db.prepare('INSERT INTO group_members (group_id, public_key, role) VALUES (?, ?, ?)')
    .run(groupId, offlinePeerKey, 'member');
  db.prepare('INSERT INTO group_members (group_id, public_key, role) VALUES (?, ?, ?)')
    .run(groupId, identityKey, 'admin');

  // Messages
  db.prepare('INSERT INTO messages (id, group_id, sender_public_key, content, timestamp, type) VALUES (?, ?, ?, ?, ?, ?)')
    .run('msg1', groupId, onlinePeerKey, 'This is secret content that should NOT appear in activity', now - 5000, 'message');

  // Discovered groups
  const discoveredGroupId = Buffer.alloc(16, 0xcd);
  db.prepare('INSERT INTO discovered_groups (group_id, name, self_md, member_count, last_announced) VALUES (?, ?, ?, ?, ?)')
    .run(discoveredGroupId, 'Public Group', 'A public group for testing', 5, now - 10000);
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
    expect(body.peersOnline).toBe(1); // peer1 has recent last_seen
    expect(body.peersTotal).toBe(2);
    expect(body.stateCount).toBe(1);
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
    // publicKey should NOT be exposed
    expect(online.publicKey).toBeUndefined();
    expect(online.public_key).toBeUndefined();

    const offline = body.find((p: any) => p.fingerprint === 'peer2fp');
    expect(offline).toBeDefined();
    expect(offline.online).toBe(false);
  });

  it('GET /api/states returns state list', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/states' });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body).toHaveLength(1);

    const group = body[0];
    expect(group.name).toBe('Test Group');
    expect(group.memberCount).toBe(3);
    expect(group.role).toBe('admin');
    expect(typeof group.lastActivity).toBe('number');
  });

  it('GET /api/discovered-states returns discovered states', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/discovered-states' });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body).toHaveLength(1);

    const group = body[0];
    expect(group.name).toBe('Public Group');
    expect(group.selfMd).toBe('A public group for testing');
    expect(group.memberCount).toBe(5);
    expect(typeof group.lastAnnounced).toBe('number');
    expect(group.id).toBeDefined();
  });

  it('GET /api/activity returns metadata WITHOUT message content', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/activity' });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body).toHaveLength(1);

    const activity = body[0];
    expect(activity.type).toBe('message');
    expect(activity.actorName).toBe('Peer One');
    expect(typeof activity.timestamp).toBe('number');

    // Content must NEVER appear
    const raw = res.payload;
    expect(raw).not.toContain('secret content');
    expect(raw).not.toContain('should NOT appear');
    expect(activity.content).toBeUndefined();
  });
});
