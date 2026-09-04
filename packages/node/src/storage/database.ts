import Database from 'better-sqlite3';
import { join } from 'node:path';
import { mkdirSync, existsSync, chmodSync, readFileSync, statSync } from 'node:fs';
import { deserializeEpoch } from '@networkselfmd/core';

const SCHEMA_VERSION = 7;
const REPLAY_TTL_MS = 10 * 60 * 1000;

const MIGRATIONS: string[] = [
  `
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

  CREATE TABLE IF NOT EXISTS sender_keys (
    group_id BLOB NOT NULL,
    public_key BLOB NOT NULL,
    chain_key BLOB NOT NULL,
    chain_index INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (group_id, public_key)
  );

  CREATE TABLE IF NOT EXISTS key_storage (
    id INTEGER PRIMARY KEY,
    salt BLOB NOT NULL,
    nonce BLOB NOT NULL,
    ciphertext BLOB NOT NULL
  );

  CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER NOT NULL
  );

  INSERT INTO schema_version (version) VALUES (1);
  `,
  `
  ALTER TABLE groups ADD COLUMN is_public INTEGER DEFAULT 0;
  ALTER TABLE groups ADD COLUMN self_md TEXT;

  CREATE TABLE IF NOT EXISTS discovered_groups (
    group_id BLOB PRIMARY KEY,
    name TEXT NOT NULL,
    self_md TEXT,
    member_count INTEGER DEFAULT 0,
    announced_by BLOB NOT NULL,
    last_announced INTEGER NOT NULL
  );

  UPDATE schema_version SET version = 2;
  `,
  `
  CREATE TABLE IF NOT EXISTS dm_ratchet_states (
    peer_fingerprint TEXT PRIMARY KEY,
    state_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  UPDATE schema_version SET version = 3;
  `,
  `
  CREATE TABLE IF NOT EXISTS group_epochs (
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

  UPDATE schema_version SET version = 4;
  `,
  `
  -- A v4 database normally contains these v1 tables. Re-declare them here so
  -- an interrupted/partially restored v4 database can still fail forward
  -- through the security migration without losing existing rows.
  CREATE TABLE IF NOT EXISTS identity (
    id INTEGER PRIMARY KEY,
    ed_private_key BLOB NOT NULL,
    ed_public_key BLOB NOT NULL,
    display_name TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sender_keys (
    group_id BLOB NOT NULL,
    public_key BLOB NOT NULL,
    chain_key BLOB NOT NULL,
    chain_index INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (group_id, public_key)
  );

  CREATE TABLE IF NOT EXISTS peers (
    public_key BLOB PRIMARY KEY,
    fingerprint TEXT NOT NULL,
    display_name TEXT,
    trusted INTEGER DEFAULT 0,
    last_seen INTEGER
  );

  CREATE TABLE identity_v5 (
    id INTEGER PRIMARY KEY,
    ed_private_key BLOB,
    ed_public_key BLOB NOT NULL,
    display_name TEXT,
    created_at INTEGER NOT NULL
  );

  INSERT INTO identity_v5 (id, ed_private_key, ed_public_key, display_name, created_at)
    SELECT id, ed_private_key, ed_public_key, display_name, created_at FROM identity;

  DROP TABLE identity;
  ALTER TABLE identity_v5 RENAME TO identity;

  ALTER TABLE groups ADD COLUMN creator_public_key BLOB;
  ALTER TABLE groups ADD COLUMN genesis_hash BLOB;

  ALTER TABLE discovered_groups ADD COLUMN authority_key BLOB;
  ALTER TABLE discovered_groups ADD COLUMN genesis_hash BLOB;
  ALTER TABLE discovered_groups ADD COLUMN genesis_epoch_data BLOB;
  ALTER TABLE discovered_groups ADD COLUMN genesis_signature BLOB;

  -- v2 discovery rows were unauthenticated metadata. Do not let a NULL proof
  -- row pin or block a later verified announcement after this migration.
  DELETE FROM discovered_groups
    WHERE authority_key IS NULL
       OR genesis_hash IS NULL
       OR genesis_epoch_data IS NULL
       OR genesis_signature IS NULL;

  ALTER TABLE sender_keys ADD COLUMN generation_id BLOB;
  ALTER TABLE sender_keys ADD COLUMN distribution_sequence INTEGER NOT NULL DEFAULT -1;
  ALTER TABLE sender_keys ADD COLUMN epoch_version INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE sender_keys ADD COLUMN epoch_hash BLOB;

  CREATE TABLE IF NOT EXISTS group_invites (
    invite_id TEXT PRIMARY KEY,
    group_id BLOB NOT NULL,
    group_name TEXT NOT NULL,
    inviter_public_key BLOB NOT NULL,
    invitee_public_key BLOB NOT NULL,
    genesis_epoch_data BLOB NOT NULL,
    genesis_signature BLOB NOT NULL,
    genesis_hash BLOB NOT NULL,
    direction TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS group_invites_group_id ON group_invites(group_id);

  CREATE TABLE IF NOT EXISTS network_announce_state (
    peer_public_key BLOB PRIMARY KEY,
    last_timestamp INTEGER NOT NULL,
    window_started INTEGER NOT NULL,
    message_count INTEGER NOT NULL
  );

  ALTER TABLE peers ADD COLUMN noise_public_key BLOB;

  CREATE UNIQUE INDEX IF NOT EXISTS peers_noise_public_key
    ON peers(noise_public_key)
    WHERE noise_public_key IS NOT NULL;

  UPDATE schema_version SET version = 5;
  `,
  `
  -- Migration 6 is applied programmatically to reconcile incompatible schema-v5 variants.
  `,
  `
  -- Migration 7 is applied programmatically so legacy epoch CBOR can be
  -- decoded and quarantined in the same transaction as the version update.
  `,
];

export class AgentDatabase {
  private db: Database.Database;
  private readonly dataDir: string;
  private readonly dbPath: string;

  constructor(dataDir: string) {
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    }
    this.dataDir = dataDir;
    this.dbPath = join(dataDir, 'agent.db');
    this.db = new Database(this.dbPath);
    this.enforcePermissions();
    // Ensure key bytes removed by migrations/updates are overwritten rather
    // than retained in SQLite freelist pages.
    this.db.pragma('secure_delete = ON');
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 100');
    this.db.pragma('foreign_keys = ON');
    this.enforcePermissions();
  }

  migrate(): void {
    const currentVersion = this.getSchemaVersion();

    if (currentVersion >= SCHEMA_VERSION) {
      return;
    }

    const transaction = this.db.transaction(() => {
      // Several security branches shipped different schema-v5 layouts. Make
      // every known v5 shape converge before applying the shared v6 schema.
      if (currentVersion === 5) this.reconcileSchemaV5();

      for (let i = currentVersion; i < SCHEMA_VERSION; i++) {
        if (i === 5) {
          this.applyMigrationV6();
        } else if (i === 6) {
          this.applyMigrationV7();
        } else {
          this.db.exec(MIGRATIONS[i]);
        }
      }
    });

    transaction();
    this.enforcePermissions();
  }

  /** Reconcile the independently shipped identity, group, Noise, and replay v5 schemas. */
  private reconcileSchemaV5(): void {
    if (this.columnNotNull('identity', 'ed_private_key')) {
      this.db.exec(`
        CREATE TABLE identity_v5_reconciled (
          id INTEGER PRIMARY KEY,
          ed_private_key BLOB,
          ed_public_key BLOB NOT NULL,
          display_name TEXT,
          created_at INTEGER NOT NULL
        );
        INSERT INTO identity_v5_reconciled
          (id, ed_private_key, ed_public_key, display_name, created_at)
          SELECT id, ed_private_key, ed_public_key, display_name, created_at
          FROM identity;
        DROP TABLE identity;
        ALTER TABLE identity_v5_reconciled RENAME TO identity;
      `);
    }

    this.addColumnIfMissing('groups', 'creator_public_key', 'BLOB');
    this.addColumnIfMissing('groups', 'genesis_hash', 'BLOB');
    this.addColumnIfMissing('discovered_groups', 'authority_key', 'BLOB');
    this.addColumnIfMissing('discovered_groups', 'genesis_hash', 'BLOB');
    this.addColumnIfMissing('discovered_groups', 'genesis_epoch_data', 'BLOB');
    this.addColumnIfMissing('discovered_groups', 'genesis_signature', 'BLOB');
    this.db.exec(`
      DELETE FROM discovered_groups
      WHERE authority_key IS NULL
         OR genesis_hash IS NULL
         OR genesis_epoch_data IS NULL
         OR genesis_signature IS NULL;
    `);

    this.addColumnIfMissing('sender_keys', 'generation_id', 'BLOB');
    this.addColumnIfMissing(
      'sender_keys',
      'distribution_sequence',
      'INTEGER NOT NULL DEFAULT -1',
    );
    this.addColumnIfMissing(
      'sender_keys',
      'epoch_version',
      'INTEGER NOT NULL DEFAULT 0',
    );
    this.addColumnIfMissing('sender_keys', 'epoch_hash', 'BLOB');
    this.addColumnIfMissing('peers', 'noise_public_key', 'BLOB');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS group_invites (
        invite_id TEXT PRIMARY KEY,
        group_id BLOB NOT NULL,
        group_name TEXT NOT NULL,
        inviter_public_key BLOB NOT NULL,
        invitee_public_key BLOB NOT NULL,
        genesis_epoch_data BLOB NOT NULL,
        genesis_signature BLOB NOT NULL,
        genesis_hash BLOB NOT NULL,
        direction TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS group_invites_group_id
        ON group_invites(group_id);
      CREATE TABLE IF NOT EXISTS network_announce_state (
        peer_public_key BLOB PRIMARY KEY,
        last_timestamp INTEGER NOT NULL,
        window_started INTEGER NOT NULL,
        message_count INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS peers_noise_public_key
        ON peers(noise_public_key)
        WHERE noise_public_key IS NOT NULL;
    `);
  }

  private applyMigrationV6(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS group_bootstraps (
        group_id BLOB PRIMARY KEY,
        group_name TEXT NOT NULL,
        inviter_public_key BLOB NOT NULL,
        genesis_epoch_data BLOB NOT NULL,
        genesis_signature BLOB NOT NULL,
        genesis_hash BLOB NOT NULL,
        received_at INTEGER NOT NULL
      );
    `);

    const replayColumns = this.columnNames('protocol_replay');
    if (replayColumns.size === 0) {
      this.createProtocolReplayTable();
    } else if (!replayColumns.has('state') || !replayColumns.has('expires_at')) {
      // The protocol-validation branch shipped this four-column table as v5.
      // Preserve accepted replay IDs while adding the durable reservation state
      // and bounded expiry required by the integrated protocol.
      this.db.exec('ALTER TABLE protocol_replay RENAME TO protocol_replay_v5');
      this.createProtocolReplayTable();
      this.db.prepare(`
        INSERT INTO protocol_replay
          (message_id, sender_fingerprint, message_type, state, received_at, expires_at)
        SELECT message_id, sender_fingerprint, message_type, 'accepted', received_at,
               received_at + ?
        FROM protocol_replay_v5
      `).run(REPLAY_TTL_MS);
      this.db.exec('DROP TABLE protocol_replay_v5');
    }

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS protocol_replay_received_at
        ON protocol_replay(received_at);
      CREATE INDEX IF NOT EXISTS protocol_replay_sender_received_at
        ON protocol_replay(sender_fingerprint, received_at);
      CREATE INDEX IF NOT EXISTS protocol_replay_expires_at
        ON protocol_replay(expires_at);
      UPDATE schema_version SET version = 6;
    `);
  }

  private applyMigrationV7(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS quarantined_group_epochs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        original_id INTEGER NOT NULL,
        group_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        prev_hash BLOB NOT NULL,
        epoch_data BLOB NOT NULL,
        signature BLOB NOT NULL,
        hash BLOB NOT NULL,
        created_by BLOB NOT NULL,
        created_at INTEGER NOT NULL,
        quarantine_reason TEXT NOT NULL,
        quarantined_at INTEGER NOT NULL,
        UNIQUE(group_id, version)
      );
    `);

    const rows = (this.tableExists('group_epochs')
      ? this.db.prepare('SELECT * FROM group_epochs').all()
      : []) as Array<{
      id: number;
      group_id: string;
      version: number;
      prev_hash: Buffer;
      epoch_data: Buffer;
      signature: Buffer;
      hash: Buffer;
      created_by: Buffer;
      created_at: number;
    }>;
    const invalidGroups = new Set<string>();
    for (const row of rows) {
      try {
        deserializeEpoch(new Uint8Array(row.epoch_data));
      } catch {
        invalidGroups.add(row.group_id);
      }
    }

    const quarantine = this.db.prepare(`
      INSERT OR REPLACE INTO quarantined_group_epochs
        (original_id, group_id, version, prev_hash, epoch_data, signature, hash,
         created_by, created_at, quarantine_reason, quarantined_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const remove = this.tableExists('group_epochs')
      ? this.db.prepare('DELETE FROM group_epochs WHERE id = ?')
      : null;
    const quarantinedAt = Date.now();

    for (const row of rows) {
      if (invalidGroups.has(row.group_id)) {
        quarantine.run(
          row.id,
          row.group_id,
          row.version,
          row.prev_hash,
          row.epoch_data,
          row.signature,
          row.hash,
          row.created_by,
          row.created_at,
          'unsupported-or-invalid-epoch-format',
          quarantinedAt,
        );
        remove!.run(row.id);
      }
    }

    if (invalidGroups.size > 0) {
      const clearAuthority = this.db.prepare(`
        UPDATE groups SET creator_public_key = NULL, genesis_hash = NULL
        WHERE group_id = ?
      `);
      const clearMembers = this.tableExists('group_members')
        ? this.db.prepare('DELETE FROM group_members WHERE group_id = ?')
        : null;
      const clearSenderKeys = this.tableExists('sender_keys')
        ? this.db.prepare('DELETE FROM sender_keys WHERE group_id = ?')
        : null;
      for (const groupId of invalidGroups) {
        if (/^[0-9a-fA-F]{64}$/.test(groupId)) {
          const groupIdBytes = Buffer.from(groupId, 'hex');
          clearAuthority.run(groupIdBytes);
          clearMembers?.run(groupIdBytes);
          clearSenderKeys?.run(groupIdBytes);
        }
      }
    }

    this.db.exec('UPDATE schema_version SET version = 7');
  }

  private createProtocolReplayTable(): void {
    this.db.exec(`
      CREATE TABLE protocol_replay (
        message_id BLOB PRIMARY KEY,
        sender_fingerprint TEXT NOT NULL,
        message_type INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('reserved', 'accepted')),
        received_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `);
  }

  private columnNames(table: string): Set<string> {
    if (!this.tableExists(table)) return new Set();
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
    }>;
    return new Set(rows.map((row) => row.name));
  }

  private columnNotNull(table: string, column: string): boolean {
    if (!this.tableExists(table)) return false;
    const row = this.db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .find((candidate) => (candidate as { name: string }).name === column) as
      | { notnull: number }
      | undefined;
    return row?.notnull === 1;
  }

  private addColumnIfMissing(table: string, column: string, definition: string): void {
    if (!this.columnNames(table).has(column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  private tableExists(table: string): boolean {
    return this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table) !== undefined;
  }

  private getSchemaVersion(): number {
    try {
      const row = this.db
        .prepare('SELECT version FROM schema_version LIMIT 1')
        .get() as { version: number } | undefined;
      return row?.version ?? 0;
    } catch {
      return 0;
    }
  }

  getDb(): Database.Database {
    return this.db;
  }

  async erasePlaintextSnapshots(
    sensitiveBytes: Uint8Array,
    forceCheckpoint = false,
  ): Promise<void> {
    const secret = Buffer.from(sensitiveBytes);
    const containsSecret = () => this.databaseFiles().some((path) => {
      try {
        return readFileSync(path).includes(secret);
      } catch {
        return false;
      }
    });

    if (!forceCheckpoint && !containsSecret()) {
      this.enforcePermissions();
      return;
    }

    const attempts = 4;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const [result] = this.db.pragma('wal_checkpoint(TRUNCATE)') as Array<{
        busy: number;
        log: number;
        checkpointed: number;
      }>;
      this.enforcePermissions();

      const walPath = `${this.dbPath}-wal`;
      const walEmpty = !existsSync(walPath) || statSync(walPath).size === 0;
      if (result?.busy === 0 && result.log === 0 && walEmpty && !containsSecret()) {
        return;
      }

      if (attempt + 1 < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
      }
    }

    throw new Error('Unable to securely remove the plaintext identity snapshot');
  }

  enforcePermissions(): void {
    if (process.platform === 'win32') return;

    chmodSync(this.dataDir, 0o700);
    for (const path of this.databaseFiles()) {
      if (existsSync(path)) chmodSync(path, 0o600);
    }
  }

  private databaseFiles(): string[] {
    return [this.dbPath, `${this.dbPath}-wal`, `${this.dbPath}-shm`];
  }

  close(): void {
    this.db.close();
  }
}
