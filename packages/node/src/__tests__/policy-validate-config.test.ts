import { describe, it, expect } from 'vitest';
import {
  validatePolicyConfig,
  POLICY_LIMITS,
  formatValidationErrors,
  PolicyConfigValidationError,
} from '../policy/validate-config.js';

describe('validatePolicyConfig — happy path', () => {
  it('accepts an empty object as a valid (no-op) config', () => {
    const r = validatePolicyConfig({});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config).toEqual({});
  });

  it('accepts a fully-populated config and trims/lowercases fingerprints', () => {
    const r = validatePolicyConfig({
      trustedFingerprints: ['  ABC1234 ', 'def5678 '],
      interests: ['  Coffee ', '  meeting'],
      requireMention: true,
      mentionPrefixLen: 8,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config).toEqual({
        trustedFingerprints: ['abc1234', 'def5678'],
        interests: ['Coffee', 'meeting'],
        requireMention: true,
        mentionPrefixLen: 8,
      });
    }
  });

  it('deduplicates fingerprints and interests preserving order', () => {
    const r = validatePolicyConfig({
      trustedFingerprints: ['abcd', 'abcd', 'efgh'],
      interests: ['k', 'k', 'k', 'q'],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.trustedFingerprints).toEqual(['abcd', 'efgh']);
      expect(r.config.interests).toEqual(['k', 'q']);
    }
  });

  it('strips unknown extra keys from the input', () => {
    const r = validatePolicyConfig({
      interests: ['x'],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      attackerKey: 'PWNED',
    } as any);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config).toEqual({ interests: ['x'] });
      expect(r.config).not.toHaveProperty('attackerKey');
    }
  });
});

describe('validatePolicyConfig — fail-closed paths', () => {
  it('rejects null/undefined/non-objects', () => {
    expect(validatePolicyConfig(null).ok).toBe(false);
    expect(validatePolicyConfig(undefined).ok).toBe(false);
    expect(validatePolicyConfig(42).ok).toBe(false);
    expect(validatePolicyConfig('hi').ok).toBe(false);
    expect(validatePolicyConfig([]).ok).toBe(false);
  });

  it('rejects non-array trustedFingerprints', () => {
    const r = validatePolicyConfig({ trustedFingerprints: 'fp1' });
    expect(r.ok).toBe(false);
  });

  it('rejects fingerprints with bad shape (symbols, whitespace, too short, too long)', () => {
    // Mixed case is normalized to lowercase, not rejected — operators
    // pasting from UIs commonly uppercase.
    const upper = validatePolicyConfig({ trustedFingerprints: ['BadCaps'] });
    expect(upper.ok).toBe(true);
    if (upper.ok) expect(upper.config.trustedFingerprints).toEqual(['badcaps']);

    expect(validatePolicyConfig({ trustedFingerprints: ['has space'] }).ok).toBe(false);
    expect(validatePolicyConfig({ trustedFingerprints: ['hyphen-no'] }).ok).toBe(false);
    expect(validatePolicyConfig({ trustedFingerprints: ['x'] }).ok).toBe(false); // < min
    expect(
      validatePolicyConfig({ trustedFingerprints: ['a'.repeat(POLICY_LIMITS.maxFingerprintLength + 1)] }).ok,
    ).toBe(false);
  });

  it('rejects too many fingerprints', () => {
    const fps = Array.from({ length: POLICY_LIMITS.maxTrustedFingerprints + 1 }, (_, i) =>
      `fp${String(i).padStart(4, '0')}`,
    );
    const r = validatePolicyConfig({ trustedFingerprints: fps });
    expect(r.ok).toBe(false);
  });

  it('rejects empty / oversized interests', () => {
    expect(validatePolicyConfig({ interests: [''] }).ok).toBe(false);
    expect(
      validatePolicyConfig({ interests: ['a'.repeat(POLICY_LIMITS.maxInterestLength + 1)] }).ok,
    ).toBe(false);
    const many = Array.from({ length: POLICY_LIMITS.maxInterests + 1 }, () => 'k');
    expect(validatePolicyConfig({ interests: many }).ok).toBe(false);
  });

  it('rejects non-boolean requireMention', () => {
    expect(validatePolicyConfig({ requireMention: 'yes' }).ok).toBe(false);
    expect(validatePolicyConfig({ requireMention: 1 }).ok).toBe(false);
  });

  it('rejects out-of-range / non-integer mentionPrefixLen', () => {
    expect(validatePolicyConfig({ mentionPrefixLen: 0 }).ok).toBe(false);
    expect(validatePolicyConfig({ mentionPrefixLen: -1 }).ok).toBe(false);
    expect(validatePolicyConfig({ mentionPrefixLen: 1.5 }).ok).toBe(false);
    expect(validatePolicyConfig({ mentionPrefixLen: 65 }).ok).toBe(false);
    expect(validatePolicyConfig({ mentionPrefixLen: 'eight' }).ok).toBe(false);
  });

  it('aggregates multiple errors instead of stopping at the first', () => {
    const r = validatePolicyConfig({
      trustedFingerprints: ['has space'],
      interests: [''],
      requireMention: 'no',
      mentionPrefixLen: 9999,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const fields = r.errors.map((e) => e.field);
      expect(fields).toContain('trustedFingerprints');
      expect(fields).toContain('interests');
      expect(fields).toContain('requireMention');
      expect(fields).toContain('mentionPrefixLen');
    }
  });
});

describe('formatValidationErrors / PolicyConfigValidationError', () => {
  it('renders human-readable errors with the offending field', () => {
    const r = validatePolicyConfig({ trustedFingerprints: ['has space'] });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const msg = formatValidationErrors(r.errors);
      expect(msg).toContain('invalid PolicyConfig');
      expect(msg).toContain('trustedFingerprints');
    }
  });

  it('PolicyConfigValidationError carries the structured errors and a message', () => {
    const err = new PolicyConfigValidationError([
      { field: 'requireMention', message: 'must be a boolean' },
    ]);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('PolicyConfigValidationError');
    expect(err.errors).toHaveLength(1);
    expect(err.message).toMatch(/requireMention/);
  });
});
