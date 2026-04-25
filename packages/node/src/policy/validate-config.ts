import type { PolicyConfig } from '@networkselfmd/core';

// Hard caps on operator-supplied configuration. Generous but bounded so
// a buggy CLI / MCP client cannot bloat the runtime config or the
// persisted row.
export const POLICY_LIMITS = Object.freeze({
  // Max number of trusted fingerprint entries.
  maxTrustedFingerprints: 256,
  // Max chars in a single fingerprint string.
  maxFingerprintLength: 64,
  // Min chars in a single fingerprint string. The protocol's fingerprint
  // (z-base32 of 32 bytes) is ~52 chars; we accept any non-empty,
  // reasonably-shaped string ≥4 to keep tests lean.
  minFingerprintLength: 4,
  // Max number of interest keywords.
  maxInterests: 256,
  // Max chars in a single interest keyword.
  maxInterestLength: 64,
  // Allowed range for mentionPrefixLen.
  minMentionPrefixLen: 1,
  maxMentionPrefixLen: 64,
} as const);

// Lowercase z-base32-friendly alphanumeric characters. Strict here
// because the matching code in agent-policy.ts already lowercases for
// case-insensitive compares; permitting uppercase or symbols would
// silently change matching behavior.
const FINGERPRINT_RE = /^[a-z0-9]+$/;

export type ValidationError = {
  field: keyof PolicyConfig | 'config';
  message: string;
};

export type ValidatedConfig =
  | { ok: true; config: PolicyConfig }
  | { ok: false; errors: ValidationError[] };

// Pure structural / range validator for PolicyConfig. Accepts unknown
// because operators feed configs in via JSON / CLI flags / MCP — the
// type system can't be trusted at this seam.
//
// Returns a sanitized PolicyConfig with any unknown extra keys
// stripped, OR a list of human-readable errors. Never mutates the
// input; safe to call from anywhere.
export function validatePolicyConfig(raw: unknown): ValidatedConfig {
  const errors: ValidationError[] = [];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: [{ field: 'config', message: 'must be an object' }] };
  }
  const obj = raw as Record<string, unknown>;
  const sanitized: PolicyConfig = {};

  if (obj.trustedFingerprints !== undefined) {
    const fps = obj.trustedFingerprints;
    if (!Array.isArray(fps)) {
      errors.push({ field: 'trustedFingerprints', message: 'must be an array of strings' });
    } else if (fps.length > POLICY_LIMITS.maxTrustedFingerprints) {
      errors.push({
        field: 'trustedFingerprints',
        message: `too many entries (max ${POLICY_LIMITS.maxTrustedFingerprints})`,
      });
    } else {
      const cleaned: string[] = [];
      let bad = false;
      for (const entry of fps) {
        if (typeof entry !== 'string') {
          errors.push({ field: 'trustedFingerprints', message: 'entries must be strings' });
          bad = true;
          break;
        }
        const trimmed = entry.trim().toLowerCase();
        if (
          trimmed.length < POLICY_LIMITS.minFingerprintLength ||
          trimmed.length > POLICY_LIMITS.maxFingerprintLength ||
          !FINGERPRINT_RE.test(trimmed)
        ) {
          errors.push({
            field: 'trustedFingerprints',
            message: `invalid fingerprint shape: ${truncate(trimmed, 20)}`,
          });
          bad = true;
          break;
        }
        cleaned.push(trimmed);
      }
      if (!bad) {
        // Dedup while preserving order.
        sanitized.trustedFingerprints = Array.from(new Set(cleaned));
      }
    }
  }

  if (obj.interests !== undefined) {
    const items = obj.interests;
    if (!Array.isArray(items)) {
      errors.push({ field: 'interests', message: 'must be an array of strings' });
    } else if (items.length > POLICY_LIMITS.maxInterests) {
      errors.push({
        field: 'interests',
        message: `too many entries (max ${POLICY_LIMITS.maxInterests})`,
      });
    } else {
      const cleaned: string[] = [];
      let bad = false;
      for (const entry of items) {
        if (typeof entry !== 'string') {
          errors.push({ field: 'interests', message: 'entries must be strings' });
          bad = true;
          break;
        }
        const trimmed = entry.trim();
        if (trimmed.length === 0 || trimmed.length > POLICY_LIMITS.maxInterestLength) {
          errors.push({
            field: 'interests',
            message: `invalid interest length: ${truncate(trimmed, 20)}`,
          });
          bad = true;
          break;
        }
        cleaned.push(trimmed);
      }
      if (!bad) {
        sanitized.interests = Array.from(new Set(cleaned));
      }
    }
  }

  if (obj.requireMention !== undefined) {
    if (typeof obj.requireMention !== 'boolean') {
      errors.push({ field: 'requireMention', message: 'must be a boolean' });
    } else {
      sanitized.requireMention = obj.requireMention;
    }
  }

  if (obj.mentionPrefixLen !== undefined) {
    const n = obj.mentionPrefixLen;
    if (
      typeof n !== 'number' ||
      !Number.isInteger(n) ||
      n < POLICY_LIMITS.minMentionPrefixLen ||
      n > POLICY_LIMITS.maxMentionPrefixLen
    ) {
      errors.push({
        field: 'mentionPrefixLen',
        message: `must be an integer in [${POLICY_LIMITS.minMentionPrefixLen}, ${POLICY_LIMITS.maxMentionPrefixLen}]`,
      });
    } else {
      sanitized.mentionPrefixLen = n;
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, config: sanitized };
}

// Render a list of errors into a single readable string for throw / CLI
// output. Stable, no plaintext, no contextual data beyond field/message.
export function formatValidationErrors(errors: ValidationError[]): string {
  return (
    'invalid PolicyConfig:\n' +
    errors.map((e) => `  - ${e.field}: ${e.message}`).join('\n')
  );
}

export class PolicyConfigValidationError extends Error {
  readonly errors: ValidationError[];
  constructor(errors: ValidationError[]) {
    super(formatValidationErrors(errors));
    this.name = 'PolicyConfigValidationError';
    this.errors = errors;
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + '…';
}
