import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { GroupRepository, DiscoveredGroupRepository } from '../storage/repositories.js';

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
      self_md TEXT
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
      last_announced INTEGER NOT NULL
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
    repo.upsert(gid, 'builders', 'We build things.', 3, peer);
    const list = repo.list();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('builders');
    expect(list[0].self_md).toBe('We build things.');
    expect(list[0].member_count).toBe(3);
  });

  it('updates on re-announce', () => {
    const gid = new Uint8Array([1, 2, 3]);
    const peer = new Uint8Array(32).fill(0xaa);
    repo.upsert(gid, 'builders', 'v1', 2, peer);
    repo.upsert(gid, 'builders', 'v2', 5, peer);
    const list = repo.list();
    expect(list).toHaveLength(1);
    expect(list[0].self_md).toBe('v2');
    expect(list[0].member_count).toBe(5);
  });

  it('finds and removes', () => {
    const gid = new Uint8Array([1, 2, 3]);
    const peer = new Uint8Array(32).fill(0xaa);
    repo.upsert(gid, 'test', 'md', 1, peer);
    expect(repo.find(gid)).toBeDefined();
    repo.remove(gid);
    expect(repo.find(gid)).toBeUndefined();
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
});
