import { describe, it, expect } from 'vitest';
import { generateIdentity, fingerprintFromPublicKey, zBase32Encode } from '../identity.js';

describe('identity', () => {
  it('generates a valid identity with all key fields', () => {
    const identity = generateIdentity('test-agent');
    expect(identity.edPrivateKey).toBeInstanceOf(Uint8Array);
    expect(identity.edPublicKey).toBeInstanceOf(Uint8Array);
    expect(identity.xPrivateKey).toBeInstanceOf(Uint8Array);
    expect(identity.xPublicKey).toBeInstanceOf(Uint8Array);
    expect(identity.edPrivateKey.length).toBe(32);
    expect(identity.edPublicKey.length).toBe(32);
    expect(identity.xPrivateKey.length).toBe(32);
    expect(identity.xPublicKey.length).toBe(32);
    expect(typeof identity.fingerprint).toBe('string');
    expect(identity.fingerprint.length).toBeGreaterThan(0);
    expect(identity.displayName).toBe('test-agent');
  });

  it('generates unique identities each time', () => {
    const a = generateIdentity();
    const b = generateIdentity();
    expect(a.fingerprint).not.toBe(b.fingerprint);
    expect(a.edPublicKey).not.toEqual(b.edPublicKey);
  });

  it('fingerprint is deterministic from the same public key', () => {
    const identity = generateIdentity();
    const fp1 = fingerprintFromPublicKey(identity.edPublicKey);
    const fp2 = fingerprintFromPublicKey(identity.edPublicKey);
    expect(fp1).toBe(fp2);
    expect(fp1).toBe(identity.fingerprint);
  });

  it('z-base-32 encodes correctly', () => {
    // z-base-32 uses alphabet: ybndrfg8ejkmcpqxot1uwisza345h769
    const bytes = new Uint8Array([0]);
    const encoded = zBase32Encode(bytes);
    expect(encoded).toBe('yy'); // 00000 000 → 'y' 'y' (padded)
  });

  it('generates identity without display name', () => {
    const identity = generateIdentity();
    expect(identity.displayName).toBeUndefined();
  });
});
