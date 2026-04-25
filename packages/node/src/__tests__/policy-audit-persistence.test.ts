import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PrivateInboundMessageEvent } from '@networkselfmd/core';

vi.mock('hyperswarm', () => ({
  default: class MockHyperswarm {
    on() {}
    join() { return { flushed: () => Promise.resolve() }; }
    leave() { return Promise.resolve(); }
    destroy() { return Promise.resolve(); }
  },
}));
vi.mock('hyperdht', () => ({ default: class MockHyperDHT {} }));

import { Agent } from '../agent.js';
import { makeIdentity } from './test-utils/group-harness.js';

interface Harness {
  agent: Agent;
  dataDir: string;
  bobFp: string;
  bobPub: Uint8Array;
  groupId: Uint8Array;
  cleanup: () => Promise<void>;
}

async function startAgent(opts?: { policyAuditDbMax?: number }): Promise<Harness> {
  const dataDir = mkdtempSync(join(tmpdir(), 'nsmd-audit-persist-'));
  const agent = new Agent({
    dataDir,
    displayName: 'Alice',
    policyConfig: { requireMention: false, mentionPrefixLen: 8 },
    policyAuditDbMax: opts?.policyAuditDbMax,
  });
  await agent.start();

  const bob = makeIdentity('Bob');
  const groupId = new Uint8Array(32).fill(0xdc);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const groupRepo = (agent as any).groupRepo;
  groupRepo.create(groupId, 'audit-test', 'admin');
  groupRepo.addMember(groupId, agent.identity.edPublicKey, 'admin');
  groupRepo.addMember(groupId, bob.edPublicKey, 'member');

  return {
    agent,
    dataDir,
    bobFp: bob.fingerprint,
    bobPub: bob.edPublicKey,
    groupId,
    cleanup: async () => {
      await agent.stop();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

function buildEvent(h: Harness, opts: { plaintext?: string; messageId?: string } = {}): PrivateInboundMessageEvent {
  return {
    kind: 'group',
    messageId: opts.messageId ?? 'mid-' + Math.random().toString(36).slice(2),
    groupId: h.groupId,
    senderPublicKey: h.bobPub,
    senderFingerprint: h.bobFp,
    plaintext: new TextEncoder().encode(opts.plaintext ?? 'hello'),
    timestamp: 1,
    receivedAt: 2,
  };
}

function inject(agent: Agent, ev: PrivateInboundMessageEvent | unknown): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (agent as any).groupManager.emit('inbound:message', ev);
}

describe('Persisted policy audit — Agent integration', () => {
  let h: Harness;
  beforeEach(async () => { h = await startAgent(); });
  afterEach(async () => h.cleanup());

  it('an allowed event is persisted to policy_audit', () => {
    const ev = buildEvent(h, { messageId: 'p1' });
    inject(h.agent, ev);
    const rows = h.agent.policyAuditRepo.recent({ limit: 5 });
    expect(rows).toHaveLength(1);
    expect(rows[0].messageId).toBe('p1');
    expect(rows[0].gateRejected).toBe(false);
    expect(rows[0].action).toBe('ask');
  });

  it('persists across Agent restart on the same dataDir', async () => {
    inject(h.agent, buildEvent(h, { messageId: 'restart-1' }));
    await h.agent.stop();

    const a2 = new Agent({
      dataDir: h.dataDir,
      displayName: 'Alice',
      policyConfig: { requireMention: false, mentionPrefixLen: 8 },
    });
    await a2.start();
    const rows = a2.policyAuditRepo.recent({ limit: 5 });
    expect(rows.map((r) => r.messageId)).toContain('restart-1');
    await a2.stop();
  });

  it('persists rejected events with gate_rejected=1 (malformed-event path)', () => {
    inject(h.agent, null); // malformed
    const rows = h.agent.policyAuditRepo.recent({ limit: 5 });
    expect(rows).toHaveLength(1);
    expect(rows[0].gateRejected).toBe(true);
    expect(rows[0].reason).toBe('malformed-event');
  });

  it('persistence failure preserves dedup retry-poison invariant', () => {
    // Stub the repo's insert to throw on the FIRST call only. The gate's
    // PolicyAuditLog.record runs persist() before the in-memory push,
    // so a throw here must propagate out of evaluate(), prevent the
    // queue push and emit, AND leave the messageId unmarked in dedup
    // so a legitimate retry can succeed.
    const real = h.agent.policyAuditRepo.insert.bind(h.agent.policyAuditRepo);
    let allow = false;
    const spy = vi.spyOn(h.agent.policyAuditRepo, 'insert').mockImplementation((entry) => {
      if (!allow) throw new Error('disk full');
      real(entry);
    });

    const ev = buildEvent(h, { messageId: 'crash-1' });
    // The Agent's listener for inbound:message rethrows from evaluate;
    // EventEmitter.emit forwards the throw. We catch it here and verify
    // post-conditions.
    expect(() => inject(h.agent, ev)).toThrow(/disk full/);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((h.agent.policyGate as any).isDuplicate('crash-1')).toBe(false);
    expect(h.agent.inboundQueue.size()).toBe(0);

    allow = true;
    inject(h.agent, ev);
    expect(h.agent.inboundQueue.size()).toBe(1);
    spy.mockRestore();
  });

  it('plaintext canary feeds through the gate but never lands in any policy_audit column', () => {
    const canary = 'AUDIT-DB-CANARY-XYZ';
    inject(h.agent, buildEvent(h, { plaintext: canary, messageId: 'canary-1' }));
    // Read the row directly from raw SQLite. None of the columns must
    // contain the canary string.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (h.agent as any).database.getDb();
    const rows = db.prepare('SELECT * FROM policy_audit').all() as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).not.toContain(canary);
    // policyAuditRepo.recent() must also be canary-free.
    expect(JSON.stringify(h.agent.policyAuditRepo.recent({ limit: 5 }))).not.toContain(canary);
  });

  it('in-memory and durable surfaces agree on metadata for the same event', () => {
    inject(h.agent, buildEvent(h, { messageId: 'mirror-1' }));
    const mem = h.agent.policyAudit.recent();
    const disk = h.agent.policyAuditRepo.recent({ limit: 10 });
    expect(mem).toHaveLength(1);
    expect(disk).toHaveLength(1);
    // auditId / messageId / reason / action / addressedToMe must match.
    // (received_at on disk is whatever evaluate captured; in-memory
    // entry has the same value because both come from the same record.)
    expect(disk[0].auditId).toBe(mem[0].auditId);
    expect(disk[0].messageId).toBe(mem[0].messageId);
    expect(disk[0].action).toBe(mem[0].action);
    expect(disk[0].reason).toBe(mem[0].reason);
    expect(disk[0].addressedToMe).toBe(mem[0].addressedToMe);
  });
});

describe('Persisted policy audit — retention', () => {
  let h: Harness;
  afterEach(async () => h?.cleanup());

  it('policyAuditDbMax: 3 + 5 events ⇒ DB keeps newest 3, newest-first', async () => {
    h = await startAgent({ policyAuditDbMax: 3 });
    for (let i = 0; i < 5; i++) {
      inject(h.agent, buildEvent(h, { messageId: `r-${i}` }));
      // Slow successive inserts so the inserted_at timestamps are
      // monotonically distinct enough for the prune to keep the right
      // ones.
      await new Promise((r) => setTimeout(r, 4));
    }
    const ids = h.agent.policyAuditRepo.recent({ limit: 10 }).map((e) => e.messageId);
    expect(ids).toEqual(['r-4', 'r-3', 'r-2']);
    expect(h.agent.policyAuditRepo.count()).toBe(3);
  });
});

describe('Privacy invariant — no plaintext on console/stdout/stderr while persisting', () => {
  let h: Harness;
  beforeEach(async () => { h = await startAgent(); });
  afterEach(async () => h.cleanup());

  it('100 valid events with embedded canary → no captured line contains it', () => {
    const orig = {
      log: console.log, info: console.info, warn: console.warn,
      error: console.error, debug: console.debug,
      stdout: process.stdout.write.bind(process.stdout),
      stderr: process.stderr.write.bind(process.stderr),
    };
    const captured: string[] = [];
    const sink = (...args: unknown[]) =>
      captured.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    console.log = sink; console.info = sink; console.warn = sink;
    console.error = sink; console.debug = sink;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    process.stdout.write = ((c: any) => { captured.push(typeof c === 'string' ? c : c.toString('utf-8')); return true; }) as typeof process.stdout.write;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    process.stderr.write = ((c: any) => { captured.push(typeof c === 'string' ? c : c.toString('utf-8')); return true; }) as typeof process.stderr.write;
    try {
      const canary = 'PERSIST-CANARY-PLAINTEXT-9f';
      for (let i = 0; i < 100; i++) {
        inject(h.agent, buildEvent(h, { plaintext: `start ${canary} end ${i}`, messageId: `pc-${i}` }));
      }
      for (const line of captured) expect(line).not.toContain(canary);
    } finally {
      console.log = orig.log; console.info = orig.info; console.warn = orig.warn;
      console.error = orig.error; console.debug = orig.debug;
      process.stdout.write = orig.stdout; process.stderr.write = orig.stderr;
    }
  });
});

