import { describe, it, expect } from 'vitest';
import type { AgentIdentity, PolicyAuditEntry, PrivateInboundMessageEvent } from '@networkselfmd/core';
import { PolicyGate } from '../policy/policy-gate.js';
import { PolicyAuditLog } from '../policy/audit-log.js';
import { AgentPolicy } from '../policy/agent-policy.js';
import { InboundEventQueue } from '../events/inbound-queue.js';
import type { Agent } from '../agent.js';
import { makeIdentity } from './test-utils/group-harness.js';

// Deterministic seeded PRNG (mulberry32). Failures are reproducible by
// re-running with the same seed — printed in the assertion when an
// iteration fails, so a CI flake can be replayed locally.
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rngBytes(rng: () => number, n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.floor(rng() * 256);
  return out;
}

function rngString(rng: () => number, max: number = 32): string {
  const len = Math.floor(rng() * max);
  let s = '';
  // Mix ascii + occasional unicode + symbols + whitespace.
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -_@!#%^&*()[]\\\'"\n\t';
  for (let i = 0; i < len; i++) {
    s += alphabet[Math.floor(rng() * alphabet.length)];
  }
  return s;
}

interface Harness {
  alice: AgentIdentity;
  bob: AgentIdentity;
  groupId: Uint8Array;
  audit: PolicyAuditLog;
  gate: PolicyGate;
  validId: () => string;
}

function makeFakeAgent(identity: AgentIdentity): Agent {
  return { identity, inboundQueue: new InboundEventQueue() } as unknown as Agent;
}

function buildHarness(): Harness {
  const alice = makeIdentity('alice');
  const bob = makeIdentity('bob');
  const groupId = new Uint8Array(32).fill(0xfe);
  const audit = new PolicyAuditLog({ max: 10000 });
  const policy = new AgentPolicy({
    agent: makeFakeAgent(alice),
    config: { mentionPrefixLen: 8, requireMention: false, interests: ['coffee'] },
  });
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
  let n = 0;
  return { alice, bob, groupId, audit, gate, validId: () => `valid-${++n}` };
}

// Generate a random "almost-event" payload with assorted malformations.
// Each iteration picks a different combination of broken/missing fields.
function randomMalformedPayload(rng: () => number): unknown {
  const bucket = Math.floor(rng() * 8);
  switch (bucket) {
    case 0:
      return null;
    case 1:
      return undefined;
    case 2:
      return rng();
    case 3:
      return rngString(rng, 16);
    case 4:
      return [];
    case 5:
      return { kind: rngString(rng, 8) }; // bad kind
    case 6:
      return {
        kind: 'group',
        messageId: rngString(rng, 8),
        plaintext: 'i am not a Uint8Array',
      };
    case 7:
    default:
      return {
        kind: rng() < 0.5 ? 'group' : 'dm',
        // randomly pick which required field to omit
        messageId: rng() < 0.5 ? '' : undefined,
        senderFingerprint: rng() < 0.3 ? '' : 'fp',
        senderPublicKey: rng() < 0.3 ? null : new Uint8Array(32),
        plaintext: rng() < 0.3 ? null : new Uint8Array(8),
        timestamp: rng() < 0.3 ? NaN : 1,
        receivedAt: 1,
      };
  }
}

describe('Property: malformed payloads never throw and never proceed', () => {
  // Single deterministic seed for CI reproducibility. Bump if surface
  // grows enough that this seed misses obvious bugs.
  const SEED = 0x5e1ed5a4;
  const N = 500;

  it(`fuzz N=${N} seed=${SEED.toString(16)}: gate returns structured outcome, never throws`, () => {
    const h = buildHarness();
    const rng = mulberry32(SEED);
    for (let i = 0; i < N; i++) {
      const payload = randomMalformedPayload(rng);
      let outcome: unknown;
      expect(() => {
        outcome = h.gate.evaluate(payload);
      }, `iter=${i} seed=${SEED.toString(16)} payload=${safeStringify(payload)}`).not.toThrow();
      // Whatever it returned, it MUST be a deny (no allowed:true on
      // malformed input by default).
      expect(
        (outcome as { allowed: boolean }).allowed,
        `iter=${i}: malformed payload was allowed: ${safeStringify(payload)}`,
      ).toBe(false);
    }
    // Every iteration produced an audit entry.
    expect(h.audit.size()).toBe(N);
  });
});

describe('Property: random plaintext never leaks into audit/log output', () => {
  const SEED = 0xbeefcafe;
  const N = 500;
  const TOKEN = 'PLAINTEXT-CANARY-TOKEN-ZZ';

  it(`fuzz N=${N} seed=${SEED.toString(16)}: audit never contains the canary token regardless of payload`, () => {
    const h = buildHarness();
    const rng = mulberry32(SEED);
    // Capture any console output during the loop. The gate has no
    // logging today; this catches future regressions.
    const orig = {
      log: console.log,
      info: console.info,
      warn: console.warn,
      error: console.error,
      debug: console.debug,
      stdoutWrite: process.stdout.write.bind(process.stdout),
      stderrWrite: process.stderr.write.bind(process.stderr),
    };
    const captured: string[] = [];
    const sink = (...args: unknown[]) =>
      captured.push(args.map((a) => (typeof a === 'string' ? a : safeStringify(a))).join(' '));
    console.log = sink;
    console.info = sink;
    console.warn = sink;
    console.error = sink;
    console.debug = sink;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    process.stdout.write = ((c: any) => { captured.push(typeof c === 'string' ? c : c.toString('utf-8')); return true; }) as typeof process.stdout.write;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    process.stderr.write = ((c: any) => { captured.push(typeof c === 'string' ? c : c.toString('utf-8')); return true; }) as typeof process.stderr.write;

    try {
      for (let i = 0; i < N; i++) {
        // Build a valid event whose plaintext embeds the canary token at
        // a random position and contains a fuzz-amount of random
        // surrounding bytes (sometimes UTF-8, sometimes binary).
        const before = rngString(rng, 16);
        const after = rngString(rng, 16);
        const ascii = before + TOKEN + after;
        const useBinary = rng() < 0.3;
        const plaintext = useBinary
          ? concatBytes(new TextEncoder().encode(before), rngBytes(rng, 4), new TextEncoder().encode(TOKEN + after))
          : new TextEncoder().encode(ascii);
        const ev: PrivateInboundMessageEvent = {
          kind: 'group',
          messageId: h.validId(),
          groupId: h.groupId,
          senderPublicKey: h.bob.edPublicKey,
          senderFingerprint: h.bob.fingerprint,
          plaintext,
          timestamp: 1,
          receivedAt: 2,
        };
        h.gate.evaluate(ev);
      }
    } finally {
      console.log = orig.log;
      console.info = orig.info;
      console.warn = orig.warn;
      console.error = orig.error;
      console.debug = orig.debug;
      process.stdout.write = orig.stdoutWrite;
      process.stderr.write = orig.stderrWrite;
    }

    // No console output at all in this PR's policy code path.
    for (const line of captured) {
      expect(line).not.toContain(TOKEN);
    }
    // Audit entries are metadata-only — none should ever contain the
    // plaintext canary even though every event included it.
    const allEntries: PolicyAuditEntry[] = h.audit.recent();
    expect(allEntries.length).toBe(N);
    for (const entry of allEntries) {
      expect(JSON.stringify(entry)).not.toContain(TOKEN);
    }
  });
});

describe('Property: byteLength matches but plaintext bytes never appear', () => {
  it('100 random valid events: every audit byteLength == plaintext.byteLength; no shape drift', () => {
    const h = buildHarness();
    const rng = mulberry32(0x12345678);
    for (let i = 0; i < 100; i++) {
      const len = Math.floor(rng() * 256);
      const plaintext = rngBytes(rng, len);
      const ev: PrivateInboundMessageEvent = {
        kind: 'group',
        messageId: `b-${i}`,
        groupId: h.groupId,
        senderPublicKey: h.bob.edPublicKey,
        senderFingerprint: h.bob.fingerprint,
        plaintext,
        timestamp: 1,
        receivedAt: 2,
      };
      h.gate.evaluate(ev);
      const last = h.audit.recent(1)[0];
      expect(last.byteLength).toBe(len);
      // The exact set of keys on every audit entry is the privacy
      // contract. If a new content-bearing field gets added, this fails.
      expect(Object.keys(last).sort()).toEqual([
        'action',
        'addressedToMe',
        'auditId',
        'byteLength',
        'eventKind',
        'gateRejected',
        'groupIdHex',
        'matchedInterests',
        'messageId',
        'reason',
        'receivedAt',
        'senderFingerprint',
        'senderTrusted',
      ]);
    }
  });
});

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v, (_k, val) =>
      val instanceof Uint8Array ? `Uint8Array(${val.length})` : val,
    );
  } catch {
    return String(v);
  }
}
