import { Encoder } from 'cbor-x';
import { sha256 } from '@noble/hashes/sha256';
import { sign, verify } from '../crypto/signatures.js';
import { MessageType } from './types.js';
import type {
  DirectEncryptedMessage,
  GroupEncryptedMessage,
  GroupManagementMessage,
  SenderKeyDistributionMessage,
} from './types.js';

const encoder = new Encoder({ useRecords: false, mapsAsObjects: true });
const AUTH_DOMAIN = 'networkselfmd-protocol-auth-v2';

export type AuthenticatedProtocolMessage =
  | SenderKeyDistributionMessage
  | GroupEncryptedMessage
  | DirectEncryptedMessage
  | GroupManagementMessage;

type UnsignedAuthenticatedMessage = AuthenticatedProtocolMessage extends infer T
  ? T extends AuthenticatedProtocolMessage
    ? Omit<T, 'signature'>
    : never
  : never;

/** Canonical, domain-separated representation of every security-relevant field. */
export function authenticatedMessagePayload(
  message: UnsignedAuthenticatedMessage,
): Uint8Array {
  let fields: unknown[];
  switch (message.type) {
    case MessageType.SenderKeyDistribution:
      fields = [
        message.groupId,
        message.chainKey,
        message.chainIndex,
        message.signingPublicKey,
        message.senderFingerprint,
        message.recipientFingerprint,
        message.timestamp,
      ];
      break;
    case MessageType.GroupMessage:
      fields = [
        message.groupId,
        message.senderFingerprint,
        message.chainIndex,
        message.nonce,
        message.ciphertext,
        message.timestamp,
      ];
      break;
    case MessageType.DirectMessage:
      fields = [
        message.senderFingerprint,
        message.recipientFingerprint,
        message.ratchetPublicKey,
        message.previousChainLength,
        message.messageNumber,
        message.nonce,
        message.ciphertext,
        message.timestamp,
      ];
      break;
    case MessageType.GroupManagement:
      fields = [
        message.groupId,
        message.action,
        message.targetFingerprint ?? null,
        message.groupName ?? null,
        message.senderFingerprint,
        message.recipientFingerprint,
        message.timestamp,
      ];
      break;
    default:
      throw new Error('Message type is not authenticated by protocol v2');
  }
  return encoder.encode([AUTH_DOMAIN, message.type, ...fields]);
}

export function signAuthenticatedMessage<
  T extends AuthenticatedProtocolMessage,
>(
  message: T extends AuthenticatedProtocolMessage
    ? Omit<T, 'signature'>
    : never,
  privateKey: Uint8Array,
): T {
  const signature = sign(authenticatedMessagePayload(message), privateKey);
  return { ...message, signature } as unknown as T;
}

export function verifyAuthenticatedMessage(
  message: AuthenticatedProtocolMessage,
  publicKey: Uint8Array,
): boolean {
  const { signature, ...unsigned } = message;
  return verify(signature, authenticatedMessagePayload(unsigned), publicKey);
}

/** Stable identifier used by durable replay ledgers. */
export function authenticatedMessageId(
  message: AuthenticatedProtocolMessage,
): Uint8Array {
  const payload = authenticatedMessagePayload(message);
  const combined = new Uint8Array(payload.length + message.signature.length);
  combined.set(payload);
  combined.set(message.signature, payload.length);
  return sha256(combined);
}
