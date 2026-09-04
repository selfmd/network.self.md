import {
  authenticatedMessageId,
  fingerprintFromPublicKey,
  verifyAuthenticatedMessage,
} from '@networkselfmd/core';
import type { AuthenticatedProtocolMessage } from '@networkselfmd/core';
import type { PeerSession } from './connection.js';
import type { ProtocolReplayRepository } from '../storage/repositories.js';

export const MESSAGE_TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000;

export function acceptAuthenticatedMessage(
  session: PeerSession,
  message: AuthenticatedProtocolMessage,
  localFingerprint: string,
  replay: ProtocolReplayRepository,
  now: number = Date.now(),
): void {
  if (
    !session.peerPublicKey ||
    !session.peerFingerprint ||
    session.state !== 'ready'
  ) {
    throw new Error(
      'Rejected authenticated message: session is not verified and ready',
    );
  }
  if (Math.abs(now - message.timestamp) > MESSAGE_TIMESTAMP_TOLERANCE_MS) {
    throw new Error('Rejected authenticated message: timestamp out of range');
  }
  const actualFingerprint = fingerprintFromPublicKey(session.peerPublicKey);
  if (
    message.senderFingerprint !== session.peerFingerprint ||
    message.senderFingerprint !== actualFingerprint
  ) {
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
  if (!verifyAuthenticatedMessage(message, session.peerPublicKey)) {
    throw new Error('Rejected authenticated message: invalid signature');
  }
  if (
    !replay.claim(
      authenticatedMessageId(message),
      message.senderFingerprint,
      message.type,
      now,
    )
  ) {
    throw new Error('Rejected authenticated message: replay detected');
  }
}
