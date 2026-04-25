import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentDatabase, PolicyConfigRepository } from '../storage/index.js';
import type { PolicyConfig } from '@networkselfmd/core';

describe('PolicyConfigRepository — persistence + migration v2', () => {
  let dir: string;
  let db: AgentDatabase;
  let repo: PolicyConfigRepository;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nsmd-policy-cfg-'));
    db = new AgentDatabase(dir);
    db.migrate();
    repo = new PolicyConfigRepository(db.getDb());
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('starts empty: load() is undefined and exists() is false', () => {
    expect(repo.load()).toBeUndefined();
    expect(repo.exists()).toBe(false);
  });

  it('round-trips a full config', () => {
    const cfg: PolicyConfig = {
      trustedFingerprints: ['fp1xyz', 'fp2abc'],
      interests: ['coffee', 'deploy'],
      requireMention: true,
      mentionPrefixLen: 8,
    };
    repo.save(cfg);
    expect(repo.exists()).toBe(true);
    const loaded = repo.load();
    expect(loaded).toEqual(cfg);
  });

  it('round-trips a partial config (NULL columns → undefined fields)', () => {
    const cfg: PolicyConfig = { interests: ['only-this'] };
    repo.save(cfg);
    const loaded = repo.load();
    expect(loaded).toEqual({ interests: ['only-this'] });
    expect(loaded).not.toHaveProperty('trustedFingerprints');
    expect(loaded).not.toHaveProperty('requireMention');
    expect(loaded).not.toHaveProperty('mentionPrefixLen');
  });

  it('round-trips requireMention false (distinguishes from unset)', () => {
    repo.save({ requireMention: false });
    expect(repo.load()).toEqual({ requireMention: false });
  });

  it('overwrites on subsequent save (single-row table)', () => {
    repo.save({ trustedFingerprints: ['a'] });
    repo.save({ interests: ['b'] });
    // Second save replaces the row entirely — trusted fp goes back to
    // undefined because the new config didn't include it. Callers that
    // want partial updates should compose at the Agent layer.
    expect(repo.load()).toEqual({ interests: ['b'] });
  });

  it('clear() removes the row', () => {
    repo.save({ interests: ['x'] });
    expect(repo.exists()).toBe(true);
    repo.clear();
    expect(repo.exists()).toBe(false);
    expect(repo.load()).toBeUndefined();
  });

  it('survives database close/reopen (real SQLite roundtrip)', () => {
    repo.save({ trustedFingerprints: ['durable-1'], requireMention: true });
    db.close();
    db = new AgentDatabase(dir);
    db.migrate();
    repo = new PolicyConfigRepository(db.getDb());
    expect(repo.load()).toEqual({
      trustedFingerprints: ['durable-1'],
      requireMention: true,
    });
  });

  it('migration v2 created the policy_config table', () => {
    const tables = db
      .getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='policy_config'")
      .all() as Array<{ name: string }>;
    expect(tables).toHaveLength(1);
  });

  it('schema_version is at the current head (>= 2; PR #6 bumps to 3)', () => {
    const row = db
      .getDb()
      .prepare('SELECT version FROM schema_version LIMIT 1')
      .get() as { version: number };
    expect(row.version).toBeGreaterThanOrEqual(2);
  });

  it('handles a corrupt JSON row gracefully (returns empty array, never throws)', () => {
    db.getDb()
      .prepare(
        `INSERT OR REPLACE INTO policy_config
         (id, trusted_fingerprints, interests, require_mention, mention_prefix_len, updated_at)
         VALUES (1, ?, ?, NULL, NULL, ?)`,
      )
      .run('not-json-at-all', '[broken', Date.now());
    expect(() => repo.load()).not.toThrow();
    const loaded = repo.load();
    expect(loaded).toEqual({ trustedFingerprints: [], interests: [] });
  });

  it('does NOT persist message plaintext / private-key fields (schema check)', () => {
    // Columns of the policy_config table — the privacy invariant is
    // schema-enforced. If anyone later adds a 'plaintext' column, this
    // test fails loudly.
    const cols = db
      .getDb()
      .prepare("PRAGMA table_info(policy_config)")
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual([
      'id',
      'interests',
      'mention_prefix_len',
      'require_mention',
      'trusted_fingerprints',
      'updated_at',
    ]);
    for (const n of names) {
      expect(n).not.toMatch(/plaintext|content|body|private|secret|password/i);
    }
  });
});
