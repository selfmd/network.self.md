import { describe, it, expect, beforeEach } from 'vitest';
import type { AgentIdentity, PolicyAuditEntry, PrivateInboundMessageEvent } from '@networkselfmd/core';
import { PolicyAuditLog } from '../policy/audit-log.js';
import { PolicyGate } from '../policy/policy-gate.js';
import { AgentPolicy } from '../policy/agent-policy.js';
import { InboundEventQueue } from '../events/inbound-queue.js';
import type { Agent } from '../agent.js';
import { makeIdentity } from './test-utils/group-harness.js';

function fakeAgent(id: AgentIdentity): Agent {
  return { identity: id, inboundQueue: new InboundEventQueue() } as unknown as Agent;
}

const SAMPLE_ENTRY: PolicyAuditEntry = {
  auditId: 'a1',
  receivedAt: 1,
  eventKind: 'group',
  messageId: 'm1',
  groupIdHex: 'aa',
  senderFingerprint: 'fp',
  byteLength: 8,
  action: 'ask',
  reason: 'addressed-unknown-sender',
  addressedToMe: true,
  senderTrusted: false,
  matchedInterests: ['coffee'],
  gateRejected: false,
};

describe('PolicyAuditLog — stored entries are deeply immutable', () => {
  it('mutating the input AFTER record() does not corrupt the stored entry', () => {
    const log = new PolicyAuditLog();
    const input: PolicyAuditEntry = { ...SAMPLE_ENTRY, matchedInterests: ['coffee'] };
    log.record(input);
    // Mutate every field on the input.
    input.action = 'act';
    input.reason = 'addressed-and-trusted';
    input.matchedInterests.push('hijack');
    input.senderFingerprint = 'attacker';
    const stored = log.recent()[0];
    expect(stored.action).toBe('ask');
    expect(stored.reason).toBe('addressed-unknown-sender');
    expect(stored.matchedInterests).toEqual(['coffee']);
    expect(stored.senderFingerprint).toBe('fp');
  });

  it('returned entry is frozen — direct field mutation throws in strict mode', () => {
    const log = new PolicyAuditLog();
    log.record(SAMPLE_ENTRY);
    const e = log.recent()[0];
    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (e as any).action = 'act';
    }).toThrow();
    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (e as any).reason = 'addressed-and-trusted';
    }).toThrow();
  });

  it('matchedInterests array on the stored entry is also frozen', () => {
    const log = new PolicyAuditLog();
    log.record(SAMPLE_ENTRY);
    const e = log.recent()[0];
    expect(() => e.matchedInterests.push('hijack')).toThrow();
    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (e.matchedInterests as any)[0] = 'replaced';
    }).toThrow();
  });

  it('record() returns the frozen stored copy, not the input', () => {
    const log = new PolicyAuditLog();
    const input = { ...SAMPLE_ENTRY };
    const returned = log.record(input);
    expect(returned).not.toBe(input);
    expect(Object.isFrozen(returned)).toBe(true);
    expect(Object.isFrozen(returned.matchedInterests)).toBe(true);
  });

  it('two recent() calls return entries that are equal (no clone-on-read churn)', () => {
    const log = new PolicyAuditLog();
    log.record(SAMPLE_ENTRY);
    const a = log.recent()[0];
    const b = log.recent()[0];
    // Stored once, frozen, returned by reference — same object instance.
    expect(a).toBe(b);
  });
});

interface GateHarness {
  alice: AgentIdentity;
  bob: AgentIdentity;
  groupId: Uint8Array;
  audit: PolicyAuditLog;
  gate: PolicyGate;
  isMember: { value: (g: Uint8Array, k: Uint8Array) => boolean };
}

function buildGate(): GateHarness {
  const alice = makeIdentity('Alice');
  const bob = makeIdentity('Bob');
  const groupId = new Uint8Array(32).fill(0xab);
  const audit = new PolicyAuditLog({ max: 32 });
  const policy = new AgentPolicy({
    agent: fakeAgent(alice),
    config: { mentionPrefixLen: 8, requireMention: false },
  });
  const isMember = {
    value: (g: Uint8Array, k: Uint8Array): boolean =>
      Buffer.from(g).equals(Buffer.from(groupId)) &&
      Buffer.from(k).equals(Buffer.from(bob.edPublicKey)),
  };
  const gate = new PolicyGate({
    policy,
    audit,
    isMember: (g, k) => isMember.value(g, k),
  });
  return { alice, bob, groupId, audit, gate, isMember };
}

function buildEvent(h: GateHarness, opts: { id?: string; sender?: AgentIdentity } = {}): PrivateInboundMessageEvent {
  return {
    kind: 'group',
    messageId: opts.id ?? 'm-' + Math.random().toString(36).slice(2),
    groupId: h.groupId,
    senderPublicKey: (opts.sender ?? h.bob).edPublicKey,
    senderFingerprint: (opts.sender ?? h.bob).fingerprint,
    plaintext: new TextEncoder().encode('hi'),
    timestamp: 1,
    receivedAt: 2,
  };
}

describe('PolicyGate — defensive wrapping around external callbacks', () => {
  let h: GateHarness;
  beforeEach(() => {
    h = buildGate();
  });

  it('isMember throwing → fail-closed as not-a-member, no crash, audit recorded', () => {
    h.isMember.value = () => {
      throw new Error('db boom');
    };
    const ev = buildEvent(h, { id: 'thrown-1' });
    const out = h.gate.evaluate(ev);
    expect(out.allowed).toBe(false);
    if (out.allowed) throw new Error('unreachable');
    expect(out.reason).toBe('not-a-member');
    expect(out.entry.gateRejected).toBe(true);
    expect(h.audit.recent()).toHaveLength(1);
    // Dedup must NOT be poisoned: a retry after the predicate recovers
    // is still allowed to be re-evaluated (and pass).
    expect(h.gate.isDuplicate('thrown-1')).toBe(false);
    h.isMember.value = () => true;
    const retry = h.gate.evaluate(buildEvent(h, { id: 'thrown-1' }));
    expect(retry.allowed).toBe(true);
  });

  it("'decision' listener throwing does not abort the gate's return path", async () => {
    h.gate.on('decision', () => {
      throw new Error('listener-buggy-canary');
    });

    // The gate rethrows listener errors on a microtask so the calling
    // event loop sees the bug; vitest's default uncaughtException
    // handler would fail the test. Detach handlers for the duration of
    // this test, capture the rethrow ourselves, and restore.
    const previous = process.listeners('uncaughtException');
    process.removeAllListeners('uncaughtException');
    const surfaced: unknown[] = [];
    const capture = (err: unknown) => surfaced.push(err);
    process.on('uncaughtException', capture);
    try {
      const out = h.gate.evaluate(buildEvent(h, { id: 'lis-1' }));
      // The listener threw, but evaluate returned the normal allowed
      // outcome — this is the contract: gate state and downstream side
      // effects don't depend on listener health.
      expect(out.allowed).toBe(true);
      expect(h.gate.isDuplicate('lis-1')).toBe(true);
      expect(h.audit.recent()).toHaveLength(1);
      // Drain the microtask queue so the rethrow surfaces.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(surfaced).toHaveLength(1);
      const err = surfaced[0] as Error;
      expect(err.message).toMatch(/listener-buggy-canary/);
    } finally {
      process.off('uncaughtException', capture);
      for (const l of previous) {
        process.on('uncaughtException', l as (err: Error) => void);
      }
    }
  });
});
