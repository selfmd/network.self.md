import { Encoder } from 'cbor-x';
import { sha256 } from '@noble/hashes/sha256';
import { sign, verify } from '../crypto/signatures.js';
import { authenticatedMessagePayload } from './message-auth.js';
import type { DirectEncryptedMessage, GroupEncryptedMessage } from './types.js';

export const RELIABLE_DELIVERY_CAPABILITY = 'reliable-delivery-v1';
export const DELIVERY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export interface ReliableDeliveryMessage {
  type: 0x0c;
  id: string;
  senderFingerprint: string;
  recipientFingerprint: string;
  contentHash: string;
  createdAt: number;
  expiresAt: number;
  timestamp: number;
  message: DirectEncryptedMessage | GroupEncryptedMessage;
  signature: Uint8Array;
}
export interface DeliveryReceiptMessage {
  type: 0x0d;
  id: string;
  senderFingerprint: string;
  recipientFingerprint: string;
  timestamp: number;
  signature: Uint8Array;
}
const encoder = new Encoder({ useRecords: false, mapsAsObjects: true });
type Packet = ReliableDeliveryMessage | DeliveryReceiptMessage;
function payload(message: Omit<ReliableDeliveryMessage, 'signature'> | Omit<DeliveryReceiptMessage, 'signature'>): Uint8Array {
  const fields: unknown[] = ['networkselfmd-reliable-delivery-v1', message.type,
    message.id, message.senderFingerprint, message.recipientFingerprint, message.timestamp];
  if (message.type === 0x0c) {
    fields.push(message.contentHash, message.createdAt, message.expiresAt,
      authenticatedMessagePayload(message.message), new Uint8Array(message.message.signature));
  }
  return encoder.encode(fields);
}
export function signDelivery<T extends Packet>(message: Omit<T, 'signature'>, privateKey: Uint8Array): T {
  return { ...message, signature: sign(payload(message as Parameters<typeof payload>[0]), privateKey) } as T;
}
export function verifyDelivery(message: Packet, publicKey: Uint8Array): boolean {
  return verify(message.signature, payload(message), publicKey);
}
export function deliveryContentHash(content: string, groupId?: Uint8Array): string {
  return Array.from(sha256(encoder.encode(['networkselfmd-delivery-content-v1', groupId ? new Uint8Array(groupId) : null, content])),
    byte => byte.toString(16).padStart(2, '0')).join('');
}
