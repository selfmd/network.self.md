import { describe, it, expect } from 'vitest';
import type { PolicyConfig } from '@networkselfmd/node';
import { toPolicyConfigDTO } from '../tools/policy.js';

describe('toPolicyConfigDTO — explicit projection', () => {
  it('preserves all four configurable fields verbatim', () => {
    const c: PolicyConfig = {
      trustedFingerprints: ['fp1abc', 'fp2def'],
      interests: ['coffee'],
      requireMention: true,
      mentionPrefixLen: 8,
    };
    expect(toPolicyConfigDTO(c)).toEqual(c);
  });

  it('omits unset (undefined) fields rather than emitting key:undefined', () => {
    const dto = toPolicyConfigDTO({ interests: ['only'] });
    const json = JSON.stringify(dto);
    expect(json).not.toContain('"trustedFingerprints":');
    expect(json).not.toContain('"requireMention":');
    expect(json).not.toContain('"mentionPrefixLen":');
    expect(json).toContain('"interests":');
  });

  it('drops attacker-injected extra fields (defence-in-depth)', () => {
    const polluted = {
      interests: ['x'],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      plaintext: 'LEAK-CFG-PLAINTEXT',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      privateKey: 'LEAK-CFG-KEY',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      messageContent: 'LEAK-CFG-CONTENT',
    } as unknown as PolicyConfig;
    const dto = toPolicyConfigDTO(polluted);
    const json = JSON.stringify(dto);
    expect(json).not.toContain('LEAK-CFG-PLAINTEXT');
    expect(json).not.toContain('LEAK-CFG-KEY');
    expect(json).not.toContain('LEAK-CFG-CONTENT');
    expect(dto).not.toHaveProperty('plaintext');
    expect(dto).not.toHaveProperty('privateKey');
    expect(dto).not.toHaveProperty('messageContent');
  });

  it('returned arrays are independent of the input', () => {
    const c: PolicyConfig = { interests: ['a'], trustedFingerprints: ['fp1abc'] };
    const dto = toPolicyConfigDTO(c);
    dto.interests?.push('mutated');
    dto.trustedFingerprints?.push('hijack');
    expect(c.interests).toEqual(['a']);
    expect(c.trustedFingerprints).toEqual(['fp1abc']);
  });

  it('locked DTO key set — adding a field requires a deliberate change here', () => {
    const dto = toPolicyConfigDTO({
      trustedFingerprints: [],
      interests: [],
      requireMention: false,
      mentionPrefixLen: 8,
    });
    expect(Object.keys(dto).sort()).toEqual([
      'interests',
      'mentionPrefixLen',
      'requireMention',
      'trustedFingerprints',
    ]);
  });
});
