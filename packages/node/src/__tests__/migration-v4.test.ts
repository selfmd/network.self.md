import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentDatabase } from '../storage/index.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('schema v4 migration fixture', () => {
  it('adds bounded replay and authenticated bootstrap storage', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nsmd-v4-fixture-'));
    dirs.push(dir);
    mkdirSync(dir, { recursive: true });
    const raw = new Database(join(dir, 'agent.db'));
    raw.exec(`
      CREATE TABLE schema_version (version INTEGER NOT NULL);
      INSERT INTO schema_version VALUES (4);
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
    `);
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
    ).toBe(6);
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
    migrated.close();
  });
});
