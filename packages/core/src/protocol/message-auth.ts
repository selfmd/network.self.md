import { Encoder } from 'cbor-x';
import { sha256 } from '@noble/hashes/sha256';
import { sign, verify } from '../crypto/signatures.js';
import { MessageType } from './types.js';
import type {
  DirectEncryptedMessage,
  GroupEncryptedMessage,
  GroupManagementMessage,
} from './types.js';

const encoder = new Encoder({ useRecords: false, mapsAsObjects: true });
const AUTH_DOMAIN = 'networkselfmd-protocol-auth-v2';

export type AuthenticatedProtocolMessage =
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
    case MessageType.GroupMessage:
      fields = [
        canonicalBytes(message.groupId),
        message.senderFingerprint,
        message.chainIndex,
        canonicalBytes(message.generationId),
        message.epochVersion,
        canonicalBytes(message.epochHash),
        canonicalBytes(message.nonce),
        canonicalBytes(message.ciphertext),
        message.timestamp,
      ];
      break;
    case MessageType.DirectMessage:
      fields = [
        message.senderFingerprint,
        message.recipientFingerprint,
        canonicalBytes(message.ratchetPublicKey),
        message.previousChainLength,
        message.messageNumber,
        canonicalBytes(message.nonce),
        canonicalBytes(message.ciphertext),
        message.timestamp,
      ];
      break;
    case MessageType.GroupManagement:
      fields = [
        canonicalBytes(message.groupId),
        message.action,
        message.targetFingerprint ?? null,
        message.groupName ?? null,
        message.inviteId ?? null,
        message.epochVersion ?? null,
        optionalBytes(message.epochHash),
        optionalBytes(message.genesisEpochData),
        optionalBytes(message.genesisSignature),
        optionalBytes(message.genesisHash),
        message.senderFingerprint,
        message.recipientFingerprint,
        message.timestamp,
      ];
      if (message.action === 'metadata') {
        fields.push(message.selfMd, message.isPublic, message.metadataVersion);
      }
      break;
    default:
      throw new Error('Message type is not authenticated by protocol v2');
  }
  return encoder.encode([AUTH_DOMAIN, message.type, ...fields]);
}

function canonicalBytes(value: Uint8Array): Uint8Array {
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function optionalBytes(value: Uint8Array | undefined): Uint8Array | null {
  return value === undefined ? null : canonicalBytes(value);
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
