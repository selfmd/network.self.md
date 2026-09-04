import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { GroupRepository, DiscoveredGroupRepository, NetworkAnnounceStateRepository } from '../storage/repositories.js';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE groups (
      group_id BLOB PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      created_at INTEGER NOT NULL,
      joined_at INTEGER,
      is_public INTEGER DEFAULT 0,
      self_md TEXT,
      creator_public_key BLOB,
      genesis_hash BLOB
    );
    CREATE TABLE group_members (
      group_id BLOB NOT NULL,
      public_key BLOB NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      PRIMARY KEY (group_id, public_key)
    );
    CREATE TABLE discovered_groups (
      group_id BLOB PRIMARY KEY,
      name TEXT NOT NULL,
      self_md TEXT,
      member_count INTEGER DEFAULT 0,
      announced_by BLOB NOT NULL,
      last_announced INTEGER NOT NULL,
      authority_key BLOB,
      genesis_hash BLOB,
      genesis_epoch_data BLOB,
      genesis_signature BLOB
    );
    CREATE TABLE network_announce_state (
      peer_public_key BLOB PRIMARY KEY,
      last_timestamp INTEGER NOT NULL,
      window_started INTEGER NOT NULL,
      message_count INTEGER NOT NULL
    );
  `);
  return db;
}

describe('DiscoveredGroupRepository', () => {
  let db: Database.Database;
  let repo: DiscoveredGroupRepository;

  beforeEach(() => { db = createTestDb(); repo = new DiscoveredGroupRepository(db); });
  afterEach(() => db.close());

  it('upserts and lists discovered groups', () => {
    const gid = new Uint8Array([1, 2, 3]);
    const peer = new Uint8Array(32).fill(0xaa);
    repo.upsert(gid, 'builders', 'We build things.', 3, peer, new Uint8Array([1]), new Uint8Array(64), new Uint8Array(32));
    const list = repo.list();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('builders');
    expect(list[0].self_md).toBe('We build things.');
    expect(list[0].member_count).toBe(3);
  });

  it('updates on re-announce', () => {
    const gid = new Uint8Array([1, 2, 3]);
    const peer = new Uint8Array(32).fill(0xaa);
    repo.upsert(gid, 'builders', 'v1', 2, peer, new Uint8Array([1]), new Uint8Array(64), new Uint8Array(32));
    repo.upsert(gid, 'builders', 'v2', 5, peer, new Uint8Array([1]), new Uint8Array(64), new Uint8Array(32));
    const list = repo.list();
    expect(list).toHaveLength(1);
    expect(list[0].self_md).toBe('v2');
    expect(list[0].member_count).toBe(5);
  });

  it('finds and removes', () => {
    const gid = new Uint8Array([1, 2, 3]);
    const peer = new Uint8Array(32).fill(0xaa);
    repo.upsert(gid, 'test', 'md', 1, peer, new Uint8Array([1]), new Uint8Array(64), new Uint8Array(32));
    expect(repo.find(gid)).toBeDefined();
    repo.remove(gid);
    expect(repo.find(gid)).toBeUndefined();
  });

  it('rejects a same-group overwrite from another authority', () => {
    const gid = new Uint8Array([1, 2, 3]);
    const owner = new Uint8Array(32).fill(1);
    const attacker = new Uint8Array(32).fill(2);
    expect(repo.upsert(gid, 'owner', '', 1, owner, new Uint8Array([1]), new Uint8Array(64), new Uint8Array(32).fill(1))).toBe(true);
    expect(repo.upsert(gid, 'attacker', '', 1, attacker, new Uint8Array([2]), new Uint8Array(64), new Uint8Array(32).fill(2))).toBe(false);
    expect(repo.find(gid)?.name).toBe('owner');
  });

  it('bounds discovery rows on disk', () => {
    const peer = new Uint8Array(32).fill(1);
    for (let index = 0; index < 1001; index++) {
      const gid = new Uint8Array(32);
      new DataView(gid.buffer).setUint32(28, index, false);
      repo.upsert(gid, `g${index}`, '', 1, peer, new Uint8Array([1]), new Uint8Array(64), new Uint8Array(32));
    }
    expect(repo.list()).toHaveLength(1000);
  });

  it('durably rejects replay and rate limits announcements', () => {
    const state = new NetworkAnnounceStateRepository(db);
    const peer = new Uint8Array(32).fill(3);
    expect(state.accept(peer, 100, 1000, 2)).toBe(true);
    expect(state.accept(peer, 100, 1001, 2)).toBe(false);
    expect(state.accept(peer, 101, 1002, 2)).toBe(true);
    expect(state.accept(peer, 102, 1003, 2)).toBe(false);
    expect(new NetworkAnnounceStateRepository(db).accept(peer, 101, 70_000, 2)).toBe(false);
  });
});

describe('GroupRepository.setPublic', () => {
  let db: Database.Database;
  let repo: GroupRepository;

  beforeEach(() => { db = createTestDb(); repo = new GroupRepository(db); });
  afterEach(() => db.close());

  it('sets group as public with selfMd', () => {
    const gid = new Uint8Array([1, 2, 3]);
    repo.create(gid, 'builders', 'admin');
    repo.setPublic(gid, true, 'We build things.');
    const publics = repo.listPublic();
    expect(publics).toHaveLength(1);
    expect(publics[0].is_public).toBe(1);
    expect(publics[0].self_md).toBe('We build things.');
  });

  it('throws when caller role is member', () => {
    const gid = new Uint8Array([1, 2, 3]);
    repo.join(gid, 'builders', 'member');
    expect(() => repo.setPublic(gid, true, 'Hijacked.')).toThrow(/admin/i);
  });

  it('throws when group does not exist', () => {
    const gid = new Uint8Array([9, 9, 9]);
    expect(() => repo.setPublic(gid, true, 'Ghost.')).toThrow();
  });
});
