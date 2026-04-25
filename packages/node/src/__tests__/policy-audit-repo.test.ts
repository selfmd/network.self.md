import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  AgentDatabase,
  PolicyAuditRepository,
  POLICY_AUDIT_LIMITS,
} from '../storage/index.js';
import type { PolicyAuditEntry } from '@networkselfmd/core';

const SAMPLE: PolicyAuditEntry = {
  auditId: 'a-001',
  receivedAt: 100,
  eventKind: 'group',
  messageId: 'm-1',
  groupIdHex: 'dead',
  senderFingerprint: 'fp-1',
  byteLength: 32,
  action: 'ask',
  reason: 'addressed-unknown-sender',
  addressedToMe: true,
  senderTrusted: false,
  matchedInterests: ['coffee'],
  gateRejected: false,
};

let dir: string;
let db: AgentDatabase;
let repo: PolicyAuditRepository;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nsmd-audit-repo-'));
  db = new AgentDatabase(dir);
  db.migrate();
  repo = new PolicyAuditRepository(db.getDb());
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('Migration v3 — policy_audit schema', () => {
  it('schema_version is 3', () => {
    const row = db
      .getDb()
      .prepare('SELECT version FROM schema_version LIMIT 1')
      .get() as { version: number };
    expect(row.version).toBe(3);
  });

  it('creates policy_audit table and inserted_at index', () => {
    const tables = db
      .getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='policy_audit'")
      .all() as Array<{ name: string }>;
    expect(tables).toHaveLength(1);
    const idx = db
      .getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_policy_audit_inserted_at'")
      .all() as Array<{ name: string }>;
    expect(idx).toHaveLength(1);
  });

  it('column set is exactly the 15 metadata-only fields (privacy invariant)', () => {
    const cols = db
      .getDb()
      .prepare("PRAGMA table_info(policy_audit)")
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual([
      'action',
      'addressed_to_me',
      'allowed',
      'audit_id',
      'byte_length',
      'event_kind',
      'gate_rejected',
      'group_id_hex',
      'inserted_at',
      'matched_interests',
      'message_id',
      'reason',
      'received_at',
      'sender_fingerprint',
      'sender_trusted',
    ]);
    // No column may carry plaintext / content / body / payload / tool args /
    // private-key bytes. Schema-enforced privacy.
    for (const name of names) {
      expect(name).not.toMatch(
        /plaintext|content|body|payload|tool_args|private_key|secret|password|cipher/i,
      );
    }
  });
});

describe('PolicyAuditRepository.insert/recent — round-trip + projection', () => {
  it('round-trips every metadata field', () => {
    repo.insert(SAMPLE);
    const back = repo.recent({ limit: 10 });
    expect(back).toHaveLength(1);
    expect(back[0]).toEqual(SAMPLE);
  });

  it('round-trips an entry with all-null optional fields and gateRejected=true', () => {
    const minimal: PolicyAuditEntry = {
      auditId: 'a-min',
      receivedAt: 1,
      eventKind: 'unknown',
      byteLength: 0,
      action: 'ignore',
      reason: 'malformed-event',
      addressedToMe: false,
      senderTrusted: false,
      matchedInterests: [],
      gateRejected: true,
    };
    repo.insert(minimal);
    const back = repo.recent({ limit: 10 });
    expect(back).toHaveLength(1);
    expect(back[0]).toEqual(minimal);
  });

  it('explicit projection — pollution canaries on the entry are NOT persisted', () => {
    const polluted = {
      ...SAMPLE,
      auditId: 'a-pollute',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      plaintext: 'AUDIT-CANARY-PLAINTEXT' as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      decryptedBody: 'AUDIT-CANARY-BODY' as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      toolArgs: { secret: 'AUDIT-CANARY-TOOL' } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      privateKey: 'AUDIT-CANARY-KEY' as any,
    } as PolicyAuditEntry;
    repo.insert(polluted);
    // Read every column with raw SQLite — none must contain the canaries.
    const rawRow = db
      .getDb()
      .prepare('SELECT * FROM policy_audit WHERE audit_id = ?')
      .get('a-pollute') as Record<string, unknown>;
    const serialized = JSON.stringify(rawRow);
    expect(serialized).not.toContain('AUDIT-CANARY-PLAINTEXT');
    expect(serialized).not.toContain('AUDIT-CANARY-BODY');
    expect(serialized).not.toContain('AUDIT-CANARY-TOOL');
    expect(serialized).not.toContain('AUDIT-CANARY-KEY');
    // The recent() DTO must also omit these.
    const back = repo.recent({ limit: 1 });
    const backJson = JSON.stringify(back);
    expect(backJson).not.toContain('AUDIT-CANARY-PLAINTEXT');
    expect(backJson).not.toContain('AUDIT-CANARY-BODY');
    expect(backJson).not.toContain('AUDIT-CANARY-TOOL');
    expect(backJson).not.toContain('AUDIT-CANARY-KEY');
    expect(back[0]).not.toHaveProperty('plaintext');
    expect(back[0]).not.toHaveProperty('decryptedBody');
    expect(back[0]).not.toHaveProperty('toolArgs');
    expect(back[0]).not.toHaveProperty('privateKey');
  });

  it('writes a derived allowed=1 column when action != ignore && !gateRejected', () => {
    repo.insert(SAMPLE);
    const row = db
      .getDb()
      .prepare('SELECT allowed FROM policy_audit WHERE audit_id = ?')
      .get(SAMPLE.auditId) as { allowed: number };
    expect(row.allowed).toBe(1);

    repo.insert({ ...SAMPLE, auditId: 'a-block', gateRejected: true });
    const row2 = db
      .getDb()
      .prepare('SELECT allowed FROM policy_audit WHERE audit_id = ?')
      .get('a-block') as { allowed: number };
    expect(row2.allowed).toBe(0);

    repo.insert({ ...SAMPLE, auditId: 'a-ignore', action: 'ignore' });
    const row3 = db
      .getDb()
      .prepare('SELECT allowed FROM policy_audit WHERE audit_id = ?')
      .get('a-ignore') as { allowed: number };
    expect(row3.allowed).toBe(0);
  });
});

describe('PolicyAuditRepository.recent — ordering, paging, clamping', () => {
  it('returns newest first', async () => {
    repo.insert({ ...SAMPLE, auditId: 'a-0' });
    await new Promise((r) => setTimeout(r, 5));
    repo.insert({ ...SAMPLE, auditId: 'a-1' });
    await new Promise((r) => setTimeout(r, 5));
    repo.insert({ ...SAMPLE, auditId: 'a-2' });
    expect(repo.recent({ limit: 10 }).map((e) => e.auditId)).toEqual(['a-2', 'a-1', 'a-0']);
  });

  it('clamps limit at POLICY_AUDIT_LIMITS.maxRecentLimit', () => {
    for (let i = 0; i < 20; i++) repo.insert({ ...SAMPLE, auditId: `a-${i}` });
    const r = repo.recent({ limit: POLICY_AUDIT_LIMITS.maxRecentLimit + 999 });
    expect(r.length).toBeLessThanOrEqual(POLICY_AUDIT_LIMITS.maxRecentLimit);
    // 20 < cap, so we still get 20.
    expect(r.length).toBe(20);
  });

  it('rejects bogus limit values gracefully (clamps to >=1)', () => {
    repo.insert(SAMPLE);
    expect(repo.recent({ limit: 0 }).length).toBe(1);
    expect(repo.recent({ limit: -5 }).length).toBe(1);
    expect(repo.recent({ limit: NaN }).length).toBe(1);
  });

  it('paginates backward with `before` (inserted_at exclusive)', async () => {
    const ids: string[] = [];
    const insertedAts: number[] = [];
    for (let i = 0; i < 5; i++) {
      const id = `a-${i}`;
      repo.insert({ ...SAMPLE, auditId: id });
      ids.push(id);
      const row = db
        .getDb()
        .prepare('SELECT inserted_at FROM policy_audit WHERE audit_id = ?')
        .get(id) as { inserted_at: number };
      insertedAts.push(row.inserted_at);
      await new Promise((r) => setTimeout(r, 5));
    }
    // Page back from the third row.
    const earlier = repo.recent({ before: insertedAts[2], limit: 10 });
    expect(earlier.map((e) => e.auditId)).toEqual(['a-1', 'a-0']);
  });
});

describe('PolicyAuditRepository — retention and prune', () => {
  it('prune-on-insert evicts oldest beyond max', async () => {
    const small = new PolicyAuditRepository(db.getDb(), { maxEntries: 3 });
    for (let i = 0; i < 5; i++) {
      small.insert({ ...SAMPLE, auditId: `a-${i}` });
      await new Promise((r) => setTimeout(r, 2));
    }
    const ids = small.recent({ limit: 10 }).map((e) => e.auditId);
    expect(ids).toEqual(['a-4', 'a-3', 'a-2']);
    expect(small.count()).toBe(3);
  });

  it('prune({ olderThanMs }) deletes by age', async () => {
    repo.insert({ ...SAMPLE, auditId: 'old-1' });
    await new Promise((r) => setTimeout(r, 30));
    const cutoff = Date.now();
    await new Promise((r) => setTimeout(r, 5));
    repo.insert({ ...SAMPLE, auditId: 'new-1' });
    const removed = repo.prune({ olderThanMs: Date.now() - cutoff });
    expect(removed).toBeGreaterThanOrEqual(1);
    const ids = repo.recent({ limit: 10 }).map((e) => e.auditId);
    expect(ids).toContain('new-1');
    expect(ids).not.toContain('old-1');
  });

  it('clear() removes all rows', () => {
    for (let i = 0; i < 4; i++) repo.insert({ ...SAMPLE, auditId: `a-${i}` });
    expect(repo.count()).toBe(4);
    repo.clear();
    expect(repo.count()).toBe(0);
    expect(repo.recent()).toEqual([]);
    // After clear, inserts still work.
    repo.insert({ ...SAMPLE, auditId: 'after-clear' });
    expect(repo.count()).toBe(1);
  });

  it('corrupt matched_interests JSON degrades to [] on read; never throws', () => {
    db.getDb()
      .prepare(
        `INSERT INTO policy_audit (
          audit_id, received_at, inserted_at, event_kind, message_id,
          group_id_hex, sender_fingerprint, byte_length, action, reason,
          addressed_to_me, sender_trusted, matched_interests, gate_rejected, allowed
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'corrupt-1',
        1,
        Date.now(),
        'group',
        'm',
        'aa',
        'fp',
        4,
        'ask',
        'interest-hit',
        0,
        0,
        '{not valid json',
        0,
        0,
      );
    expect(() => repo.recent({ limit: 5 })).not.toThrow();
    const back = repo.recent({ limit: 5 });
    expect(back.find((e) => e.auditId === 'corrupt-1')?.matchedInterests).toEqual([]);
  });
});

describe('PolicyAuditRepository — durability', () => {
  it('survives close/reopen on the same dataDir', () => {
    repo.insert({ ...SAMPLE, auditId: 'durable-1' });
    db.close();
    db = new AgentDatabase(dir);
    db.migrate();
    const r = new PolicyAuditRepository(db.getDb());
    const back = r.recent({ limit: 5 });
    expect(back).toHaveLength(1);
    expect(back[0].auditId).toBe('durable-1');
  });
});
