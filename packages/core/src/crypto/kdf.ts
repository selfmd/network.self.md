import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { x25519 } from '@noble/curves/ed25519';

export function deriveKey(
  ikm: Uint8Array,
  salt: string | Uint8Array,
  info: string,
  length: number
): Uint8Array {
  return hkdf(sha256, ikm, salt, info, length);
}

/**
 * Compute X25519 ECDH shared secret between two peers and derive
 * a root key suitable for Double Ratchet initialization.
 */
export function computeSharedSecret(
  myXPrivateKey: Uint8Array,
  peerXPublicKey: Uint8Array
): Uint8Array {
  const rawSharedSecret = x25519.getSharedSecret(myXPrivateKey, peerXPublicKey);
  return deriveKey(rawSharedSecret, 'networkselfmd-dm-v1', '', 32);
}

export function advanceChain(chainKey: Uint8Array): {
  messageKey: Uint8Array;
  nextChainKey: Uint8Array;
} {
  const messageKey = hkdf(sha256, chainKey, 'networkselfmd-msg-v1', '', 32);
  const nextChainKey = hkdf(sha256, chainKey, 'networkselfmd-chain-v1', '', 32);
  return { messageKey, nextChainKey };
}
