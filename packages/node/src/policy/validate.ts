import type {
  InboundMessageKind,
  PrivateInboundMessageEvent,
  PolicyFailClosedReason,
} from '@networkselfmd/core';

// Result of validating an opaque inbound payload. `ok: true` narrows the
// payload to a fully-typed PrivateInboundMessageEvent. Otherwise `reason`
// is a fail-closed PolicyReason that the gate must surface to the audit
// log without ever invoking AgentPolicy.decide().
export type ValidationResult =
  | { ok: true; ev: PrivateInboundMessageEvent }
  | { ok: false; reason: Extract<PolicyFailClosedReason, 'malformed-event' | 'unknown-event-kind'> };

const VALID_KINDS: ReadonlySet<InboundMessageKind> = new Set(['group', 'dm']);

// Strict, structural validation. Pure. No I/O, no logging.
//
// We accept `unknown` deliberately — the gate is a trust boundary even
// against in-process callers. TypeScript prevents most accidental misuse,
// but the gate must still hold under direct injection (test code, future
// transports). We never trust the type system at this seam.
export function validateInboundEvent(raw: unknown): ValidationResult {
  if (!isPlainObject(raw)) {
    return { ok: false, reason: 'malformed-event' };
  }

  const kind = (raw as { kind?: unknown }).kind;
  if (typeof kind !== 'string') {
    return { ok: false, reason: 'malformed-event' };
  }
  if (!VALID_KINDS.has(kind as InboundMessageKind)) {
    return { ok: false, reason: 'unknown-event-kind' };
  }

  if (
    !isString((raw as { messageId?: unknown }).messageId) ||
    !isString((raw as { senderFingerprint?: unknown }).senderFingerprint) ||
    !isUint8Array((raw as { senderPublicKey?: unknown }).senderPublicKey) ||
    !isUint8Array((raw as { plaintext?: unknown }).plaintext) ||
    !isFiniteNumber((raw as { timestamp?: unknown }).timestamp) ||
    !isFiniteNumber((raw as { receivedAt?: unknown }).receivedAt)
  ) {
    return { ok: false, reason: 'malformed-event' };
  }

  // groupId is optional but, when present, must be a Uint8Array.
  const groupId = (raw as { groupId?: unknown }).groupId;
  if (groupId !== undefined && !isUint8Array(groupId)) {
    return { ok: false, reason: 'malformed-event' };
  }

  // For 'group' kind, groupId is required.
  if (kind === 'group' && !isUint8Array(groupId)) {
    return { ok: false, reason: 'malformed-event' };
  }

  // Empty messageId/fingerprint would let an attacker forge a
  // collision-prone audit identity. Reject them as malformed.
  if (
    (raw as { messageId: string }).messageId.length === 0 ||
    (raw as { senderFingerprint: string }).senderFingerprint.length === 0
  ) {
    return { ok: false, reason: 'malformed-event' };
  }

  return {
    ok: true,
    ev: raw as unknown as PrivateInboundMessageEvent,
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isUint8Array(v: unknown): v is Uint8Array {
  return v instanceof Uint8Array;
}
