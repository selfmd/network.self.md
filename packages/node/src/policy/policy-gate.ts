import { EventEmitter } from 'node:events';
import { createId } from '@paralleldrive/cuid2';
import type {
  PolicyAuditEntry,
  PolicyDecision,
  PolicyReason,
  PrivateInboundMessageEvent,
} from '@networkselfmd/core';
import type { AgentPolicy } from './agent-policy.js';
import type { PolicyAuditLog } from './audit-log.js';
import { validateInboundEvent } from './validate.js';

// External membership predicate. Inverted dependency keeps the gate
// trivially testable — pass any function, no real GroupRepository
// needed. Production wiring uses GroupRepository.getMembers under the
// hood.
export type IsMemberFn = (groupId: Uint8Array, publicKey: Uint8Array) => boolean;

export interface PolicyGateOptions {
  policy: AgentPolicy;
  audit: PolicyAuditLog;
  isMember: IsMemberFn;
  // Maximum messageIds to remember for dedup. Default: 10000.
  dedupSize?: number;
  // Injectable clock + id generator for deterministic tests.
  now?: () => number;
  auditIdGen?: () => string;
}

// What a gate run returns. `allowed: true` means downstream side effects
// (inboundQueue.push, public re-emit) MUST happen. `allowed: false` means
// they MUST NOT — and the audit entry already records why.
export type GateOutcome =
  | {
      allowed: true;
      ev: PrivateInboundMessageEvent;
      decision: PolicyDecision;
      entry: PolicyAuditEntry;
    }
  | {
      allowed: false;
      reason: PolicyReason;
      entry: PolicyAuditEntry;
    };

// PolicyGate: the chokepoint between authenticated/decrypted/persisted
// inbound events and any agent-runtime side effect.
//
// Order of operations (`evaluate`):
//   1. validate structure (fail-closed: malformed-event / unknown-event-kind)
//   2. check dedup set (fail-closed: duplicate-event)
//   3. for group events, recheck membership via injected predicate
//      (fail-closed: not-a-member)
//   4. invoke AgentPolicy.decide (pure; never throws on validated input)
//   5. record audit entry
//   6. mark messageId in dedup set — **only here**, after every prior
//      step has succeeded. If audit.record throws, dedup is not poisoned
//      and a legitimate retry will be re-evaluated.
//   7. emit('decision', decision); return GateOutcome
//
// `decide()` is never called on malformed/duplicate/non-member input —
// AgentPolicy stays pure and operates only on structurally valid events
// from authenticated peers.
export class PolicyGate extends EventEmitter {
  private policy: AgentPolicy;
  private audit: PolicyAuditLog;
  private isMember: IsMemberFn;
  private dedupSize: number;
  private now: () => number;
  private auditIdGen: () => string;

  // FIFO dedup: insertion-ordered Set of messageIds that have completed
  // a successful evaluation. Eviction at dedupSize+1 (oldest dropped).
  private dedup: Set<string> = new Set();

  constructor(opts: PolicyGateOptions) {
    super();
    this.policy = opts.policy;
    this.audit = opts.audit;
    this.isMember = opts.isMember;
    this.dedupSize = Math.max(1, opts.dedupSize ?? 10000);
    this.now = opts.now ?? Date.now;
    this.auditIdGen = opts.auditIdGen ?? createId;
  }

  evaluate(raw: unknown): GateOutcome {
    const receivedAt = this.now();

    // --- Step 1: structural validation ---
    const validation = validateInboundEvent(raw);
    if (!validation.ok) {
      const entry = this.recordReject(raw, receivedAt, validation.reason);
      return { allowed: false, reason: validation.reason, entry };
    }
    const ev = validation.ev;

    // --- Step 2: dedup ---
    if (this.dedup.has(ev.messageId)) {
      const entry = this.recordRejectFromEvent(ev, receivedAt, 'duplicate-event');
      return { allowed: false, reason: 'duplicate-event', entry };
    }

    // --- Step 3: membership recheck (group events only) ---
    if (ev.kind === 'group') {
      if (!ev.groupId) {
        // Defensive: validate already requires groupId for 'group' kind,
        // but be explicit so a future relaxation doesn't open a hole.
        const entry = this.recordRejectFromEvent(ev, receivedAt, 'malformed-event');
        return { allowed: false, reason: 'malformed-event', entry };
      }
      // Predicate may be backed by a database call. If it throws (db
      // hiccup, schema mismatch, etc.) we MUST fail closed: the gate
      // cannot decide membership, so the event is treated as a
      // non-member rejection. We still record an audit row so operators
      // see the failure pattern.
      let isMember: boolean;
      try {
        isMember = this.isMember(ev.groupId, ev.senderPublicKey);
      } catch {
        const entry = this.recordRejectFromEvent(ev, receivedAt, 'not-a-member');
        return { allowed: false, reason: 'not-a-member', entry };
      }
      if (!isMember) {
        const entry = this.recordRejectFromEvent(ev, receivedAt, 'not-a-member');
        return { allowed: false, reason: 'not-a-member', entry };
      }
    }

    // --- Step 4: pure decision ---
    const decision = this.policy.decide(ev);

    // --- Step 5: record audit (metadata-only) ---
    const entry: PolicyAuditEntry = {
      auditId: this.auditIdGen(),
      receivedAt,
      eventKind: ev.kind,
      messageId: ev.messageId,
      groupIdHex: ev.groupId ? Buffer.from(ev.groupId).toString('hex') : undefined,
      senderFingerprint: ev.senderFingerprint,
      byteLength: ev.plaintext.byteLength,
      action: decision.action,
      reason: decision.reason,
      addressedToMe: decision.addressedToMe,
      senderTrusted: decision.senderTrusted,
      matchedInterests: decision.matchedInterests.slice(),
      gateRejected: false,
    };
    this.audit.record(entry);

    // --- Step 6: mark dedup ONLY now (post-audit) ---
    this.markDedup(ev.messageId);

    // --- Step 7: emit and return ---
    // Listener errors must not desynchronize the gate from its
    // downstream side effects. A buggy listener on 'decision' would
    // otherwise abort evaluate() before returning, leaving the audit
    // recorded but the queue untouched. Surface the bug on the next
    // microtask without breaking gate flow.
    try {
      this.emit('decision', decision);
    } catch (err) {
      queueMicrotask(() => {
        throw err;
      });
    }

    return decision.action === 'ignore'
      ? { allowed: false, reason: decision.reason, entry }
      : { allowed: true, ev, decision, entry };
  }

  // For tests / introspection. Not for production paths.
  isDuplicate(messageId: string): boolean {
    return this.dedup.has(messageId);
  }

  dedupCount(): number {
    return this.dedup.size;
  }

  private markDedup(messageId: string): void {
    this.dedup.add(messageId);
    if (this.dedup.size > this.dedupSize) {
      // Evict oldest insertion. Set preserves insertion order.
      const oldest = this.dedup.values().next().value;
      if (oldest !== undefined) this.dedup.delete(oldest);
    }
  }

  // Build an audit entry for a rejected raw payload (validation failure).
  // Pulls best-effort metadata from raw without trusting it.
  private recordReject(
    raw: unknown,
    receivedAt: number,
    reason: PolicyReason,
  ): PolicyAuditEntry {
    const obj =
      typeof raw === 'object' && raw !== null && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : undefined;
    const kindRaw = obj?.kind;
    const eventKind: PolicyAuditEntry['eventKind'] =
      kindRaw === 'group' || kindRaw === 'dm' ? kindRaw : 'unknown';
    const messageId = typeof obj?.messageId === 'string' && obj.messageId.length > 0
      ? (obj.messageId as string)
      : undefined;
    const senderFingerprint =
      typeof obj?.senderFingerprint === 'string' && obj.senderFingerprint.length > 0
        ? (obj.senderFingerprint as string)
        : undefined;
    const groupIdRaw = obj?.groupId;
    const groupIdHex =
      groupIdRaw instanceof Uint8Array ? Buffer.from(groupIdRaw).toString('hex') : undefined;
    const plaintext = obj?.plaintext;
    const byteLength = plaintext instanceof Uint8Array ? plaintext.byteLength : 0;

    const entry: PolicyAuditEntry = {
      auditId: this.auditIdGen(),
      receivedAt,
      eventKind,
      messageId,
      groupIdHex,
      senderFingerprint,
      byteLength,
      action: 'ignore',
      reason,
      addressedToMe: false,
      senderTrusted: false,
      matchedInterests: [],
      gateRejected: true,
    };
    this.audit.record(entry);
    return entry;
  }

  // Build a reject audit entry from a validated event (post-validation
  // gate failures: duplicate-event, not-a-member, defensive
  // malformed-event after validate).
  private recordRejectFromEvent(
    ev: PrivateInboundMessageEvent,
    receivedAt: number,
    reason: PolicyReason,
  ): PolicyAuditEntry {
    const entry: PolicyAuditEntry = {
      auditId: this.auditIdGen(),
      receivedAt,
      eventKind: ev.kind,
      messageId: ev.messageId,
      groupIdHex: ev.groupId ? Buffer.from(ev.groupId).toString('hex') : undefined,
      senderFingerprint: ev.senderFingerprint,
      byteLength: ev.plaintext.byteLength,
      action: 'ignore',
      reason,
      addressedToMe: false,
      senderTrusted: false,
      matchedInterests: [],
      gateRejected: true,
    };
    this.audit.record(entry);
    return entry;
  }
}
