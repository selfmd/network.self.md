import { Encoder, Decoder } from 'cbor-x';
import type { ProtocolMessage, MessageTypeValue } from './types.js';
import { MessageType } from './types.js';
import { assertAnnounceShape } from './announce-signature.js';
import { assertSenderKeyDistributionMessage } from './sender-keys.js';

const encoder = new Encoder({ useRecords: false });
const decoder = new Decoder({ mapsAsObjects: true, useRecords: false });

export const MAX_FRAME_SIZE = 1_048_576; // 1 MiB

const validMessageTypes = new Set<number>(Object.values(MessageType));

export function encodeMessage(message: ProtocolMessage): Uint8Array {
  return encoder.encode(message);
}

export function decodeMessage(bytes: Uint8Array): ProtocolMessage {
  const decoded = decoder.decode(bytes);
  if (
    typeof decoded !== 'object' ||
    decoded === null ||
    !('type' in decoded)
  ) {
    throw new Error('Invalid message: missing type field');
  }
  if (!validMessageTypes.has(decoded.type as number)) {
    throw new Error(`Invalid message type: ${decoded.type}`);
  }
  validateSecurityMessage(decoded as Record<string, unknown>);
  return decoded as ProtocolMessage;
}

function validateSecurityMessage(message: Record<string, unknown>): void {
  switch (message.type) {
    case MessageType.NetworkAnnounce:
      assertAnnounceShape(message as unknown as Parameters<typeof assertAnnounceShape>[0]);
      break;
    case MessageType.SenderKeyDistribution:
      assertSenderKeyDistributionMessage(message);
      break;
    case MessageType.GroupEpoch:
      assertBytes(message.groupId, 32, 'group id');
      assertBytes(message.signature, 64, 'epoch signature');
      assertBytes(message.hash, 32, 'epoch hash');
      if (!(message.epochData instanceof Uint8Array) || message.epochData.length === 0 || message.epochData.length > 256 * 1024) throw new Error('Invalid epoch data');
      assertTimestamp(message.timestamp);
      break;
    case MessageType.GroupMessage:
      assertBytes(message.groupId, 32, 'group id');
      assertBytes(message.generationId, 16, 'generation id');
      assertBytes(message.epochHash, 32, 'epoch hash');
      assertBytes(message.nonce, 24, 'group message nonce');
      if (!(message.ciphertext instanceof Uint8Array) || message.ciphertext.length === 0 || message.ciphertext.length > 64 * 1024) throw new Error('Invalid group ciphertext');
      assertNonNegativeInteger(message.chainIndex, 'chain index');
      assertNonNegativeInteger(message.epochVersion, 'epoch version');
      if (typeof message.senderFingerprint !== 'string' || message.senderFingerprint.length === 0 || message.senderFingerprint.length > 128) throw new Error('Invalid sender fingerprint');
      assertTimestamp(message.timestamp);
      break;
    case MessageType.GroupManagement:
      assertBytes(message.groupId, 32, 'group id');
      if (!['create', 'invite', 'accept', 'sync-request', 'join', 'leave', 'kick', 'promote'].includes(message.action as string)) throw new Error('Invalid group action');
      assertTimestamp(message.timestamp);
      break;
  }
}

function assertBytes(value: unknown, length: number, label: string): asserts value is Uint8Array { if (!(value instanceof Uint8Array) || value.length !== length) throw new Error(`Invalid ${label}`); }
function assertNonNegativeInteger(value: unknown, label: string): asserts value is number { if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`Invalid ${label}`); }
function assertTimestamp(value: unknown): asserts value is number { if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error('Invalid timestamp'); }

export function frameMessage(message: ProtocolMessage): Uint8Array {
  const payload = encodeMessage(message);
  if (payload.length > MAX_FRAME_SIZE) {
    throw new Error(
      `Message exceeds MAX_FRAME_SIZE: ${payload.length} > ${MAX_FRAME_SIZE}`
    );
  }
  const frame = new Uint8Array(4 + payload.length);
  const view = new DataView(frame.buffer);
  view.setUint32(0, payload.length, false); // big-endian
  frame.set(payload, 4);
  return frame;
}

export function parseFrame(
  buffer: Uint8Array
): { message: ProtocolMessage; bytesConsumed: number } | null {
  if (buffer.length < 4) {
    return null;
  }
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const payloadLength = view.getUint32(0, false);
  if (payloadLength > MAX_FRAME_SIZE) {
    throw new Error(
      `Frame exceeds MAX_FRAME_SIZE: ${payloadLength} > ${MAX_FRAME_SIZE}`
    );
  }
  if (buffer.length < 4 + payloadLength) {
    return null; // incomplete frame
  }
  const payload = buffer.slice(4, 4 + payloadLength);
  const message = decodeMessage(payload);
  return { message, bytesConsumed: 4 + payloadLength };
}
