export type PolicyAction = 'act' | 'ask' | 'ignore';

// Fixed, metadata-safe reason tokens. Never include plaintext content.
export type PolicyReason =
  | 'not-addressed'
  | 'addressed-and-trusted'
  | 'addressed-unknown-sender'
  | 'addressed-matches-interest'
  | 'trusted-interest-hit'
  | 'interest-hit'
  | 'trusted-no-signal';

// Output of AgentPolicy.decide — safe to log in full; contains no plaintext.
export interface PolicyDecision {
  messageId: string;
  action: PolicyAction;
  reason: PolicyReason;
  matchedInterests: string[];
  addressedToMe: boolean;
  senderTrusted: boolean;
}

export interface PolicyConfig {
  // Peer fingerprints considered trusted (full fingerprint string as emitted
  // by `fingerprintFromPublicKey`).
  trustedFingerprints?: string[];
  // Interest keywords — cheap case-insensitive substring match over the
  // UTF-8 decode of the inbound plaintext. Empty/undefined = no interests.
  interests?: string[];
  // If true (default), "addressed to me" requires an explicit
  // `@<fingerprint-prefix>` or `@<displayName>` mention. If false, every
  // group message we receive counts as addressed.
  requireMention?: boolean;
  // Characters of the leading fingerprint that count as a valid mention
  // (e.g. 8 → `@alice7x2a`). Default: 8.
  mentionPrefixLen?: number;
}
