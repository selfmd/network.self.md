import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Encoder } from 'cbor-x';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createGenesisEpoch,
  createSignedEpoch,
  generateIdentity,
  hashEpoch,
  sign,
} from '@networkselfmd/core';
import {
  AgentDatabase,
  GroupBootstrapRepository,
  GroupEpochRepository,
  GroupInviteRepository,
  GroupRepository,
  MessageRepository,
  PeerRepository,
  ProtocolReplayRepository,
  SenderKeyRepository,
} from '../storage/index.js';
import { GroupManager } from '../groups/group-manager.js';
import type { SwarmManager } from '../network/swarm.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('schema v4 migration fixture', () => {
  it('adds bounded replay and quarantines legacy timestamp epochs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nsmd-v4-fixture-'));
    dirs.push(dir);
    mkdirSync(dir, { recursive: true });
    const raw = new Database(join(dir, 'agent.db'));
    createLegacySchema(raw, 4);
    const identity = generateIdentity();
    const groupId = new Uint8Array(32).fill(0xab);
    const groupIdHex = Buffer.from(groupId).toString('hex');
    const epochData = legacyEpochData(groupIdHex, identity.edPublicKey, 1234);
    raw.prepare(`
      INSERT INTO groups
        (group_id, name, role, created_at, joined_at, is_public, self_md)
      VALUES (?, 'legacy', 'admin', 1234, 1234, 0, NULL)
    `).run(Buffer.from(groupId));
    raw.prepare(`
      INSERT INTO group_epochs
        (group_id, version, prev_hash, epoch_data, signature, hash, created_by, created_at)
      VALUES (?, 0, ?, ?, ?, ?, ?, 1234)
    `).run(
      groupIdHex,
      Buffer.alloc(32),
      epochData,
      Buffer.from(sign(epochData, identity.edPrivateKey)),
      Buffer.from(hashEpoch(epochData)),
      Buffer.from(identity.edPublicKey),
    );
    raw.close();

    const migrated = new AgentDatabase(dir);
    migrated.migrate();
    const db = migrated.getDb();
    expect(
      (
        db.prepare('SELECT version FROM schema_version').get() as {
          version: number;
        }
      ).version,
    ).toBe(9);
    const replayColumns = db
      .prepare('PRAGMA table_info(protocol_replay)')
      .all() as Array<{ name: string }>;
    expect(replayColumns.map((column) => column.name)).toEqual(
      expect.arrayContaining(['state', 'received_at', 'expires_at']),
    );
    const groupColumns = db
      .prepare('PRAGMA table_info(groups)')
      .all() as Array<{
      name: string;
    }>;
    expect(groupColumns.map((column) => column.name)).toEqual(
      expect.arrayContaining(['creator_public_key', 'genesis_hash']),
    );
    const bootstrapTable = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'group_bootstraps'",
      )
      .get();
    expect(bootstrapTable).toBeDefined();
    expect(new GroupEpochRepository(db).getEpochByVersion(groupIdHex, 0)).toBeNull();
    expect(
      db.prepare(
        'SELECT group_id, version, quarantine_reason FROM quarantined_group_epochs',
      ).get(),
    ).toEqual({
      group_id: groupIdHex,
      version: 0,
      quarantine_reason: 'unsupported-or-invalid-epoch-format',
    });
    const group = db.prepare(
      'SELECT creator_public_key, genesis_hash FROM groups WHERE group_id = ?',
    ).get(Buffer.from(groupId)) as {
      creator_public_key: Buffer | null;
      genesis_hash: Buffer | null;
    };
    expect(group.creator_public_key).toBeNull();
    expect(group.genesis_hash).toBeNull();
    const joinSwarm = vi.fn(async () => {});
    const migratedGroups = new GroupRepository(db);
    const manager = new GroupManager({
      identity: generateIdentity(),
      swarm: { join: joinSwarm } as unknown as SwarmManager,
      groups: migratedGroups,
      messages: new MessageRepository(db),
      senderKeys: new SenderKeyRepository(db),
      peers: new PeerRepository(db),
      epochs: new GroupEpochRepository(db),
      invites: new GroupInviteRepository(db),
      replay: new ProtocolReplayRepository(db),
      bootstraps: new GroupBootstrapRepository(db),
    });
    await expect(manager.rejoinAllGroups()).resolves.toBeUndefined();
    expect(joinSwarm).not.toHaveBeenCalled();
    migrated.close();
  });
});

describe('schema v5 migration variants', () => {
  it('reconciles the protocol replay v5 schema and preserves accepted rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nsmd-v5-replay-fixture-'));
    dirs.push(dir);
    const raw = new Database(join(dir, 'agent.db'));
    createLegacySchema(raw, 5);
    raw.exec(`
      CREATE TABLE protocol_replay (
        message_id BLOB PRIMARY KEY,
        sender_fingerprint TEXT NOT NULL,
        message_type INTEGER NOT NULL,
        received_at INTEGER NOT NULL
      );
      CREATE INDEX protocol_replay_received_at
        ON protocol_replay(received_at);
    `);
    raw.prepare(`
      INSERT INTO protocol_replay
        (message_id, sender_fingerprint, message_type, received_at)
      VALUES (?, 'legacy-sender', 4, 1234)
    `).run(Buffer.from([1, 2, 3]));
    raw.close();

    const migrated = new AgentDatabase(dir);
    migrated.migrate();
    const db = migrated.getDb();
    expect(
      db.prepare('SELECT version FROM schema_version').get(),
    ).toEqual({ version: 9 });
    expect(
      db.prepare(`
        SELECT sender_fingerprint, message_type, state, received_at, expires_at
        FROM protocol_replay WHERE message_id = ?
      `).get(Buffer.from([1, 2, 3])),
    ).toEqual({
      sender_fingerprint: 'legacy-sender',
      message_type: 4,
      state: 'accepted',
      received_at: 1234,
      expires_at: 601234,
    });

    expect(columnNames(db, 'identity')).toContain('ed_private_key');
    expect(
      (db.prepare(`PRAGMA table_info('identity')`).all() as Array<{
        name: string;
        notnull: number;
      }>).find((column) => column.name === 'ed_private_key')?.notnull,
    ).toBe(0);
    expect(columnNames(db, 'groups')).toEqual(
      expect.arrayContaining(['creator_public_key', 'genesis_hash']),
    );
    expect(columnNames(db, 'sender_keys')).toEqual(
      expect.arrayContaining([
        'generation_id',
        'distribution_sequence',
        'epoch_version',
        'epoch_hash',
      ]),
    );
    expect(columnNames(db, 'peers')).toContain('noise_public_key');
    migrated.close();
  });
});

describe('schema v6 epoch migration', () => {
  it('keeps canonical v2 epoch chains active', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nsmd-v6-epoch-fixture-'));
    dirs.push(dir);
    const initial = new AgentDatabase(dir);
    initial.migrate();
    const identity = generateIdentity();
    const groupId = new Uint8Array(32).fill(0xcd);
    const groupIdHex = Buffer.from(groupId).toString('hex');
    const genesis = createSignedEpoch(
      createGenesisEpoch(groupIdHex, identity.edPublicKey, 2345),
      identity.edPrivateKey,
    );
    new GroupEpochRepository(initial.getDb()).saveEpoch(genesis);
    initial.getDb().prepare('UPDATE schema_version SET version = 6').run();
    initial.close();

    const migrated = new AgentDatabase(dir);
    migrated.migrate();
    expect(
      new GroupEpochRepository(migrated.getDb()).getEpochByVersion(groupIdHex, 0),
    ).toEqual(genesis);
    expect(
      migrated.getDb().prepare(
        'SELECT COUNT(*) AS count FROM quarantined_group_epochs',
      ).get(),
    ).toEqual({ count: 0 });
    migrated.close();
  });
});

function createLegacySchema(db: Database.Database, version: 4 | 5): void {
  db.exec(`
    CREATE TABLE identity (
      id INTEGER PRIMARY KEY,
      ed_private_key BLOB NOT NULL,
      ed_public_key BLOB NOT NULL,
      display_name TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE peers (
      public_key BLOB PRIMARY KEY,
      fingerprint TEXT NOT NULL,
      display_name TEXT,
      trusted INTEGER DEFAULT 0,
      last_seen INTEGER
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
    CREATE TABLE group_members (
      group_id BLOB NOT NULL,
      public_key BLOB NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      PRIMARY KEY (group_id, public_key)
    );
    CREATE TABLE group_epochs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      prev_hash BLOB NOT NULL,
      epoch_data BLOB NOT NULL,
      signature BLOB NOT NULL,
      hash BLOB NOT NULL,
      created_by BLOB NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(group_id, version)
    );
    CREATE TABLE schema_version (version INTEGER NOT NULL);
    INSERT INTO schema_version VALUES (${version});
  `);
}

function legacyEpochData(
  groupId: string,
  publicKey: Uint8Array,
  timestamp: number,
): Uint8Array {
  return new Encoder({ useRecords: false }).encode({
    version: 0,
    prevHash: new Uint8Array(32),
    groupId,
    members: [{ publicKey, role: 'admin' }],
    timestamp,
    createdBy: publicKey,
  });
}

function columnNames(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (column) => column.name,
  );
}
