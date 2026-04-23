import { ed25519 } from '@noble/curves/ed25519';
import { edwardsToMontgomery, edwardsToMontgomeryPriv } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { randomBytes } from '@noble/hashes/utils';
import type { AgentIdentity } from './protocol/types.js';

const Z_BASE_32_ALPHABET = 'ybndrfg8ejkmcpqxot1uwisza345h769';

export function zBase32Encode(data: Uint8Array): string {
  let bits = 0;
  let buffer = 0;
  let result = '';

  for (const byte of data) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += Z_BASE_32_ALPHABET[(buffer >>> bits) & 0x1f];
    }
  }

  if (bits > 0) {
    result += Z_BASE_32_ALPHABET[(buffer << (5 - bits)) & 0x1f];
  }

  return result;
}

export function fingerprintFromPublicKey(edPublicKey: Uint8Array): string {
  const hash = sha256(edPublicKey);
  const truncated = hash.slice(0, 20);
  return zBase32Encode(truncated);
}

export function generateIdentity(displayName?: string): AgentIdentity {
  const edPrivateKey = randomBytes(32);
  const edPublicKey = ed25519.getPublicKey(edPrivateKey);
  const xPublicKey = edwardsToMontgomery(edPublicKey);
  const xPrivateKey = edwardsToMontgomeryPriv(edPrivateKey);
  const fingerprint = fingerprintFromPublicKey(edPublicKey);

  return {
    edPrivateKey,
    edPublicKey,
    xPrivateKey,
    xPublicKey,
    fingerprint,
    displayName,
  };
}
