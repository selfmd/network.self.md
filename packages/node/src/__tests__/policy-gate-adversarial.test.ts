import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type {
  AgentIdentity,
  PolicyAuditEntry,
  PolicyDecision,
  PolicyReason,
  PrivateInboundMessageEvent,
} from '@networkselfmd/core';

// Mock the network layer so Agent.start() works without DHT/sockets.
vi.mock('hyperswarm', () => {
  return {
    default: class MockHyperswarm {
      on() {}
      join() {
        return { flushed: () => Promise.resolve() };
      }
      leave() {
        return Promise.resolve();
      }
      destroy() {
        return Promise.resolve();
      }
    },
  };
});
vi.mock('hyperdht', () => {
  return { default: class MockHyperDHT {} };
});

import { Agent } from '../agent.js';
import { makeIdentity } from './test-utils/group-harness.js';

interface Harness {
  agent: Agent;
  bob: AgentIdentity;
  groupId: Uint8Array;
  decisions: PolicyDecision[];
  audits: PolicyAuditEntry[];
  inbound: PrivateInboundMessageEvent[];
  cleanup: () => Promise<void>;
}

async function buildHarness(): Promise<Harness> {
  const dataDir = mkdtempSync(join(tmpdir(), 'nsmd-policy-adv-'));
  const agent = new Agent({
    dataDir,
    displayName: 'Alice',
    // Permissive default for these adversarial tests so happy-path
    // events flow through and we can observe denial behavior in isolation.
    policyConfig: { requireMention: false, mentionPrefixLen: 8 },
  });
  await agent.start();

  // Bob is a member of a group that Alice (the agent) belongs to.
  const bob = makeIdentity('Bob');
  const groupId = new Uint8Array(32).fill(0xdc);
  // Seed Alice's local group state directly through GroupManager paths.
  // We simulate Alice having created/joined a group with Bob as member.
  // Doing it via repos avoids running the full swarm/handshake.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const groupRepo = (agent as any).groupRepo;
  groupRepo.create(groupId, 'adv-test', 'admin');
  groupRepo.addMember(groupId, agent.identity.edPublicKey, 'admin');
  groupRepo.addMember(groupId, bob.edPublicKey, 'member');

  const decisions: PolicyDecision[] = [];
  const audits: PolicyAuditEntry[] = [];
  const inbound: PrivateInboundMessageEvent[] = [];
  agent.on('policy:decision', (d: PolicyDecision) => decisions.push(d));
  agent.on('policy:audit', (e: PolicyAuditEntry) => audits.push(e));
  agent.on('inbound:message', (ev: PrivateInboundMessageEvent) => inbound.push(ev));

  const cleanup = async () => {
    await agent.stop();
    rmSync(dataDir, { recursive: true, force: true });
  };

  return { agent, bob, groupId, decisions, audits, inbound, cleanup };
}

function buildGroupEvent(params: {
  bob: AgentIdentity;
  groupId: Uint8Array;
  messageId?: string;
  plaintext?: string;
}): PrivateInboundMessageEvent {
  return {
    kind: 'group',
    messageId: params.messageId ?? 'mid-' + Math.random().toString(36).slice(2),
    groupId: params.groupId,
    senderPublicKey: params.bob.edPublicKey,
    senderFingerprint: params.bob.fingerprint,
    plaintext: new TextEncoder().encode(params.plaintext ?? 'hello'),
    timestamp: 1,
    receivedAt: 2,
  };
}

// Helper to drive the Agent's inbound flow by emitting on its internal
// GroupManager — exactly how production code reaches the gate post-
// decrypt/post-persist. We never bypass the gate in these tests.
function inject(agent: Agent, ev: PrivateInboundMessageEvent | unknown): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const gm = (agent as any).groupManager;
  gm.emit('inbound:message', ev);
}

describe('Adversarial: PolicyGate integration in Agent', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await buildHarness();
  });

  afterEach(async () => {
    await h.cleanup();
  });

  it('1. allowed member event proceeds: queue + public emit + audit', () => {
    const ev = buildGroupEvent({ bob: h.bob, groupId: h.groupId, plaintext: 'hi all' });
    inject(h.agent, ev);

    expect(h.inbound).toHaveLength(1);
    expect(h.agent.inboundQueue.size()).toBe(1);
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0].gateRejected).toBe(false);
    expect(h.decisions).toHaveLength(1);
    expect(h.decisions[0].action).toBe('ask'); // requireMention:false → addressed-unknown-sender
  });

  it('2. denied non-member event is blocked: no queue, no emit, audit reason=not-a-member', () => {
    const stranger = makeIdentity('Stranger');
    const ev = buildGroupEvent({ bob: stranger, groupId: h.groupId });
    inject(h.agent, ev);

    expect(h.inbound).toHaveLength(0);
    expect(h.agent.inboundQueue.size()).toBe(0);
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0].reason).toBe('not-a-member');
    expect(h.audits[0].gateRejected).toBe(true);
  });

  it('3. unknown event kind fails closed: no queue, no emit, audit reason=unknown-event-kind', () => {
    inject(h.agent, {
      ...buildGroupEvent({ bob: h.bob, groupId: h.groupId }),
      kind: 'rumor',
    });
    expect(h.inbound).toHaveLength(0);
    expect(h.audits[0].reason).toBe('unknown-event-kind');
    expect(h.audits[0].eventKind).toBe('unknown');
  });

  it('4. malformed event fails closed: no queue, no emit, audit reason=malformed-event', () => {
    // Inject several deliberate malformations.
    inject(h.agent, null);
    inject(h.agent, { kind: 'group' /* missing required fields */ });
    inject(h.agent, {
      ...buildGroupEvent({ bob: h.bob, groupId: h.groupId }),
      plaintext: 'definitely not a Uint8Array',
    });
    inject(h.agent, {
      ...buildGroupEvent({ bob: h.bob, groupId: h.groupId }),
      timestamp: NaN,
    });
    inject(h.agent, {
      ...buildGroupEvent({ bob: h.bob, groupId: h.groupId }),
      messageId: '',
    });

    expect(h.inbound).toHaveLength(0);
    expect(h.agent.inboundQueue.size()).toBe(0);
    expect(h.audits.every((e) => e.reason === 'malformed-event' && e.gateRejected)).toBe(true);
    expect(h.audits).toHaveLength(5);
  });

  it('5. duplicate (same messageId) event does not cause double side effect', () => {
    const ev = buildGroupEvent({ bob: h.bob, groupId: h.groupId, messageId: 'dup-1' });
    inject(h.agent, ev);
    inject(h.agent, ev);

    // First was allowed; second was denied as duplicate-event. Side
    // effects (queue / emit) must not have fired twice.
    expect(h.inbound).toHaveLength(1);
    expect(h.agent.inboundQueue.size()).toBe(1);
    expect(h.audits).toHaveLength(2);
    expect(h.audits[0].gateRejected).toBe(false);
    expect(h.audits[1].reason).toBe('duplicate-event');
    expect(h.audits[1].gateRejected).toBe(true);
  });

  it('5b. dedup does NOT poison retries after a transient validation failure', () => {
    // Same messageId arrives first as malformed (validation fail), then
    // properly. The legitimate retry must proceed.
    inject(h.agent, { kind: 'group', messageId: 'tx-1' });
    expect(h.audits[0].reason).toBe('malformed-event');

    const ev = buildGroupEvent({
      bob: h.bob,
      groupId: h.groupId,
      messageId: 'tx-1',
      plaintext: 'retry that worked',
    });
    inject(h.agent, ev);
    expect(h.inbound).toHaveLength(1);
    expect(h.audits[1].gateRejected).toBe(false);
  });

  it('6. plaintext content never appears in audit / decision payloads', () => {
    const canary = 'adv-canary-CONFIDENTIAL-9f';
    const ev = buildGroupEvent({
      bob: h.bob,
      groupId: h.groupId,
      plaintext: canary,
    });
    inject(h.agent, ev);

    for (const e of h.audits) {
      expect(JSON.stringify(e)).not.toContain(canary);
    }
    for (const d of h.decisions) {
      expect(JSON.stringify(d)).not.toContain(canary);
    }
  });

  it('7. policy reason codes are stable (locked vocabulary)', async () => {
    const { POLICY_REASONS } = await import('@networkselfmd/core');
    const reasons = new Set<PolicyReason>(POLICY_REASONS);
    expect(reasons.size).toBe(11);
    // Sanity-check a few of the most-load-bearing ones.
    expect(reasons.has('not-addressed')).toBe(true);
    expect(reasons.has('addressed-and-trusted')).toBe(true);
    expect(reasons.has('malformed-event')).toBe(true);
    expect(reasons.has('unknown-event-kind')).toBe(true);
    expect(reasons.has('duplicate-event')).toBe(true);
    expect(reasons.has('not-a-member')).toBe(true);
  });

  it('8. policy gate runs BEFORE the queue/emission (ordering)', () => {
    // Subscribe to all three signals in registration order. The gate's
    // policy:audit MUST appear before inbound:message and before
    // inboundQueue.size() bumps. We capture timestamps via ordering.
    const order: string[] = [];
    const audit2: PolicyAuditEntry[] = [];
    h.agent.on('policy:audit', (e: PolicyAuditEntry) => {
      order.push('audit');
      audit2.push(e);
    });
    h.agent.on('inbound:message', () => order.push('inbound'));
    // Snapshot queue size at each emission.
    const sizes: number[] = [];
    h.agent.inboundQueue.on(() => {
      order.push('queue.push');
      sizes.push(h.agent.inboundQueue.size());
    });

    const ev = buildGroupEvent({ bob: h.bob, groupId: h.groupId, messageId: 'order-1' });
    inject(h.agent, ev);

    // audit MUST be the first signal — the gate writes the audit row
    // before pushing to the queue. The order between queue.push and
    // inbound EventEmitter is set by the wiring code; both happen after
    // audit either way, so we just assert audit is index 0.
    expect(order[0]).toBe('audit');
    expect(order).toContain('queue.push');
    expect(order).toContain('inbound');
    expect(audit2).toHaveLength(1);
    expect(audit2[0].gateRejected).toBe(false);
  });

  it('9. denied events never reach inboundQueue (queue is post-gate)', () => {
    // Run all four denial paths and assert the queue stays empty.
    // a) malformed
    inject(h.agent, null);
    // b) unknown kind
    inject(h.agent, { ...buildGroupEvent({ bob: h.bob, groupId: h.groupId }), kind: 'noise' });
    // c) non-member
    inject(h.agent, buildGroupEvent({ bob: makeIdentity('Stranger'), groupId: h.groupId }));
    // d) duplicate (allow once, then re-inject)
    const ev = buildGroupEvent({ bob: h.bob, groupId: h.groupId, messageId: 'd' });
    inject(h.agent, ev);
    inject(h.agent, ev);

    // Only one event should have made it to the queue (the unique allowed one).
    expect(h.agent.inboundQueue.size()).toBe(1);
    expect(h.inbound).toHaveLength(1);
    expect(h.inbound[0].messageId).toBe('d');
  });
});
