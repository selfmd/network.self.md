import { ed25519 } from '@noble/curves/ed25519';

export function sign(message: Uint8Array, privateKey: Uint8Array): Uint8Array {
  return ed25519.sign(message, privateKey);
}

export function verify(
  signature: Uint8Array,
  message: Uint8Array,
  publicKey: Uint8Array
): boolean {
  try {
    return ed25519.verify(signature, message, publicKey);
  } catch {
    return false;
  }
}
