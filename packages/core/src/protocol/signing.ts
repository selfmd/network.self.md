import { sign, verify } from '../crypto/signatures.js';
import { encodeMessage } from './messages.js';
import type { ProtocolMessage } from './types.js';

/**
 * A signable ProtocolMessage is one whose type carries an Ed25519 `signature`
 * field. Signing computes the signature over the canonical encoding of the
 * message with the `signature` field set to a zero-length placeholder.
 */
type Signable = Extract<ProtocolMessage, { signature: Uint8Array }>;

const EMPTY = new Uint8Array(0);

function canonicalSigningBytes(message: Signable): Uint8Array {
  const withZeroSig = { ...message, signature: EMPTY };
  return encodeMessage(withZeroSig as ProtocolMessage);
}

export function signMessage<M extends Signable>(
  message: Omit<M, 'signature'> & { signature?: Uint8Array },
  privateKey: Uint8Array,
): M {
  const unsigned = { ...message, signature: EMPTY } as unknown as M;
  const bytes = canonicalSigningBytes(unsigned);
  const signature = sign(bytes, privateKey);
  return { ...(unsigned as object), signature } as M;
}

export function verifyMessageSignature(
  message: Signable,
  publicKey: Uint8Array,
): boolean {
  if (!message.signature || message.signature.length === 0) {
    return false;
  }
  const bytes = canonicalSigningBytes(message);
  return verify(message.signature, bytes, publicKey);
}
