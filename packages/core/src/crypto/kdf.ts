import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';

export function deriveKey(
  ikm: Uint8Array,
  salt: string | Uint8Array,
  info: string,
  length: number
): Uint8Array {
  return hkdf(sha256, ikm, salt, info, length);
}

export function advanceChain(chainKey: Uint8Array): {
  messageKey: Uint8Array;
  nextChainKey: Uint8Array;
} {
  const messageKey = hkdf(sha256, chainKey, 'networkselfmd-msg-v1', '', 32);
  const nextChainKey = hkdf(sha256, chainKey, 'networkselfmd-chain-v1', '', 32);
  return { messageKey, nextChainKey };
}
