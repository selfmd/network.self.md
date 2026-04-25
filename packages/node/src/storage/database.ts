import Database from 'better-sqlite3';
import { join } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';

const SCHEMA_VERSION = 3;

const MIGRATIONS: string[] = [
  // v0 → v1: initial schema
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
  // v1 → v2: owner-local policy config persistence (PR #5).
  // Single-row table (id=1) so we can use INSERT OR REPLACE without
  // touching the schema_version row layout. Lists stored as JSON arrays
  // since SQLite has no array type. NULL columns mean "field unset".
  `
  CREATE TABLE IF NOT EXISTS policy_config (
    id INTEGER PRIMARY KEY,
    trusted_fingerprints TEXT,
    interests TEXT,
    require_mention INTEGER,
    mention_prefix_len INTEGER,
    updated_at INTEGER NOT NULL
  );

  UPDATE schema_version SET version = 2;
  `,
  // v2 → v3: durable, metadata-only audit trail for policy gate
  // decisions (PR #6). Schema mirrors PolicyAuditEntry exactly. The
  // privacy invariant is schema-enforced: there is no column for
  // plaintext / content / body / payload / tool_args / private_key.
  // A test in policy-audit-repo.test.ts pins the column set so any
  // future drift fails loudly. matched_interests is operator-supplied
  // configuration, persisted as a JSON array.
  `
  CREATE TABLE IF NOT EXISTS policy_audit (
    audit_id           TEXT PRIMARY KEY,
    received_at        INTEGER NOT NULL,
    inserted_at        INTEGER NOT NULL,
    event_kind         TEXT NOT NULL,
    message_id         TEXT,
    group_id_hex       TEXT,
    sender_fingerprint TEXT,
    byte_length        INTEGER NOT NULL,
    action             TEXT NOT NULL,
    reason             TEXT NOT NULL,
    addressed_to_me    INTEGER NOT NULL,
    sender_trusted     INTEGER NOT NULL,
    matched_interests  TEXT NOT NULL,
    gate_rejected      INTEGER NOT NULL,
    allowed            INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_policy_audit_inserted_at
    ON policy_audit(inserted_at DESC);

  UPDATE schema_version SET version = 3;
  `,
];

export class AgentDatabase {
  private db: Database.Database;

  constructor(dataDir: string) {
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }
    const dbPath = join(dataDir, 'agent.db');
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
  }

  migrate(): void {
    const currentVersion = this.getSchemaVersion();

    if (currentVersion >= SCHEMA_VERSION) {
      return;
    }

    const transaction = this.db.transaction(() => {
      for (let i = currentVersion; i < SCHEMA_VERSION; i++) {
        this.db.exec(MIGRATIONS[i]);
      }
    });

    transaction();
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

  close(): void {
    this.db.close();
  }
}
