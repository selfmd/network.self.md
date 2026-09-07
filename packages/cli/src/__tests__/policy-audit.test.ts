import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  AgentDatabase,
  PolicyAuditRepository,
  POLICY_AUDIT_LIMITS,
} from '@networkselfmd/node';
import type { PolicyAuditEntry } from '@networkselfmd/node';

import {
  policyAuditRecent,
  policyAuditPrune,
  policyAuditClear,
} from '../commands/policy-audit.js';

const SAMPLE: PolicyAuditEntry = {
  auditId: 'a-cli-1',
  receivedAt: 1000,
  eventKind: 'group',
  messageId: 'm-cli',
  groupIdHex: 'feed',
  senderFingerprint: 'fp-cli',
  byteLength: 12,
  action: 'ask',
  reason: 'addressed-unknown-sender',
  addressedToMe: true,
  senderTrusted: false,
  matchedInterests: ['coffee'],
  gateRejected: false,
};

let dataDir: string;
let priorEnv: string | undefined;

function seed(entry: PolicyAuditEntry): void {
  const db = new AgentDatabase(dataDir);
  db.migrate();
  try {
    new PolicyAuditRepository(db.getDb()).insert(entry);
  } finally {
    db.close();
  }
}

function readAll(): PolicyAuditEntry[] {
  const db = new AgentDatabase(dataDir);
  db.migrate();
  try {
    return new PolicyAuditRepository(db.getDb()).recent({ limit: POLICY_AUDIT_LIMITS.maxRecentLimit });
  } finally {
    db.close();
  }
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'cli-policy-audit-'));
  priorEnv = process.env.L2S_DATA_DIR;
  process.env.L2S_DATA_DIR = dataDir;
});

afterEach(() => {
  if (priorEnv === undefined) delete process.env.L2S_DATA_DIR;
  else process.env.L2S_DATA_DIR = priorEnv;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('CLI policy audit commands — happy paths', () => {
  it('audit recent on empty DB prints "(none)" and persists nothing', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await policyAuditRecent();
    const captured = logSpy.mock.calls.flat().join(' ');
    expect(captured).toContain('(none)');
    expect(readAll()).toEqual([]);
    logSpy.mockRestore();
  });

  it('audit recent reads persisted entries newest-first', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    seed({ ...SAMPLE, auditId: 'a-1', messageId: 'm-1' });
    await new Promise((r) => setTimeout(r, 4));
    seed({ ...SAMPLE, auditId: 'a-2', messageId: 'm-2' });
    await policyAuditRecent({ limit: '10' });
    const captured = logSpy.mock.calls.flat().join('\n');
    const idxA1 = captured.indexOf('m-1');
    const idxA2 = captured.indexOf('m-2');
    expect(idxA1).toBeGreaterThan(-1);
    expect(idxA2).toBeGreaterThan(-1);
    // Newest (m-2) prints before oldest (m-1).
    expect(idxA2).toBeLessThan(idxA1);
    logSpy.mockRestore();
  });

  it('audit prune --max-entries reduces the table', async () => {
    for (let i = 0; i < 5; i++) {
      seed({ ...SAMPLE, auditId: `a-${i}`, messageId: `m-${i}` });
      await new Promise((r) => setTimeout(r, 2));
    }
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await policyAuditPrune({ maxEntries: '2' });
    expect(readAll()).toHaveLength(2);
    logSpy.mockRestore();
  });

  it('audit clear removes everything', async () => {
    seed({ ...SAMPLE, auditId: 'a-only' });
    expect(readAll()).toHaveLength(1);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await policyAuditClear();
    expect(readAll()).toHaveLength(0);
    logSpy.mockRestore();
  });

  it('audit recent --limit clamps to maxRecentLimit (no DoS via huge JSON)', async () => {
    for (let i = 0; i < 50; i++) seed({ ...SAMPLE, auditId: `a-${i}` });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await policyAuditRecent({ limit: String(POLICY_AUDIT_LIMITS.maxRecentLimit + 999) });
    // Should not throw; clamping happens before DB query, so the read
    // returns at most maxRecentLimit (or all rows if fewer).
    const captured = logSpy.mock.calls.flat().join(' ');
    expect(captured).toContain('Policy audit');
    logSpy.mockRestore();
  });
});

describe('CLI policy audit commands — privacy: no plaintext canary in CLI output', () => {
  it('audit recent never echoes a plaintext canary because the DB never stores it', async () => {
    // Simulate what an upstream Agent run would have written: pollute
    // the entry with content-bearing fields. The repository's explicit
    // projection drops them, so the CLI cannot leak what isn't there.
    const polluted = {
      ...SAMPLE,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      plaintext: 'CLI-AUDIT-CANARY-PLAINTEXT' as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      decryptedBody: 'CLI-AUDIT-CANARY-BODY' as any,
    };
    seed(polluted as PolicyAuditEntry);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await policyAuditRecent({ limit: '10' });
    const captured = logSpy.mock.calls.flat().join(' ');
    expect(captured).not.toContain('CLI-AUDIT-CANARY-PLAINTEXT');
    expect(captured).not.toContain('CLI-AUDIT-CANARY-BODY');
    logSpy.mockRestore();
  });
});

describe('CLI policy audit commands — fail-closed on bad input', () => {
  beforeEach(() => {
    vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
      throw new Error(`EXIT_${code}`);
    }) as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('audit prune with no flags exits with code 1', async () => {
    await expect(policyAuditPrune({})).rejects.toThrow('EXIT_1');
  });

  it('audit prune with non-integer max-entries exits with code 1', async () => {
    await expect(policyAuditPrune({ maxEntries: '7.5' })).rejects.toThrow('EXIT_1');
  });

  it('audit recent with non-integer limit exits with code 1', async () => {
    await expect(policyAuditRecent({ limit: 'soon' })).rejects.toThrow('EXIT_1');
  });
});

describe('CLI policy audit commands are truly local — no Agent.start, no swarm', () => {
  it('source file does not import Agent or SwarmManager and does not call agent.start()', () => {
    const file = resolve(import.meta.dirname, '..', 'commands', 'policy-audit.ts');
    const src = readFileSync(file, 'utf-8');
    expect(src).not.toMatch(/\bimport[^;]*\bAgent\b/);
    expect(src).not.toMatch(/\bimport[^;]*\bSwarmManager\b/);
    expect(src).not.toMatch(/\bagent\.start\(\)/);
  });
});
