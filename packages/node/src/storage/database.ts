import Database from 'better-sqlite3';
import { join } from 'node:path';
import { mkdirSync, existsSync, chmodSync } from 'node:fs';

const SCHEMA_VERSION = 2;

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
];

export class AgentDatabase {
  private db: Database.Database;

  constructor(dataDir: string) {
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    }
    const dbPath = join(dataDir, 'agent.db');
    this.db = new Database(dbPath);
    if (process.platform !== 'win32') {
      chmodSync(dbPath, 0o600);
    }
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
