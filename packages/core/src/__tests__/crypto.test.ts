import { describe, it, expect } from 'vitest';
import { encrypt, decrypt } from '../crypto/aead.js';
import { deriveKey, advanceChain } from '../crypto/kdf.js';
import { sign, verify } from '../crypto/signatures.js';
import { randomBytes } from '@noble/hashes/utils';
import { ed25519 } from '@noble/curves/ed25519';

describe('AEAD (XChaCha20-Poly1305)', () => {
  it('encrypts and decrypts roundtrip', () => {
    const key = randomBytes(32);
    const plaintext = new TextEncoder().encode('hello, world!');
    const { ciphertext, nonce } = encrypt(key, plaintext);
    const decrypted = decrypt(key, nonce, ciphertext);
    expect(decrypted).toEqual(plaintext);
  });

  it('fails with wrong key', () => {
    const key = randomBytes(32);
    const wrongKey = randomBytes(32);
    const plaintext = new TextEncoder().encode('secret');
    const { ciphertext, nonce } = encrypt(key, plaintext);
    expect(() => decrypt(wrongKey, nonce, ciphertext)).toThrow();
  });

  it('fails with tampered ciphertext', () => {
    const key = randomBytes(32);
    const plaintext = new TextEncoder().encode('secret');
    const { ciphertext, nonce } = encrypt(key, plaintext);
    ciphertext[0] ^= 0xff;
    expect(() => decrypt(key, nonce, ciphertext)).toThrow();
  });

  it('produces different ciphertexts for same plaintext (random nonce)', () => {
    const key = randomBytes(32);
    const plaintext = new TextEncoder().encode('same message');
    const r1 = encrypt(key, plaintext);
    const r2 = encrypt(key, plaintext);
    expect(r1.nonce).not.toEqual(r2.nonce);
    expect(r1.ciphertext).not.toEqual(r2.ciphertext);
  });
});

describe('KDF', () => {
  it('deriveKey produces deterministic output', () => {
    const ikm = randomBytes(32);
    const k1 = deriveKey(ikm, 'salt', 'info', 32);
    const k2 = deriveKey(ikm, 'salt', 'info', 32);
    expect(k1).toEqual(k2);
  });

  it('deriveKey produces different output with different salt', () => {
    const ikm = randomBytes(32);
    const k1 = deriveKey(ikm, 'salt1', 'info', 32);
    const k2 = deriveKey(ikm, 'salt2', 'info', 32);
    expect(k1).not.toEqual(k2);
  });

  it('advanceChain produces different message and chain keys', () => {
    const chainKey = randomBytes(32);
    const { messageKey, nextChainKey } = advanceChain(chainKey);
    expect(messageKey).not.toEqual(nextChainKey);
    expect(messageKey.length).toBe(32);
    expect(nextChainKey.length).toBe(32);
  });

  it('advanceChain is deterministic', () => {
    const chainKey = randomBytes(32);
    const r1 = advanceChain(chainKey);
    const r2 = advanceChain(chainKey);
    expect(r1.messageKey).toEqual(r2.messageKey);
    expect(r1.nextChainKey).toEqual(r2.nextChainKey);
  });
});

describe('Signatures', () => {
  it('sign and verify roundtrip', () => {
    const privateKey = randomBytes(32);
    const publicKey = ed25519.getPublicKey(privateKey);
    const message = new TextEncoder().encode('sign me');
    const signature = sign(message, privateKey);
    expect(verify(signature, message, publicKey)).toBe(true);
  });

  it('verify fails with wrong public key', () => {
    const privateKey = randomBytes(32);
    const wrongPublicKey = ed25519.getPublicKey(randomBytes(32));
    const message = new TextEncoder().encode('sign me');
    const signature = sign(message, privateKey);
    expect(verify(signature, message, wrongPublicKey)).toBe(false);
  });

  it('verify fails with tampered message', () => {
    const privateKey = randomBytes(32);
    const publicKey = ed25519.getPublicKey(privateKey);
    const message = new TextEncoder().encode('original');
    const tampered = new TextEncoder().encode('tampered');
    const signature = sign(message, privateKey);
    expect(verify(signature, tampered, publicKey)).toBe(false);
  });
});
