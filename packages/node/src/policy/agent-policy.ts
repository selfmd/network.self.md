import { EventEmitter } from 'node:events';
import type {
  PolicyAction,
  PolicyConfig,
  PolicyDecision,
  PolicyReason,
  PrivateInboundMessageEvent,
} from '@networkselfmd/core';
import type { Agent } from '../agent.js';

export interface AgentPolicyOptions {
  agent: Agent;
  config: PolicyConfig;
}

// Minimal policy runner: consume InboundEventQueue → produce act | ask |
// ignore decisions via cheap filters. No tool execution yet; the caller
// wires `.on('decision', ...)` to whatever handler layer they choose.
//
// `decide()` is a pure function over (self identity, config, event). No
// I/O, no Date.now(). Tests hit it directly.
export class AgentPolicy extends EventEmitter {
  private agent: Agent;
  private config: PolicyConfig;
  private unsubscribe?: () => void;

  constructor(options: AgentPolicyOptions) {
    super();
    this.agent = options.agent;
    this.config = options.config;
  }

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.agent.inboundQueue.on((ev) => {
      const decision = this.decide(ev);
      this.emit('decision', decision);
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  decide(ev: PrivateInboundMessageEvent): PolicyDecision {
    const text = tryDecodeUtf8(ev.plaintext);
    const fingerprint = this.agent.identity?.fingerprint;
    const displayName = this.agent.identity?.displayName;
    const prefixLen = this.config.mentionPrefixLen ?? 8;
    const requireMention = this.config.requireMention ?? true;

    const addressedToMe = computeAddressedToMe({
      text,
      kind: ev.kind,
      selfFingerprint: fingerprint,
      selfDisplayName: displayName,
      requireMention,
      prefixLen,
    });

    const senderTrusted =
      this.config.trustedFingerprints?.includes(ev.senderFingerprint) ?? false;

    const matchedInterests = computeMatchedInterests(text, this.config.interests);
    const hasInterestHit = matchedInterests.length > 0;

    const { action, reason } = resolveDecision({
      addressedToMe,
      senderTrusted,
      hasInterestHit,
    });

    return {
      messageId: ev.messageId,
      action,
      reason,
      matchedInterests,
      addressedToMe,
      senderTrusted,
    };
  }
}

function tryDecodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

interface AddressedToMeInputs {
  text: string | undefined;
  kind: 'group' | 'dm';
  selfFingerprint: string | undefined;
  selfDisplayName: string | undefined;
  requireMention: boolean;
  prefixLen: number;
}

function computeAddressedToMe(i: AddressedToMeInputs): boolean {
  if (!i.requireMention && i.kind === 'group') return true;
  if (i.text === undefined) return false;
  if (!i.selfFingerprint) return false;

  const prefix = i.selfFingerprint.slice(0, Math.max(1, i.prefixLen));
  if (containsMention(i.text, prefix)) return true;
  if (i.selfDisplayName && containsMention(i.text, i.selfDisplayName)) return true;
  return false;
}

// Token-bounded match for `@<needle>`. The character immediately after the
// match must not be part of an identifier (letter/digit/underscore/hyphen)
// so `@alice7x2a` inside `@alice7x2abc` does not count.
function containsMention(haystack: string, needle: string): boolean {
  if (!needle) return false;
  const lowerHay = haystack.toLowerCase();
  const lowerNeedle = needle.toLowerCase();
  let from = 0;
  while (from < lowerHay.length) {
    const at = lowerHay.indexOf('@' + lowerNeedle, from);
    if (at === -1) return false;
    const next = lowerHay.charCodeAt(at + 1 + lowerNeedle.length);
    if (isNaN(next) || !isIdentifierChar(next)) return true;
    from = at + 1;
  }
  return false;
}

function isIdentifierChar(code: number): boolean {
  // a-z, 0-9, '_', '-'
  return (
    (code >= 97 && code <= 122) ||
    (code >= 48 && code <= 57) ||
    code === 95 ||
    code === 45
  );
}

function computeMatchedInterests(
  text: string | undefined,
  interests: string[] | undefined,
): string[] {
  if (!text || !interests || interests.length === 0) return [];
  const lower = text.toLowerCase();
  const hits: string[] = [];
  for (const kw of interests) {
    if (!kw) continue;
    if (lower.includes(kw.toLowerCase())) hits.push(kw);
  }
  return hits;
}

interface DecisionInputs {
  addressedToMe: boolean;
  senderTrusted: boolean;
  hasInterestHit: boolean;
}

function resolveDecision(
  i: DecisionInputs,
): { action: PolicyAction; reason: PolicyReason } {
  if (i.addressedToMe && i.senderTrusted) {
    return { action: 'act', reason: 'addressed-and-trusted' };
  }
  if (i.addressedToMe && i.hasInterestHit) {
    return { action: 'ask', reason: 'addressed-matches-interest' };
  }
  if (i.addressedToMe) {
    return { action: 'ask', reason: 'addressed-unknown-sender' };
  }
  if (i.senderTrusted && i.hasInterestHit) {
    return { action: 'ask', reason: 'trusted-interest-hit' };
  }
  if (i.hasInterestHit) {
    return { action: 'ask', reason: 'interest-hit' };
  }
  if (i.senderTrusted) {
    return { action: 'ignore', reason: 'trusted-no-signal' };
  }
  return { action: 'ignore', reason: 'not-addressed' };
}

// TODO(next-PR): wire per-interest / per-action handlers here. Keep
// `decide()` a pure function; execute side effects out-of-band from an
// on('decision', ...) consumer.
