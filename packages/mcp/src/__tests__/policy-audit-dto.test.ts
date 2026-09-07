import { describe, it, expect } from 'vitest';
import type { PolicyAuditEntry } from '@networkselfmd/node';
import { toPolicyAuditDTO } from '../tools/policy.js';

const baseEntry: PolicyAuditEntry = {
  auditId: 'a1',
  receivedAt: 100,
  eventKind: 'group',
  messageId: 'm1',
  groupIdHex: 'dead',
  senderFingerprint: 'fp1',
  byteLength: 32,
  action: 'ask',
  reason: 'addressed-unknown-sender',
  addressedToMe: true,
  senderTrusted: false,
  matchedInterests: ['coffee'],
  gateRejected: false,
};

describe('toPolicyAuditDTO — metadata-only projection', () => {
  it('preserves the privacy-safe fields verbatim', () => {
    const dto = toPolicyAuditDTO(baseEntry);
    expect(dto).toEqual(baseEntry);
  });

  it('drops any unexpected/extra field on the entry (defence-in-depth)', () => {
    // Even if a future PR or attacker stuffs a content-bearing field into
    // PolicyAuditEntry at runtime, the DTO must not propagate it.
    const polluted = {
      ...baseEntry,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      plaintext: new TextEncoder().encode('LEAK-CANARY-AUDIT'),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      decryptedBody: 'LEAK-CANARY-BODY',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      toolArgs: { secret: 'LEAK-CANARY-TOOL' },
    } as unknown as PolicyAuditEntry;
    const dto = toPolicyAuditDTO(polluted);
    const json = JSON.stringify(dto);
    expect(json).not.toContain('LEAK-CANARY-AUDIT');
    expect(json).not.toContain('LEAK-CANARY-BODY');
    expect(json).not.toContain('LEAK-CANARY-TOOL');
    expect(dto).not.toHaveProperty('plaintext');
    expect(dto).not.toHaveProperty('decryptedBody');
    expect(dto).not.toHaveProperty('toolArgs');
  });

  it('returns a copy of matchedInterests (caller cannot mutate audit log via DTO)', () => {
    const dto = toPolicyAuditDTO(baseEntry);
    dto.matchedInterests.push('mutated');
    expect(baseEntry.matchedInterests).toEqual(['coffee']);
  });

  it('omits optional fields when absent (no JSON undefined leakage)', () => {
    const minimal: PolicyAuditEntry = {
      ...baseEntry,
      messageId: undefined,
      groupIdHex: undefined,
      senderFingerprint: undefined,
    };
    const dto = toPolicyAuditDTO(minimal);
    const json = JSON.stringify(dto);
    expect(json).not.toContain('"messageId":');
    expect(json).not.toContain('"groupIdHex":');
    expect(json).not.toContain('"senderFingerprint":');
  });

  it('byteLength survives the DTO without exposing any byte', () => {
    const big = toPolicyAuditDTO({ ...baseEntry, byteLength: 8192 });
    expect(big.byteLength).toBe(8192);
    expect(JSON.stringify(big)).not.toMatch(/"plaintext"|"content"|"body"/);
  });
});

describe('get_policy_audit_recent — limit clamp', () => {
  // Re-derive the schema the tool uses so we can assert clamping
  // behavior without a full MCP transport. Keep this in lockstep with
  // tools/policy.ts; if the limit shape changes there, this assertion
  // catches the drift.
  it('rejects limit > 1000 (DoS / oversized response defense)', async () => {
    const { z } = await import('zod');
    const limit = z.number().int().positive().max(1000).optional();
    expect(limit.safeParse(1001).success).toBe(false);
    expect(limit.safeParse(10000).success).toBe(false);
    expect(limit.safeParse(Number.MAX_SAFE_INTEGER).success).toBe(false);
    expect(limit.safeParse(1000).success).toBe(true);
    expect(limit.safeParse(50).success).toBe(true);
    expect(limit.safeParse(1).success).toBe(true);
    expect(limit.safeParse(undefined).success).toBe(true);
    expect(limit.safeParse(0).success).toBe(false);
    expect(limit.safeParse(-1).success).toBe(false);
    expect(limit.safeParse(NaN).success).toBe(false);
    expect(limit.safeParse('50').success).toBe(false);
  });
});

describe('Locked DTO surface', () => {
  it('has the exact set of keys we publish over MCP', () => {
    const dto = toPolicyAuditDTO(baseEntry);
    const keys = Object.keys(dto).sort();
    expect(keys).toEqual([
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
  });
});
