import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { randomBytes } from '@noble/hashes/utils';

export function encrypt(
  key: Uint8Array,
  plaintext: Uint8Array
): { ciphertext: Uint8Array; nonce: Uint8Array } {
  const nonce = randomBytes(24);
  const cipher = xchacha20poly1305(key, nonce);
  const ciphertext = cipher.encrypt(plaintext);
  return { ciphertext, nonce };
}

export function decrypt(
  key: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array
): Uint8Array {
  const cipher = xchacha20poly1305(key, nonce);
  return cipher.decrypt(ciphertext);
}
