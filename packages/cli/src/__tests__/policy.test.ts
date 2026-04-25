import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentDatabase, PolicyConfigRepository } from '@networkselfmd/node';
import type { PolicyConfig } from '@networkselfmd/node';

import {
  policyGet,
  policySet,
  policyTrustAdd,
  policyTrustRemove,
  policyInterestAdd,
  policyInterestRemove,
} from '../commands/policy.js';

// Read the CLI policy config back through the same repository the
// commands use, in a fresh DB handle. This is what an operator running
// a separate `policy get` would observe.
function readPersisted(dataDir: string): PolicyConfig | undefined {
  const db = new AgentDatabase(dataDir);
  db.migrate();
  try {
    return new PolicyConfigRepository(db.getDb()).load();
  } finally {
    db.close();
  }
}

let dataDir: string;
let priorEnv: string | undefined;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'cli-policy-'));
  priorEnv = process.env.L2S_DATA_DIR;
  process.env.L2S_DATA_DIR = dataDir;
});

afterEach(() => {
  if (priorEnv === undefined) delete process.env.L2S_DATA_DIR;
  else process.env.L2S_DATA_DIR = priorEnv;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('CLI policy commands — happy paths', () => {
  it('policy get on an empty data dir prints defaults and persists nothing', async () => {
    await policyGet();
    expect(readPersisted(dataDir)).toBeUndefined();
  });

  it('policy set --interests / --trusted writes a validated, persisted config', async () => {
    await policySet({ interests: 'coffee, deploy', trusted: 'abcd1234, ef567890' });
    expect(readPersisted(dataDir)).toEqual({
      trustedFingerprints: ['abcd1234', 'ef567890'],
      interests: ['coffee', 'deploy'],
    });
  });

  it('policy set is partial-merge, not replacement', async () => {
    await policySet({ interests: 'a' });
    await policySet({ trusted: 'fp1234ab' });
    expect(readPersisted(dataDir)).toEqual({
      interests: ['a'],
      trustedFingerprints: ['fp1234ab'],
    });
  });

  it('policy set --require-mention parses true/false/yes/no/1/0', async () => {
    for (const truthy of ['true', 'yes', '1']) {
      await policySet({ requireMention: truthy });
      expect(readPersisted(dataDir)?.requireMention).toBe(true);
    }
    for (const falsy of ['false', 'no', '0']) {
      await policySet({ requireMention: falsy });
      expect(readPersisted(dataDir)?.requireMention).toBe(false);
    }
  });

  it('policy set --mention-prefix-len writes an integer', async () => {
    await policySet({ mentionPrefixLen: '12' });
    expect(readPersisted(dataDir)?.mentionPrefixLen).toBe(12);
  });

  it('policy set --reset clears the persisted row', async () => {
    await policySet({ interests: 'x' });
    expect(readPersisted(dataDir)).toEqual({ interests: ['x'] });
    await policySet({ reset: true });
    expect(readPersisted(dataDir)).toBeUndefined();
  });

  it('policy trust add/remove maintain a deduped, lower-cased list', async () => {
    await policyTrustAdd('abcd1234');
    await policyTrustAdd('abcd1234'); // dup → no error, no double entry
    await policyTrustAdd('ef567890');
    expect(readPersisted(dataDir)).toEqual({ trustedFingerprints: ['abcd1234', 'ef567890'] });
    await policyTrustRemove('abcd1234');
    expect(readPersisted(dataDir)).toEqual({ trustedFingerprints: ['ef567890'] });
  });

  it('policy interest add/remove maintain a deduped list', async () => {
    await policyInterestAdd('coffee');
    await policyInterestAdd('coffee');
    await policyInterestAdd('deploy');
    expect(readPersisted(dataDir)).toEqual({ interests: ['coffee', 'deploy'] });
    await policyInterestRemove('coffee');
    expect(readPersisted(dataDir)).toEqual({ interests: ['deploy'] });
  });
});

describe('CLI policy commands — fail-closed on bad input (process.exit + no mutation)', () => {
  beforeEach(() => {
    // Mock process.exit to throw so we can assert and so the test
    // process doesn't actually exit. Cast to never to satisfy the
    // process.exit return-type contract.
    vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
      throw new Error(`EXIT_${code}`);
    }) as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects unparseable --require-mention and does not persist', async () => {
    await expect(policySet({ requireMention: 'sometimes' })).rejects.toThrow('EXIT_1');
    expect(readPersisted(dataDir)).toBeUndefined();
  });

  it('rejects non-integer --mention-prefix-len and does not persist', async () => {
    await expect(policySet({ mentionPrefixLen: '8.5' })).rejects.toThrow('EXIT_1');
    expect(readPersisted(dataDir)).toBeUndefined();
  });

  it('rejects out-of-range --mention-prefix-len and does not mutate previous config', async () => {
    await policySet({ interests: 'kept' });
    await expect(policySet({ mentionPrefixLen: '9999' })).rejects.toThrow('EXIT_1');
    // Previous interest still there; bad attempt did not corrupt the row.
    expect(readPersisted(dataDir)).toEqual({ interests: ['kept'] });
  });

  it('rejects malformed fingerprint shape on trust add and does not persist', async () => {
    await expect(policyTrustAdd('has space')).rejects.toThrow('EXIT_1');
    expect(readPersisted(dataDir)).toBeUndefined();
  });

  it('errors when policy set is called with no flags', async () => {
    await expect(policySet({})).rejects.toThrow('EXIT_1');
    expect(readPersisted(dataDir)).toBeUndefined();
  });
});

describe('CLI policy commands are truly local — they do not start the network', () => {
  // Static check: the policy command source must NOT import Agent /
  // SwarmManager / any network surface. The CLI's local-only promise is
  // partly enforced here at the source level — if a future change adds
  // such an import, this test fails before runtime side-effects can.
  it('source file does not import Agent or SwarmManager', () => {
    const file = resolve(import.meta.dirname, '..', 'commands', 'policy.ts');
    const src = readFileSync(file, 'utf-8');
    expect(src).not.toMatch(/\bimport[^;]*\bAgent\b/);
    expect(src).not.toMatch(/\bimport[^;]*\bSwarmManager\b/);
    expect(src).not.toMatch(/\bagent\.start\(\)/);
  });
});
