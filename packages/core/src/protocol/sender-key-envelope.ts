import { sha256 } from '@noble/hashes/sha256';
import { MessageType } from './types.js';
import type { SenderKeyDistributionMessage } from './types.js';

export const SENDER_KEY_ENVELOPE_VERSION = 2;
const DOMAIN = new TextEncoder().encode(
  'network.self.md/SenderKeyEnvelope/v2\0',
);

/** Stable replay identity for the opaque recipient-specific encrypted envelope. */
export function senderKeyEnvelopeId(
  message: SenderKeyDistributionMessage,
): Uint8Array {
  if (
    message.type !== MessageType.SenderKeyDistribution ||
    message.protocolVersion !== SENDER_KEY_ENVELOPE_VERSION
  ) {
    throw new Error('Unsupported sender-key envelope version');
  }
  assertBytes(message.recipientPublicKey, 32, 'recipient public key');
  assertBytes(message.nonce, 24, 'nonce');
  if (
    !(message.ciphertext instanceof Uint8Array) ||
    message.ciphertext.length < 16 ||
    message.ciphertext.length > 65_536
  ) {
    throw new Error('Invalid sender-key envelope ciphertext');
  }
  if (!Number.isSafeInteger(message.timestamp) || message.timestamp < 0) {
    throw new Error('Invalid sender-key envelope timestamp');
  }
  const timestamp = new Uint8Array(8);
  new DataView(timestamp.buffer).setBigUint64(
    0,
    BigInt(message.timestamp),
    false,
  );
  return sha256(
    concatBytes(
      DOMAIN,
      new Uint8Array([message.type, message.protocolVersion]),
      message.recipientPublicKey,
      message.nonce,
      timestamp,
      message.ciphertext,
    ),
  );
}

function assertBytes(value: unknown, length: number, label: string): void {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw new Error(`Invalid sender-key envelope ${label}`);
  }
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    parts.reduce((length, part) => length + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
