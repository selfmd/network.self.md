import { describe, it, expect, beforeEach } from 'vitest';
import type { AgentIdentity, PrivateInboundMessageEvent } from '@networkselfmd/core';
import { PolicyGate } from '../policy/policy-gate.js';
import { PolicyAuditLog } from '../policy/audit-log.js';
import { AgentPolicy } from '../policy/agent-policy.js';
import { InboundEventQueue } from '../events/inbound-queue.js';
import type { Agent } from '../agent.js';
import { makeIdentity } from './test-utils/group-harness.js';

function makeFakeAgent(identity: AgentIdentity): Agent {
  return { identity, inboundQueue: new InboundEventQueue() } as unknown as Agent;
}

function makeEvent(params: {
  alice: AgentIdentity;
  bob: AgentIdentity;
  groupId?: Uint8Array;
  kind?: 'group' | 'dm';
  messageId?: string;
  plaintext?: string | Uint8Array;
}): PrivateInboundMessageEvent {
  const plaintext =
    typeof params.plaintext === 'string'
      ? new TextEncoder().encode(params.plaintext)
      : (params.plaintext ?? new TextEncoder().encode('hello'));
  return {
    kind: params.kind ?? 'group',
    messageId: params.messageId ?? 'm-' + Math.random().toString(36).slice(2),
    groupId: params.kind === 'dm' ? undefined : (params.groupId ?? new Uint8Array([0xaa])),
    senderPublicKey: params.bob.edPublicKey,
    senderFingerprint: params.bob.fingerprint,
    plaintext,
    timestamp: 1,
    receivedAt: 2,
  };
}

interface Harness {
  alice: AgentIdentity;
  bob: AgentIdentity;
  groupId: Uint8Array;
  audit: PolicyAuditLog;
  policy: AgentPolicy;
  members: Set<string>; // hex sender pubkey
  gate: PolicyGate;
}

function buildHarness(): Harness {
  const alice = makeIdentity('Alice');
  const bob = makeIdentity('Bob');
  const groupId = new Uint8Array(32).fill(0x77);
  const audit = new PolicyAuditLog({ max: 16 });
  const policy = new AgentPolicy({
    agent: makeFakeAgent(alice),
    // requireMention: false treats every group event as addressed → decide
    // returns 'ask' / addressed-unknown-sender so the gate's `allowed`
    // boolean is true for happy-path tests. Failure-mode tests assert on
    // `reason` directly.
    config: { mentionPrefixLen: 8, requireMention: false },
  });
  // Membership predicate: bob is a member of `groupId`. Alice too.
  const members = new Set<string>([
    Buffer.from(alice.edPublicKey).toString('hex'),
    Buffer.from(bob.edPublicKey).toString('hex'),
  ]);
  const gate = new PolicyGate({
    policy,
    audit,
    isMember: (gid, pk) =>
      Buffer.from(gid).equals(Buffer.from(groupId)) &&
      members.has(Buffer.from(pk).toString('hex')),
  });
  return { alice, bob, groupId, audit, policy, members, gate };
}

describe('PolicyGate.evaluate — happy path', () => {
  it('allows a valid group event from a member; records audit; emits decision', () => {
    const h = buildHarness();
    const decisions: unknown[] = [];
    h.gate.on('decision', (d) => decisions.push(d));

    const ev = makeEvent({ alice: h.alice, bob: h.bob, groupId: h.groupId, plaintext: 'hi there' });
    const out = h.gate.evaluate(ev);

    expect(out.allowed).toBe(true);
    if (!out.allowed) throw new Error('unreachable');
    expect(out.decision.action).toBe('ask'); // requireMention:false → addressed-unknown-sender
    expect(out.entry.gateRejected).toBe(false);
    expect(out.entry.eventKind).toBe('group');
    expect(out.entry.byteLength).toBe('hi there'.length);
    expect(h.audit.recent()).toHaveLength(1);
    expect(decisions).toHaveLength(1);
  });
});

describe('PolicyGate.evaluate — fail-closed paths', () => {
  let h: Harness;
  beforeEach(() => {
    h = buildHarness();
  });

  it('rejects malformed (non-object) input as malformed-event; never calls decide', () => {
    let decideCalls = 0;
    const origDecide = h.policy.decide.bind(h.policy);
    h.policy.decide = (ev) => {
      decideCalls++;
      return origDecide(ev);
    };
    const out = h.gate.evaluate(null);
    expect(out.allowed).toBe(false);
    if (out.allowed) throw new Error('unreachable');
    expect(out.reason).toBe('malformed-event');
    expect(out.entry.gateRejected).toBe(true);
    expect(decideCalls).toBe(0);
  });

  it('rejects unknown kind as unknown-event-kind', () => {
    const out = h.gate.evaluate({
      ...makeEvent({ alice: h.alice, bob: h.bob, groupId: h.groupId }),
      kind: 'spam',
    });
    expect(out.allowed).toBe(false);
    if (out.allowed) throw new Error('unreachable');
    expect(out.reason).toBe('unknown-event-kind');
    expect(out.entry.eventKind).toBe('unknown');
  });

  it('rejects a non-member sender on a group event as not-a-member', () => {
    // Make Bob suddenly NOT a member.
    h.members.delete(Buffer.from(h.bob.edPublicKey).toString('hex'));
    const out = h.gate.evaluate(makeEvent({ alice: h.alice, bob: h.bob, groupId: h.groupId }));
    expect(out.allowed).toBe(false);
    if (out.allowed) throw new Error('unreachable');
    expect(out.reason).toBe('not-a-member');
    expect(out.entry.gateRejected).toBe(true);
  });
});

describe('PolicyGate dedup — retry-poison invariant', () => {
  let h: Harness;
  beforeEach(() => {
    h = buildHarness();
  });

  it('marks messageId after a successful evaluation; second occurrence is duplicate-event', () => {
    const ev = makeEvent({ alice: h.alice, bob: h.bob, groupId: h.groupId, messageId: 'shared' });
    const first = h.gate.evaluate(ev);
    expect(first.allowed).toBe(true);
    expect(h.gate.isDuplicate('shared')).toBe(true);

    const second = h.gate.evaluate(ev);
    expect(second.allowed).toBe(false);
    if (second.allowed) throw new Error('unreachable');
    expect(second.reason).toBe('duplicate-event');
    expect(h.audit.recent()).toHaveLength(2);
  });

  it('does NOT mark dedup when validation fails; legitimate retry with same messageId proceeds', () => {
    // First attempt: malformed (missing required fields), but happens to
    // carry a messageId. Validation fail → no dedup poisoning.
    h.gate.evaluate({ kind: 'group', messageId: 'shared-id' });
    expect(h.gate.isDuplicate('shared-id')).toBe(false);

    // Second attempt: well-formed event with same messageId. Must be
    // evaluated normally, not denied as duplicate.
    const ev = makeEvent({
      alice: h.alice,
      bob: h.bob,
      groupId: h.groupId,
      messageId: 'shared-id',
    });
    const out = h.gate.evaluate(ev);
    expect(out.allowed).toBe(true);
  });

  it('does NOT mark dedup when membership recheck fails; same messageId can be re-evaluated after admission', () => {
    h.members.delete(Buffer.from(h.bob.edPublicKey).toString('hex'));
    const ev = makeEvent({
      alice: h.alice,
      bob: h.bob,
      groupId: h.groupId,
      messageId: 'mid',
    });
    const first = h.gate.evaluate(ev);
    expect(first.allowed).toBe(false);
    expect(h.gate.isDuplicate('mid')).toBe(false);

    // Bob re-admitted.
    h.members.add(Buffer.from(h.bob.edPublicKey).toString('hex'));
    const second = h.gate.evaluate(ev);
    expect(second.allowed).toBe(true);
  });

  it('does NOT mark dedup when audit.record throws; retry succeeds', () => {
    let allowOnce = false;
    const realRecord = h.audit.record.bind(h.audit);
    h.audit.record = (entry) => {
      if (!allowOnce && !entry.gateRejected) {
        // Fail the first SUCCESSFUL audit only — not the reject audits.
        throw new Error('disk full');
      }
      return realRecord(entry);
    };

    const ev = makeEvent({
      alice: h.alice,
      bob: h.bob,
      groupId: h.groupId,
      messageId: 'crash-id',
    });
    expect(() => h.gate.evaluate(ev)).toThrow(/disk full/);
    expect(h.gate.isDuplicate('crash-id')).toBe(false);

    allowOnce = true;
    const out = h.gate.evaluate(ev);
    expect(out.allowed).toBe(true);
  });

  it('evicts oldest messageId when dedup capacity is exceeded', () => {
    const small = new PolicyGate({
      policy: h.policy,
      audit: h.audit,
      isMember: (gid, pk) =>
        Buffer.from(gid).equals(Buffer.from(h.groupId)) &&
        h.members.has(Buffer.from(pk).toString('hex')),
      dedupSize: 2,
    });
    for (const id of ['a', 'b', 'c']) {
      const ev = makeEvent({
        alice: h.alice,
        bob: h.bob,
        groupId: h.groupId,
        messageId: id,
      });
      small.evaluate(ev);
    }
    expect(small.isDuplicate('a')).toBe(false); // evicted
    expect(small.isDuplicate('b')).toBe(true);
    expect(small.isDuplicate('c')).toBe(true);
  });
});

describe('PolicyAuditLog — entries are metadata-only', () => {
  it('never carries a plaintext field; byteLength is the only size signal', () => {
    const h = buildHarness();
    const canary = 'audit-canary-zzz';
    const ev = makeEvent({
      alice: h.alice,
      bob: h.bob,
      groupId: h.groupId,
      messageId: 'mc',
      plaintext: canary,
    });
    h.gate.evaluate(ev);
    const entries = h.audit.recent();
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry).not.toHaveProperty('plaintext');
    expect(entry).not.toHaveProperty('content');
    expect(entry.byteLength).toBe(canary.length);
    expect(JSON.stringify(entry)).not.toContain(canary);
  });
});
