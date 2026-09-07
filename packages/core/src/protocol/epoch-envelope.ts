import { sha256 } from '@noble/hashes/sha256';
import { sign, verify } from '../crypto/signatures.js';
import { MessageType } from './types.js';
import type { GroupEpochMessage } from './types.js';

export const GROUP_EPOCH_ENVELOPE_VERSION = 2;
const DOMAIN = new TextEncoder().encode(
  'network.self.md/GroupEpochEnvelope/v2\0',
);

type UnsignedGroupEpochEnvelope = Omit<GroupEpochMessage, 'envelopeSignature'>;

export function canonicalGroupEpochEnvelope(
  message: UnsignedGroupEpochEnvelope,
): Uint8Array {
  if (
    message.type !== MessageType.GroupEpoch ||
    message.protocolVersion !== GROUP_EPOCH_ENVELOPE_VERSION
  ) {
    throw new Error('Unsupported GroupEpoch envelope version');
  }
  assertBytes(message.groupId, 32, 'groupId');
  if (
    !(message.epochData instanceof Uint8Array) ||
    message.epochData.length === 0 ||
    message.epochData.length > 256 * 1024
  ) {
    throw new Error('Invalid GroupEpoch epochData');
  }
  assertBytes(message.signature, 64, 'signature');
  assertBytes(message.hash, 32, 'hash');
  assertFingerprint(message.senderFingerprint, 'senderFingerprint');
  assertFingerprint(message.recipientFingerprint, 'recipientFingerprint');
  if (!Number.isSafeInteger(message.timestamp) || message.timestamp < 0) {
    throw new Error('Invalid GroupEpoch timestamp');
  }
  return concatBytes(
    DOMAIN,
    new Uint8Array([message.type]),
    u16(message.protocolVersion),
    message.groupId,
    lp(message.epochData),
    message.signature,
    message.hash,
    lp(new TextEncoder().encode(message.senderFingerprint)),
    lp(new TextEncoder().encode(message.recipientFingerprint)),
    u64(message.timestamp),
  );
}

function assertBytes(value: unknown, length: number, label: string): void {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw new Error(`Invalid GroupEpoch ${label}`);
  }
}

function assertFingerprint(value: unknown, label: string): void {
  if (
    typeof value !== 'string' ||
    !/^[ybndrfg8ejkmcpqxot1uwisza345h769]{32}$/.test(value)
  ) {
    throw new Error(`Invalid GroupEpoch ${label}`);
  }
}

export function signGroupEpochEnvelope(
  message: UnsignedGroupEpochEnvelope,
  privateKey: Uint8Array,
): GroupEpochMessage {
  return {
    ...message,
    envelopeSignature: sign(canonicalGroupEpochEnvelope(message), privateKey),
  };
}

export function verifyGroupEpochEnvelope(
  message: GroupEpochMessage,
  publicKey: Uint8Array,
): boolean {
  try {
    const { envelopeSignature, ...unsigned } = message;
    return verify(
      envelopeSignature,
      canonicalGroupEpochEnvelope(unsigned),
      publicKey,
    );
  } catch {
    return false;
  }
}

export function groupEpochEnvelopeId(message: GroupEpochMessage): Uint8Array {
  const { envelopeSignature, ...unsigned } = message;
  return sha256(
    concatBytes(canonicalGroupEpochEnvelope(unsigned), envelopeSignature),
  );
}

function u16(value: number): Uint8Array {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value, false);
  return out;
}

function u64(value: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(value), false);
  return out;
}

function lp(value: Uint8Array): Uint8Array {
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, value.length, false);
  return concatBytes(length, value);
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(
    parts.reduce((length, part) => length + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
