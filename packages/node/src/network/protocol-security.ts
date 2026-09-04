import {
  authenticatedMessageId,
  fingerprintFromPublicKey,
  senderKeyEnvelopeId,
  verifyAuthenticatedMessage,
} from '@networkselfmd/core';
import type { AuthenticatedProtocolMessage } from '@networkselfmd/core';
import type { SenderKeyDistributionMessage } from '@networkselfmd/core';
import type { PeerSession } from './connection.js';
import type { ReplayReservation } from '../storage/repositories.js';

export const MESSAGE_TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * Authenticates protocol context without mutating replay state. The returned
 * reservation must be passed to ProtocolReplayRepository.accept together with
 * the durable state mutation that makes the message effective.
 */
export function validateAuthenticatedMessage(
  session: PeerSession,
  message: AuthenticatedProtocolMessage,
  localFingerprint: string,
  now: number = Date.now(),
): ReplayReservation {
  const senderFingerprint = validateReadySession(session);
  validateFreshTimestamp(message.timestamp, now);
  if (message.senderFingerprint !== senderFingerprint) {
    throw new Error(
      'Rejected authenticated message: sender does not match session identity',
    );
  }
  if (
    'recipientFingerprint' in message &&
    message.recipientFingerprint !== localFingerprint
  ) {
    throw new Error(
      'Rejected authenticated message: recipient context mismatch',
    );
  }
  if (!verifyAuthenticatedMessage(message, session.peerPublicKey!)) {
    throw new Error('Rejected authenticated message: invalid signature');
  }
  return {
    messageId: authenticatedMessageId(message),
    senderFingerprint,
    messageType: message.type,
    receivedAt: now,
  };
}

export function validateSenderKeyEnvelope(
  session: PeerSession,
  message: SenderKeyDistributionMessage,
  localPublicKey: Uint8Array,
  now: number = Date.now(),
): ReplayReservation {
  const senderFingerprint = validateReadySession(session);
  validateFreshTimestamp(message.timestamp, now);
  if (!bytesEqual(message.recipientPublicKey, localPublicKey)) {
    throw new Error('Rejected sender-key envelope: recipient context mismatch');
  }
  return {
    messageId: senderKeyEnvelopeId(message),
    senderFingerprint,
    messageType: message.type,
    receivedAt: now,
  };
}

export function validateReadySession(session: PeerSession): string {
  if (
    !session.peerPublicKey ||
    !session.peerFingerprint ||
    session.state !== 'ready'
  ) {
    throw new Error(
      'Rejected authenticated message: session is not verified and ready',
    );
  }
  const actualFingerprint = fingerprintFromPublicKey(session.peerPublicKey);
  if (session.peerFingerprint !== actualFingerprint) {
    throw new Error(
      'Rejected authenticated message: session fingerprint is inconsistent',
    );
  }
  return actualFingerprint;
}

export function validateFreshTimestamp(
  timestamp: number,
  now: number = Date.now(),
): void {
  if (Math.abs(now - timestamp) > MESSAGE_TIMESTAMP_TOLERANCE_MS) {
    throw new Error('Rejected authenticated message: timestamp out of range');
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index++) {
    difference |= a[index] ^ b[index];
  }
  return difference === 0;
}
