import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  AgentDatabase,
  IdentityRepository,
  PeerRepository,
  GroupRepository,
  MessageRepository,
  SenderKeyRepository,
} from '../storage/index.js';

let dataDir: string;
let database: AgentDatabase;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'nsmd-test-'));
  database = new AgentDatabase(dataDir);
  database.migrate();
});

afterEach(() => {
  database.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('AgentDatabase', () => {
  it('should create database and run migrations', () => {
    const db = database.getDb();
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all() as { name: string }[];
    const tableNames = tables.map((t) => t.name);

    expect(tableNames).toContain('identity');
    expect(tableNames).toContain('peers');
    expect(tableNames).toContain('groups');
    expect(tableNames).toContain('group_members');
    expect(tableNames).toContain('messages');
    expect(tableNames).toContain('sender_keys');
    expect(tableNames).toContain('key_storage');
    expect(tableNames).toContain('schema_version');
  });

  it('should not re-run migrations', () => {
    // Running migrate again should be safe and idempotent.
    database.migrate();
    const db = database.getDb();
    const row = db
      .prepare('SELECT version FROM schema_version')
      .get() as { version: number };
    // Schema version is now 2 (v1 added policy_config table).
    expect(row.version).toBe(2);
  });
});

describe('IdentityRepository', () => {
  it('should save and load identity', () => {
    const repo = new IdentityRepository(database.getDb());
    const privateKey = new Uint8Array(64).fill(1);
    const publicKey = new Uint8Array(32).fill(2);

    repo.save(privateKey, publicKey, 'TestAgent');

    const loaded = repo.load();
    expect(loaded).toBeDefined();
    expect(loaded!.display_name).toBe('TestAgent');
    expect(new Uint8Array(loaded!.ed_public_key)).toEqual(publicKey);
    expect(new Uint8Array(loaded!.ed_private_key)).toEqual(privateKey);
  });

  it('should save and load encrypted keys', () => {
    const repo = new IdentityRepository(database.getDb());
    const salt = new Uint8Array(32).fill(3);
    const nonce = new Uint8Array(24).fill(4);
    const ciphertext = new Uint8Array(96).fill(5);

    repo.saveEncryptedKeys(salt, nonce, ciphertext);

    const loaded = repo.loadEncryptedKeys();
    expect(loaded).toBeDefined();
    expect(new Uint8Array(loaded!.salt)).toEqual(salt);
    expect(new Uint8Array(loaded!.nonce)).toEqual(nonce);
    expect(new Uint8Array(loaded!.ciphertext)).toEqual(ciphertext);
  });
});

describe('PeerRepository', () => {
  let repo: PeerRepository;

  beforeEach(() => {
    repo = new PeerRepository(database.getDb());
  });

  it('should upsert and find a peer', () => {
    const pk = new Uint8Array(32).fill(10);
    repo.upsert(pk, 'abc123', 'PeerOne');

    const found = repo.find(pk);
    expect(found).toBeDefined();
    expect(found!.fingerprint).toBe('abc123');
    expect(found!.display_name).toBe('PeerOne');
    expect(found!.trusted).toBe(0);
  });

  it('should list all peers', () => {
    repo.upsert(new Uint8Array(32).fill(10), 'fp1', 'P1');
    repo.upsert(new Uint8Array(32).fill(20), 'fp2', 'P2');

    const peers = repo.list();
    expect(peers.length).toBe(2);
  });

  it('should trust and untrust a peer', () => {
    const pk = new Uint8Array(32).fill(10);
    repo.upsert(pk, 'abc123');

    repo.trust(pk);
    expect(repo.find(pk)!.trusted).toBe(1);

    repo.untrust(pk);
    expect(repo.find(pk)!.trusted).toBe(0);
  });

  it('should update last_seen on upsert', () => {
    const pk = new Uint8Array(32).fill(10);
    repo.upsert(pk, 'abc123');
    const first = repo.find(pk)!.last_seen!;

    // small delay to ensure different timestamp
    repo.updateLastSeen(pk);
    const updated = repo.find(pk)!.last_seen!;
    expect(updated).toBeGreaterThanOrEqual(first);
  });
});

describe('GroupRepository', () => {
  let repo: GroupRepository;

  beforeEach(() => {
    repo = new GroupRepository(database.getDb());
  });

  it('should create and find a group', () => {
    const gid = new Uint8Array(32).fill(1);
    repo.create(gid, 'Test Group', 'admin');

    const found = repo.find(gid);
    expect(found).toBeDefined();
    expect(found!.name).toBe('Test Group');
    expect(found!.role).toBe('admin');
  });

  it('should list all groups', () => {
    repo.create(new Uint8Array(32).fill(1), 'G1');
    repo.create(new Uint8Array(32).fill(2), 'G2');

    const groups = repo.list();
    expect(groups.length).toBe(2);
  });

  it('should manage members', () => {
    const gid = new Uint8Array(32).fill(1);
    const pk1 = new Uint8Array(32).fill(10);
    const pk2 = new Uint8Array(32).fill(20);

    repo.create(gid, 'G1');
    repo.addMember(gid, pk1, 'admin');
    repo.addMember(gid, pk2, 'member');

    let members = repo.getMembers(gid);
    expect(members.length).toBe(2);

    repo.removeMember(gid, pk2);
    members = repo.getMembers(gid);
    expect(members.length).toBe(1);
  });

  it('should leave group and clean up', () => {
    const gid = new Uint8Array(32).fill(1);
    const pk = new Uint8Array(32).fill(10);

    repo.create(gid, 'G1');
    repo.addMember(gid, pk, 'member');

    repo.leave(gid);

    expect(repo.find(gid)).toBeUndefined();
    expect(repo.getMembers(gid).length).toBe(0);
  });
});

describe('MessageRepository', () => {
  let repo: MessageRepository;

  beforeEach(() => {
    repo = new MessageRepository(database.getDb());
  });

  it('should insert and query messages', () => {
    const gid = new Uint8Array(32).fill(1);
    const pk = new Uint8Array(32).fill(10);

    repo.insert({
      id: 'msg1',
      groupId: gid,
      senderPublicKey: pk,
      content: 'Hello',
      timestamp: Date.now(),
      type: 'group',
    });

    const msgs = repo.query({ groupId: gid });
    expect(msgs.length).toBe(1);
    expect(msgs[0].content).toBe('Hello');
    expect(msgs[0].id).toBe('msg1');
  });

  it('should paginate with before and limit', () => {
    const gid = new Uint8Array(32).fill(1);

    for (let i = 0; i < 10; i++) {
      repo.insert({
        id: `msg${String(i).padStart(3, '0')}`,
        groupId: gid,
        content: `Message ${i}`,
        timestamp: Date.now() + i,
        type: 'group',
      });
    }

    const page1 = repo.query({ groupId: gid, limit: 3 });
    expect(page1.length).toBe(3);

    const page2 = repo.query({
      groupId: gid,
      limit: 3,
      before: page1[page1.length - 1].id,
    });
    expect(page2.length).toBe(3);
  });

  it('should ignore duplicate inserts', () => {
    repo.insert({
      id: 'msg1',
      content: 'First',
      timestamp: Date.now(),
      type: 'group',
    });

    repo.insert({
      id: 'msg1',
      content: 'Duplicate',
      timestamp: Date.now(),
      type: 'group',
    });

    const msgs = repo.query({});
    expect(msgs.length).toBe(1);
    expect(msgs[0].content).toBe('First');
  });
});

describe('SenderKeyRepository', () => {
  let repo: SenderKeyRepository;

  beforeEach(() => {
    repo = new SenderKeyRepository(database.getDb());
  });

  it('should store and load sender keys', () => {
    const gid = new Uint8Array(32).fill(1);
    const pk = new Uint8Array(32).fill(10);
    const chainKey = new Uint8Array(32).fill(99);

    repo.store(gid, pk, chainKey, 0);

    const loaded = repo.load(gid, pk);
    expect(loaded).toBeDefined();
    expect(new Uint8Array(loaded!.chain_key)).toEqual(chainKey);
    expect(loaded!.chain_index).toBe(0);
  });

  it('should update existing sender key', () => {
    const gid = new Uint8Array(32).fill(1);
    const pk = new Uint8Array(32).fill(10);

    repo.store(gid, pk, new Uint8Array(32).fill(1), 0);
    repo.store(gid, pk, new Uint8Array(32).fill(2), 5);

    const loaded = repo.load(gid, pk);
    expect(loaded!.chain_index).toBe(5);
    expect(new Uint8Array(loaded!.chain_key)).toEqual(
      new Uint8Array(32).fill(2),
    );
  });

  it('should delete sender keys', () => {
    const gid = new Uint8Array(32).fill(1);
    const pk = new Uint8Array(32).fill(10);

    repo.store(gid, pk, new Uint8Array(32).fill(1), 0);
    repo.delete(gid, pk);

    expect(repo.load(gid, pk)).toBeUndefined();
  });

  it('should delete all sender keys for a group', () => {
    const gid = new Uint8Array(32).fill(1);

    repo.store(gid, new Uint8Array(32).fill(10), new Uint8Array(32).fill(1), 0);
    repo.store(gid, new Uint8Array(32).fill(20), new Uint8Array(32).fill(2), 0);

    repo.deleteForGroup(gid);

    expect(repo.load(gid, new Uint8Array(32).fill(10))).toBeUndefined();
    expect(repo.load(gid, new Uint8Array(32).fill(20))).toBeUndefined();
  });
});
