import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
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
  it.skipIf(process.platform === 'win32')('should enforce private permissions on the directory and SQLite files', () => {
    chmodSync(dataDir, 0o777);
    database.migrate();
    database.getDb().prepare('INSERT INTO peers (public_key, fingerprint) VALUES (?, ?)')
      .run(Buffer.alloc(32), 'permissions-test');
    database.enforcePermissions();

    expect(statSync(dataDir).mode & 0o777).toBe(0o700);
    for (const suffix of ['', '-wal', '-shm']) {
      const path = join(dataDir, `agent.db${suffix}`);
      expect(existsSync(path)).toBe(true);
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
  });
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
    expect(tableNames).toContain('group_epochs');
  });

  it('should not re-run migrations', () => {
    // Running migrate again should be safe
    database.migrate();
    const db = database.getDb();
    const row = db
      .prepare('SELECT version FROM schema_version')
      .get() as { version: number };
    expect(row.version).toBe(8);
  });

  it('should migrate a populated v4 identity to the nullable encrypted-only schema', () => {
    const legacyDir = mkdtempSync(join(tmpdir(), 'nsmd-v4-test-'));
    const legacyDb = new Database(join(legacyDir, 'agent.db'));
    legacyDb.exec(`
      CREATE TABLE identity (
        id INTEGER PRIMARY KEY,
        ed_private_key BLOB NOT NULL,
        ed_public_key BLOB NOT NULL,
        display_name TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE groups (
        group_id BLOB PRIMARY KEY,
        name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member',
        created_at INTEGER NOT NULL,
        joined_at INTEGER,
        is_public INTEGER DEFAULT 0,
        self_md TEXT
      );
      CREATE TABLE discovered_groups (
        group_id BLOB PRIMARY KEY,
        name TEXT NOT NULL,
        self_md TEXT,
        member_count INTEGER DEFAULT 0,
        announced_by BLOB NOT NULL,
        last_announced INTEGER NOT NULL
      );
      CREATE TABLE sender_keys (
        group_id BLOB NOT NULL,
        public_key BLOB NOT NULL,
        chain_key BLOB NOT NULL,
        chain_index INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (group_id, public_key)
      );
      CREATE TABLE peers (
        public_key BLOB PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        display_name TEXT,
        trusted INTEGER DEFAULT 0,
        last_seen INTEGER
      );
      CREATE TABLE schema_version (version INTEGER NOT NULL);
      INSERT INTO schema_version (version) VALUES (4);
    `);
    legacyDb.prepare(
      `INSERT INTO identity (id, ed_private_key, ed_public_key, display_name, created_at)
       VALUES (1, ?, ?, 'LegacyAgent', 1234)`,
    ).run(Buffer.alloc(32, 1), Buffer.alloc(32, 2));
    legacyDb.prepare(
      `INSERT INTO discovered_groups
        (group_id, name, self_md, member_count, announced_by, last_announced)
       VALUES (?, 'Unauthenticated cache', NULL, 1, ?, 1234)`,
    ).run(Buffer.alloc(32, 3), Buffer.alloc(32, 4));
    legacyDb.close();

    const migrated = new AgentDatabase(legacyDir);
    migrated.migrate();
    const migratedDb = migrated.getDb();
    const row = migratedDb.prepare('SELECT * FROM identity WHERE id = 1').get() as {
      ed_private_key: Buffer;
      display_name: string;
    };
    const privateKeyColumn = migratedDb
      .prepare(`PRAGMA table_info('identity')`)
      .all()
      .find((column) => (column as { name: string }).name === 'ed_private_key') as {
      notnull: number;
    };

    expect(row.ed_private_key).toEqual(Buffer.alloc(32, 1));
    expect(row.display_name).toBe('LegacyAgent');
    expect(privateKeyColumn.notnull).toBe(0);
    expect(
      migratedDb
        .prepare('SELECT COUNT(*) AS count FROM discovered_groups')
        .get(),
    ).toEqual({ count: 0 });
    migrated.close();
    rmSync(legacyDir, { recursive: true, force: true });
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
    expect(new Uint8Array(loaded!.ed_private_key!)).toEqual(privateKey);
  });

  it('should atomically store an encrypted-only identity', () => {
    const repo = new IdentityRepository(database.getDb());
    const publicKey = new Uint8Array(32).fill(2);
    const salt = new Uint8Array(32).fill(3);
    const nonce = new Uint8Array(24).fill(4);
    const ciphertext = new Uint8Array(48).fill(5);

    repo.saveEncrypted(publicKey, 'EncryptedAgent', salt, nonce, ciphertext);

    const identity = repo.load();
    const encrypted = repo.loadEncryptedKeys();
    expect(identity!.ed_private_key).toBeNull();
    expect(new Uint8Array(identity!.ed_public_key)).toEqual(publicKey);
    expect(new Uint8Array(encrypted!.ciphertext)).toEqual(ciphertext);
  });

  it('should write ciphertext before clearing a migrated plaintext key', () => {
    const repo = new IdentityRepository(database.getDb());
    const privateKey = new Uint8Array(32).fill(1);
    const publicKey = new Uint8Array(32).fill(2);
    const salt = new Uint8Array(32).fill(3);
    const nonce = new Uint8Array(24).fill(4);
    const ciphertext = new Uint8Array(48).fill(5);
    repo.save(privateKey, publicKey, 'MigratedAgent');

    repo.migrateToEncrypted(salt, nonce, ciphertext);

    expect(repo.load()!.ed_private_key).toBeNull();
    expect(new Uint8Array(repo.loadEncryptedKeys()!.ciphertext)).toEqual(ciphertext);
  });

  it('should retain the plaintext key if encrypted storage cannot be written', () => {
    const repo = new IdentityRepository(database.getDb());
    const privateKey = new Uint8Array(32).fill(1);
    const publicKey = new Uint8Array(32).fill(2);
    repo.save(privateKey, publicKey, 'RollbackAgent');
    database.getDb().exec(`
      CREATE TRIGGER reject_encrypted_key
      BEFORE INSERT ON key_storage
      BEGIN
        SELECT RAISE(ABORT, 'simulated encrypted storage failure');
      END;
    `);

    expect(() =>
      repo.migrateToEncrypted(
        new Uint8Array(32).fill(3),
        new Uint8Array(24).fill(4),
        new Uint8Array(48).fill(5),
      ),
    ).toThrow('simulated encrypted storage failure');

    expect(new Uint8Array(repo.load()!.ed_private_key!)).toEqual(privateKey);
    expect(repo.loadEncryptedKeys()).toBeUndefined();
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

  it('pins the Ed25519 identity to its first observed Noise transport key', () => {
    const publicKey = new Uint8Array(32).fill(10);
    const noisePublicKey = new Uint8Array(32).fill(20);

    repo.pinTransportIdentity(publicKey, 'abc123', noisePublicKey, 'Old name');
    repo.pinTransportIdentity(publicKey, 'abc123', noisePublicKey, 'New name');

    const found = repo.find(publicKey)!;
    expect(new Uint8Array(found.noise_public_key!)).toEqual(noisePublicKey);
    expect(found.display_name).toBe('New name');
  });

  it('rejects a changed Noise key without treating a display-name update as a key change', () => {
    const publicKey = new Uint8Array(32).fill(10);
    repo.pinTransportIdentity(
      publicKey,
      'abc123',
      new Uint8Array(32).fill(20),
      'Old name',
    );

    expect(() =>
      repo.pinTransportIdentity(
        publicKey,
        'abc123',
        new Uint8Array(32).fill(21),
        'New name',
      ),
    ).toThrow(/transport key changed/i);
    expect(repo.find(publicKey)!.display_name).toBe('Old name');
  });

  it('rejects substituting another identity onto a pinned Noise key', () => {
    const noisePublicKey = new Uint8Array(32).fill(20);
    repo.pinTransportIdentity(
      new Uint8Array(32).fill(10),
      'identity-1',
      noisePublicKey,
    );

    expect(() =>
      repo.pinTransportIdentity(
        new Uint8Array(32).fill(11),
        'identity-2',
        noisePublicKey,
      ),
    ).toThrow(/different identity/i);
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

  it('atomically pins an unpinned legacy group and accepts only the exact authority afterwards', () => {
    const gid = new Uint8Array(32).fill(3);
    const creator = new Uint8Array(32).fill(4);
    const genesisHash = new Uint8Array(32).fill(5);
    repo.create(gid, 'Legacy', 'member');

    repo.join(gid, 'Verified', 'member', creator, genesisHash);
    const pinned = repo.find(gid)!;
    expect(new Uint8Array(pinned.creator_public_key!)).toEqual(creator);
    expect(new Uint8Array(pinned.genesis_hash!)).toEqual(genesisHash);

    repo.join(gid, 'Verified again', 'member', creator, genesisHash);

    expect(() =>
      repo.join(
        gid,
        'Attacker',
        'member',
        new Uint8Array(32).fill(6),
        genesisHash,
      ),
    ).toThrow(/authority mismatch/i);
    expect(repo.find(gid)!.name).toBe('Verified again');
  });

  it('rejects partial and missing authority updates for an already pinned group', () => {
    const gid = new Uint8Array(32).fill(7);
    const creator = new Uint8Array(32).fill(8);
    const genesisHash = new Uint8Array(32).fill(9);
    repo.create(gid, 'Pinned', 'member', creator, genesisHash);

    expect(() => repo.join(gid, 'No proof', 'member')).toThrow(
      /authority mismatch/i,
    );
    expect(() => repo.join(gid, 'Partial', 'member', creator)).toThrow(
      /both creator key and genesis hash/i,
    );
    expect(repo.find(gid)!.name).toBe('Pinned');
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

  it('keeps group messages and other conversations out of direct history', () => {
    const peer = new Uint8Array(32).fill(1);
    const local = new Uint8Array(32).fill(2);
    const other = new Uint8Array(32).fill(3);
    const entries = [
      { id: 'incoming', senderPublicKey: peer, peerPublicKey: local, type: 'direct' },
      { id: 'outgoing', senderPublicKey: local, peerPublicKey: peer, type: 'direct' },
      { id: 'group', senderPublicKey: peer, groupId: new Uint8Array(32).fill(4), type: 'group' },
      { id: 'other', senderPublicKey: other, peerPublicKey: local, type: 'direct' },
    ];
    for (const entry of entries) repo.insert({ ...entry, content: entry.id, timestamp: 100 });
    expect(repo.query({ peerPublicKey: peer }).map((message) => message.id).sort()).toEqual(['incoming', 'outgoing']);
  });

  it('paginates random message IDs by timestamp with a stable tie breaker', () => {
    const groupId = new Uint8Array(32).fill(1);
    const entries = [
      { id: 'a-newest', timestamp: 300 },
      { id: 'z-middle', timestamp: 200 },
      { id: 'm-middle', timestamp: 200 },
      { id: 'y-oldest', timestamp: 100 },
    ];
    for (const entry of entries) repo.insert({ ...entry, groupId, content: entry.id, type: 'group' });
    const ids: string[] = [];
    let before: string | undefined;
    for (let page = 0; page < 5; page++) {
      const messages = repo.query({ groupId, before, limit: 1 });
      if (!messages.length) break;
      ids.push(messages[0].id);
      before = messages[0].id;
    }
    expect(ids).toEqual(entries.map((entry) => entry.id));
    expect(repo.query({ groupId, before: 'missing-cursor' })).toEqual([]);
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

  it('backfills sender sequence replay floors from existing v7 key records', () => {
    const groupId = new Uint8Array(32).fill(1);
    const publicKey = new Uint8Array(32).fill(2);
    repo.store(groupId, publicKey, new Uint8Array(32).fill(3), 4, new Uint8Array(16).fill(5), 23);
    database.getDb().exec('DROP TABLE sender_key_sequences; UPDATE schema_version SET version = 7;');
    database.migrate();
    expect(repo.getDistributionSequence(groupId, publicKey)).toBe(23);
    expect(repo.load(groupId, publicKey)!.chain_index).toBe(4);
    repo.delete(groupId, publicKey);
    expect(repo.getDistributionSequence(groupId, publicKey)).toBe(23);
    expect(repo.load(groupId, publicKey)).toBeUndefined();
  });

  it('retains only the distribution replay floor after deletion and restart', () => {
    const groupId = new Uint8Array(32).fill(1);
    const publicKey = new Uint8Array(32).fill(2);
    const oldKey = new Uint8Array(32).fill(3);
    const oldGeneration = new Uint8Array(16).fill(4);
    const epochHash = new Uint8Array(32).fill(5);
    repo.store(groupId, publicKey, oldKey, 0, oldGeneration, 17, 1, epochHash);
    repo.deleteForGroup(groupId);
    expect(repo.load(groupId, publicKey)).toBeUndefined();
    database.close();
    database = new AgentDatabase(dataDir);
    database.migrate();
    repo = new SenderKeyRepository(database.getDb());
    expect(repo.getDistributionSequence(groupId, publicKey)).toBe(17);
    expect(repo.storeIfNewer(groupId, publicKey, oldKey, 0, oldGeneration, 17, 1, epochHash)).toBe(false);
    expect(repo.load(groupId, publicKey)).toBeUndefined();
    repo.store(groupId, publicKey, new Uint8Array(32).fill(6), 0, new Uint8Array(16).fill(7));
    expect(repo.load(groupId, publicKey)!.distribution_sequence).toBe(17);
    expect(repo.storeIfNewer(groupId, publicKey, new Uint8Array(32).fill(8), 0, new Uint8Array(16).fill(9), 18, 1, epochHash)).toBe(true);
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

  it('durably rejects replayed or rolled-back distributions', () => {
    const gid = new Uint8Array(32).fill(4);
    const pk = new Uint8Array(32).fill(5);
    const generation = new Uint8Array(16).fill(6);
    const epochHash = new Uint8Array(32).fill(7);
    expect(repo.storeIfNewer(gid, pk, new Uint8Array(32).fill(1), 10, generation, 8, 3, epochHash)).toBe(true);
    const reopened = new SenderKeyRepository(database.getDb());
    expect(reopened.storeIfNewer(gid, pk, new Uint8Array(32).fill(2), 10, generation, 8, 3, epochHash)).toBe(false);
    expect(reopened.storeIfNewer(gid, pk, new Uint8Array(32).fill(3), 9, generation, 9, 3, epochHash)).toBe(false);
    expect(new Uint8Array(reopened.load(gid, pk)!.chain_key)).toEqual(new Uint8Array(32).fill(1));
  });
});
