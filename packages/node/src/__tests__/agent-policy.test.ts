import { describe, it, expect } from 'vitest';
import type {
  AgentIdentity,
  PolicyConfig,
  PolicyDecision,
  PrivateInboundMessageEvent,
} from '@networkselfmd/core';
import { AgentPolicy } from '../policy/agent-policy.js';
import { InboundEventQueue } from '../events/inbound-queue.js';
import type { Agent } from '../agent.js';
import { makeIdentity } from './test-utils/group-harness.js';

// Minimal Agent stand-in: only the fields AgentPolicy touches.
function makeFakeAgent(identity: AgentIdentity): Agent {
  const inboundQueue = new InboundEventQueue();
  return { identity, inboundQueue } as unknown as Agent;
}

function makeEvent(params: {
  plaintext: string | Uint8Array;
  senderFingerprint: string;
  senderPublicKey?: Uint8Array;
  messageId?: string;
  kind?: 'group' | 'dm';
  groupId?: Uint8Array;
}): PrivateInboundMessageEvent {
  const plaintext =
    typeof params.plaintext === 'string'
      ? new TextEncoder().encode(params.plaintext)
      : params.plaintext;
  return {
    kind: params.kind ?? 'group',
    messageId: params.messageId ?? 'm1',
    groupId: params.groupId ?? new Uint8Array([0xaa]),
    senderPublicKey: params.senderPublicKey ?? new Uint8Array(32),
    senderFingerprint: params.senderFingerprint,
    plaintext,
    timestamp: 1,
    receivedAt: 2,
  };
}

describe('AgentPolicy.decide — pure decision logic', () => {
  let alice: AgentIdentity;
  let bob: AgentIdentity;

  it('unaddressed + untrusted + no interest hit → ignore / not-addressed', () => {
    alice = makeIdentity('Alice');
    bob = makeIdentity('Bob');
    const policy = new AgentPolicy({
      agent: makeFakeAgent(alice),
      config: {},
    });
    const d = policy.decide(
      makeEvent({ plaintext: 'random chatter', senderFingerprint: bob.fingerprint }),
    );
    expect(d.action).toBe('ignore');
    expect(d.reason).toBe('not-addressed');
    expect(d.addressedToMe).toBe(false);
    expect(d.senderTrusted).toBe(false);
    expect(d.matchedInterests).toEqual([]);
  });

  it('addressed by fingerprint prefix, untrusted, no interest → ask / addressed-unknown-sender', () => {
    alice = makeIdentity('Alice');
    bob = makeIdentity('Bob');
    const policy = new AgentPolicy({
      agent: makeFakeAgent(alice),
      config: { mentionPrefixLen: 8 },
    });
    const prefix = alice.fingerprint.slice(0, 8);
    const d = policy.decide(
      makeEvent({
        plaintext: `hey @${prefix} check this`,
        senderFingerprint: bob.fingerprint,
      }),
    );
    expect(d.addressedToMe).toBe(true);
    expect(d.action).toBe('ask');
    expect(d.reason).toBe('addressed-unknown-sender');
  });

  it('addressed by displayName → addressedToMe=true', () => {
    alice = makeIdentity('alice7');
    bob = makeIdentity('Bob');
    const policy = new AgentPolicy({
      agent: makeFakeAgent(alice),
      config: {},
    });
    const d = policy.decide(
      makeEvent({ plaintext: 'hi @alice7 here', senderFingerprint: bob.fingerprint }),
    );
    expect(d.addressedToMe).toBe(true);
  });

  it('addressed + trusted → act / addressed-and-trusted', () => {
    alice = makeIdentity('Alice');
    bob = makeIdentity('Bob');
    const policy = new AgentPolicy({
      agent: makeFakeAgent(alice),
      config: {
        trustedFingerprints: [bob.fingerprint],
        mentionPrefixLen: 8,
      },
    });
    const prefix = alice.fingerprint.slice(0, 8);
    const d = policy.decide(
      makeEvent({ plaintext: `@${prefix} ping`, senderFingerprint: bob.fingerprint }),
    );
    expect(d.action).toBe('act');
    expect(d.reason).toBe('addressed-and-trusted');
    expect(d.addressedToMe).toBe(true);
    expect(d.senderTrusted).toBe(true);
  });

  it('trusted but unaddressed, no interest → ignore / trusted-no-signal', () => {
    alice = makeIdentity('Alice');
    bob = makeIdentity('Bob');
    const policy = new AgentPolicy({
      agent: makeFakeAgent(alice),
      config: { trustedFingerprints: [bob.fingerprint] },
    });
    const d = policy.decide(
      makeEvent({ plaintext: 'just chatter', senderFingerprint: bob.fingerprint }),
    );
    expect(d.action).toBe('ignore');
    expect(d.reason).toBe('trusted-no-signal');
    expect(d.senderTrusted).toBe(true);
  });

  it('interest keyword hit (untrusted, unaddressed) → ask / interest-hit', () => {
    alice = makeIdentity('Alice');
    bob = makeIdentity('Bob');
    const policy = new AgentPolicy({
      agent: makeFakeAgent(alice),
      config: { interests: ['coffee', 'meeting'] },
    });
    const d = policy.decide(
      makeEvent({
        plaintext: 'want to grab COFFEE later?',
        senderFingerprint: bob.fingerprint,
      }),
    );
    expect(d.action).toBe('ask');
    expect(d.reason).toBe('interest-hit');
    expect(d.matchedInterests).toEqual(['coffee']);
  });

  it('invalid UTF-8 plaintext → addressedToMe=false, matchedInterests=[], ignore', () => {
    alice = makeIdentity('Alice');
    bob = makeIdentity('Bob');
    const policy = new AgentPolicy({
      agent: makeFakeAgent(alice),
      config: { interests: ['coffee'] },
    });
    const d = policy.decide(
      makeEvent({
        plaintext: new Uint8Array([0xc3, 0x28, 0xff]), // invalid UTF-8
        senderFingerprint: bob.fingerprint,
      }),
    );
    expect(d.addressedToMe).toBe(false);
    expect(d.matchedInterests).toEqual([]);
    expect(d.action).toBe('ignore');
    expect(d.reason).toBe('not-addressed');
  });

  it('mention is token-bounded — trailing identifier chars do not match', () => {
    alice = makeIdentity('Alice');
    bob = makeIdentity('Bob');
    const policy = new AgentPolicy({
      agent: makeFakeAgent(alice),
      config: { mentionPrefixLen: 8 },
    });
    const prefix = alice.fingerprint.slice(0, 8);
    // Valid mention at end of string.
    const d1 = policy.decide(
      makeEvent({ plaintext: `hi @${prefix}`, senderFingerprint: bob.fingerprint }),
    );
    expect(d1.addressedToMe).toBe(true);

    // Valid mention followed by punctuation/whitespace.
    const d2 = policy.decide(
      makeEvent({ plaintext: `@${prefix}, yo`, senderFingerprint: bob.fingerprint }),
    );
    expect(d2.addressedToMe).toBe(true);

    // Invalid: followed by more identifier chars — must NOT match.
    const d3 = policy.decide(
      makeEvent({ plaintext: `hello @${prefix}abc`, senderFingerprint: bob.fingerprint }),
    );
    expect(d3.addressedToMe).toBe(false);
  });

  it('requireMention=false treats every group message as addressed', () => {
    alice = makeIdentity('Alice');
    bob = makeIdentity('Bob');
    const policy = new AgentPolicy({
      agent: makeFakeAgent(alice),
      config: { requireMention: false },
    });
    const d = policy.decide(
      makeEvent({
        plaintext: 'no mention at all',
        senderFingerprint: bob.fingerprint,
        kind: 'group',
      }),
    );
    expect(d.addressedToMe).toBe(true);
    expect(d.action).toBe('ask');
    expect(d.reason).toBe('addressed-unknown-sender');
  });

  it('trusted sender with interest hit but unaddressed → ask / trusted-interest-hit', () => {
    alice = makeIdentity('Alice');
    bob = makeIdentity('Bob');
    const policy = new AgentPolicy({
      agent: makeFakeAgent(alice),
      config: {
        interests: ['deploy'],
        trustedFingerprints: [bob.fingerprint],
      },
    });
    const d = policy.decide(
      makeEvent({ plaintext: 'deploy in 5m', senderFingerprint: bob.fingerprint }),
    );
    expect(d.action).toBe('ask');
    expect(d.reason).toBe('trusted-interest-hit');
    expect(d.matchedInterests).toEqual(['deploy']);
  });

  it('addressed + interest hit, untrusted → ask / addressed-matches-interest', () => {
    alice = makeIdentity('Alice');
    bob = makeIdentity('Bob');
    const policy = new AgentPolicy({
      agent: makeFakeAgent(alice),
      config: { interests: ['ship'], mentionPrefixLen: 8 },
    });
    const prefix = alice.fingerprint.slice(0, 8);
    const d = policy.decide(
      makeEvent({
        plaintext: `@${prefix} let's ship today`,
        senderFingerprint: bob.fingerprint,
      }),
    );
    expect(d.action).toBe('ask');
    expect(d.reason).toBe('addressed-matches-interest');
  });
});

describe('AgentPolicy.start — queue subscription', () => {
  it('fires decision events for each pushed inbound event', () => {
    const alice = makeIdentity('Alice');
    const bob = makeIdentity('Bob');
    const agent = makeFakeAgent(alice);
    const config: PolicyConfig = { mentionPrefixLen: 8 };
    const policy = new AgentPolicy({ agent, config });

    const decisions: PolicyDecision[] = [];
    policy.on('decision', (d: PolicyDecision) => decisions.push(d));
    policy.start();

    const prefix = alice.fingerprint.slice(0, 8);
    agent.inboundQueue.push(
      makeEvent({ plaintext: `@${prefix} hi`, messageId: 'm1', senderFingerprint: bob.fingerprint }),
    );
    agent.inboundQueue.push(
      makeEvent({ plaintext: 'nothing', messageId: 'm2', senderFingerprint: bob.fingerprint }),
    );

    expect(decisions).toHaveLength(2);
    expect(decisions[0].messageId).toBe('m1');
    expect(decisions[0].addressedToMe).toBe(true);
    expect(decisions[1].messageId).toBe('m2');
    expect(decisions[1].addressedToMe).toBe(false);

    policy.stop();
    agent.inboundQueue.push(
      makeEvent({ plaintext: 'after stop', messageId: 'm3', senderFingerprint: bob.fingerprint }),
    );
    expect(decisions).toHaveLength(2);
  });
});

describe('PolicyDecision — no plaintext leakage', () => {
  it('JSON.stringify of a decision never contains plaintext bytes', () => {
    const alice = makeIdentity('Alice');
    const bob = makeIdentity('Bob');
    const policy = new AgentPolicy({
      agent: makeFakeAgent(alice),
      config: { interests: ['coffee'], mentionPrefixLen: 8 },
    });
    const canary = 'policy-canary-plaintext-42';
    const prefix = alice.fingerprint.slice(0, 8);
    const d = policy.decide(
      makeEvent({
        plaintext: `@${prefix} talk about coffee ${canary}`,
        senderFingerprint: bob.fingerprint,
      }),
    );
    const serialized = JSON.stringify(d);
    expect(serialized).not.toContain(canary);
    expect(serialized).not.toContain('talk about coffee');
    // matched interest keyword itself is config-supplied, not plaintext, so it may appear.
    expect(serialized).toContain('coffee');
  });
});
