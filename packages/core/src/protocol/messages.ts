import { Encoder, Decoder } from 'cbor-x';
import type { ProtocolMessage, MessageTypeValue } from './types.js';
import { MessageType } from './types.js';

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
  return decoded as ProtocolMessage;
}

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
