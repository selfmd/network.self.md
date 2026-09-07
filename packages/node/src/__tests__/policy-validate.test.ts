import { describe, it, expect } from 'vitest';
import { POLICY_REASONS } from '@networkselfmd/core';
import type { PrivateInboundMessageEvent, PolicyReason } from '@networkselfmd/core';
import { validateInboundEvent } from '../policy/validate.js';

const VALID_GROUP_EVENT: PrivateInboundMessageEvent = {
  kind: 'group',
  messageId: 'm-1',
  groupId: new Uint8Array([0xaa, 0xbb]),
  senderPublicKey: new Uint8Array(32),
  senderFingerprint: 'fp1',
  plaintext: new TextEncoder().encode('hi'),
  timestamp: 1,
  receivedAt: 2,
};

describe('validateInboundEvent — fail-closed structural checks', () => {
  it('accepts a well-formed group event', () => {
    const r = validateInboundEvent(VALID_GROUP_EVENT);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.ev.kind).toBe('group');
  });

  it('accepts a well-formed dm event (groupId optional)', () => {
    const dm: PrivateInboundMessageEvent = { ...VALID_GROUP_EVENT, kind: 'dm', groupId: undefined };
    const r = validateInboundEvent(dm);
    expect(r.ok).toBe(true);
  });

  it('rejects null / non-object payload as malformed-event', () => {
    expect(validateInboundEvent(null)).toEqual({ ok: false, reason: 'malformed-event' });
    expect(validateInboundEvent(undefined)).toEqual({ ok: false, reason: 'malformed-event' });
    expect(validateInboundEvent(42)).toEqual({ ok: false, reason: 'malformed-event' });
    expect(validateInboundEvent('a')).toEqual({ ok: false, reason: 'malformed-event' });
    expect(validateInboundEvent([])).toEqual({ ok: false, reason: 'malformed-event' });
  });

  it('rejects an unknown kind as unknown-event-kind', () => {
    const r = validateInboundEvent({ ...VALID_GROUP_EVENT, kind: 'invite' });
    expect(r).toEqual({ ok: false, reason: 'unknown-event-kind' });
  });

  it('rejects missing messageId', () => {
    const r = validateInboundEvent({ ...VALID_GROUP_EVENT, messageId: undefined });
    expect(r).toEqual({ ok: false, reason: 'malformed-event' });
  });

  it('rejects empty messageId / fingerprint', () => {
    expect(validateInboundEvent({ ...VALID_GROUP_EVENT, messageId: '' }))
      .toEqual({ ok: false, reason: 'malformed-event' });
    expect(validateInboundEvent({ ...VALID_GROUP_EVENT, senderFingerprint: '' }))
      .toEqual({ ok: false, reason: 'malformed-event' });
  });

  it('rejects plaintext that is not a Uint8Array', () => {
    expect(validateInboundEvent({ ...VALID_GROUP_EVENT, plaintext: 'oops' as unknown as Uint8Array }))
      .toEqual({ ok: false, reason: 'malformed-event' });
    expect(validateInboundEvent({ ...VALID_GROUP_EVENT, plaintext: [1, 2, 3] as unknown as Uint8Array }))
      .toEqual({ ok: false, reason: 'malformed-event' });
  });

  it('rejects senderPublicKey that is not a Uint8Array', () => {
    const r = validateInboundEvent({
      ...VALID_GROUP_EVENT,
      senderPublicKey: 'beefcafe' as unknown as Uint8Array,
    });
    expect(r).toEqual({ ok: false, reason: 'malformed-event' });
  });

  it('rejects non-finite numeric fields', () => {
    expect(validateInboundEvent({ ...VALID_GROUP_EVENT, timestamp: NaN }))
      .toEqual({ ok: false, reason: 'malformed-event' });
    expect(validateInboundEvent({ ...VALID_GROUP_EVENT, receivedAt: Infinity }))
      .toEqual({ ok: false, reason: 'malformed-event' });
    expect(validateInboundEvent({ ...VALID_GROUP_EVENT, timestamp: 'now' as unknown as number }))
      .toEqual({ ok: false, reason: 'malformed-event' });
  });

  it('rejects group events without a groupId', () => {
    const r = validateInboundEvent({ ...VALID_GROUP_EVENT, groupId: undefined });
    expect(r).toEqual({ ok: false, reason: 'malformed-event' });
  });

  it('rejects groupId that is the wrong type', () => {
    const r = validateInboundEvent({ ...VALID_GROUP_EVENT, groupId: 'aabb' as unknown as Uint8Array });
    expect(r).toEqual({ ok: false, reason: 'malformed-event' });
  });

  it('rejects a payload with extra prototype pollution attempts safely', () => {
    const evil = Object.create({ kind: 'group' });
    evil.messageId = 'm';
    // No senderFingerprint, no plaintext, etc. → malformed.
    const r = validateInboundEvent(evil);
    expect(r.ok).toBe(false);
  });
});

describe('POLICY_REASONS — stable vocabulary', () => {
  it('contains all decision and fail-closed reasons; no duplicates', () => {
    const set = new Set<PolicyReason>(POLICY_REASONS);
    expect(set.size).toBe(POLICY_REASONS.length);
    // The exact set is the public contract; locking it here means a future
    // rename or addition shows up in this test as a deliberate change.
    const expected: ReadonlyArray<PolicyReason> = [
      'not-addressed',
      'addressed-and-trusted',
      'addressed-unknown-sender',
      'addressed-matches-interest',
      'trusted-interest-hit',
      'interest-hit',
      'trusted-no-signal',
      'malformed-event',
      'unknown-event-kind',
      'duplicate-event',
      'not-a-member',
    ];
    expect([...set].sort()).toEqual([...expected].sort());
  });
});
