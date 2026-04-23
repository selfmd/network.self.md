import {
  sign,
  verify,
  fingerprintFromPublicKey,
} from '@networkselfmd/core';
import type { AgentIdentity, IdentityHandshakeMessage, ProtocolMessage } from '@networkselfmd/core';
import { MessageType } from '@networkselfmd/core';
import { PeerSession } from './connection.js';

const TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000; // ±5 minutes

export interface HandshakeResult {
  session: PeerSession;
  peerPublicKey: Uint8Array;
  peerFingerprint: string;
  peerDisplayName?: string;
  /** Messages that arrived during the handshake but were not handshake messages */
  bufferedMessages?: ProtocolMessage[];
}

export async function performHandshake(
  socket: ConstructorParameters<typeof PeerSession>[0],
  identity: AgentIdentity,
): Promise<HandshakeResult> {
  const session = new PeerSession(socket);
  session.state = 'handshaking';

  const noisePublicKey = session.noisePublicKey ?? new Uint8Array(32);
  const timestamp = Date.now();

  // Build signing payload: noisePublicKey || timestamp as uint64 BE
  const payload = new Uint8Array(noisePublicKey.length + 8);
  payload.set(noisePublicKey, 0);
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  view.setBigUint64(noisePublicKey.length, BigInt(timestamp), false);

  const signature = sign(payload, identity.edPrivateKey);

  const handshakeMessage: ProtocolMessage = {
    type: MessageType.IdentityHandshake,
    edPublicKey: identity.edPublicKey,
    noisePublicKey: noisePublicKey,
    signature,
    protocolVersion: 1,
    timestamp,
    displayName: identity.displayName,
  };

  session.send(handshakeMessage);

  return new Promise<HandshakeResult>((resolve, reject) => {
    const timeout = setTimeout(() => {
      session.close();
      reject(new Error('Handshake timeout'));
    }, 10_000);

    // Buffer non-handshake messages that arrive during the handshake.
    // These will be re-emitted after the handshake completes so that
    // the routing layer can process them.
    //
    // Important: we keep the listener attached even after the handshake
    // message arrives, because multiple messages may arrive in the same
    // TCP segment. The PeerSession's onData loop emits them synchronously,
    // so removing the listener mid-loop would cause subsequent messages
    // in that batch to be lost.
    const bufferedMessages: ProtocolMessage[] = [];
    let handshakeCompleted = false;

    const onMessage = (message: ProtocolMessage) => {
      // After handshake is complete, buffer ALL remaining messages
      if (handshakeCompleted) {
        bufferedMessages.push(message);
        return;
      }

      if (message.type !== MessageType.IdentityHandshake) {
        bufferedMessages.push(message);
        return;
      }

      handshakeCompleted = true;
      clearTimeout(timeout);

      try {
        const peerHandshake = message as IdentityHandshakeMessage;
        validateHandshake(peerHandshake);

        const peerFingerprint = fingerprintFromPublicKey(peerHandshake.edPublicKey);

        session.setVerified(
          peerHandshake.edPublicKey,
          peerFingerprint,
          peerHandshake.displayName,
        );

        // Use queueMicrotask to resolve after the current synchronous
        // onData loop finishes, ensuring all messages in this batch
        // are buffered before we proceed.
        queueMicrotask(() => {
          session.removeListener('message', onMessage);
          const result: HandshakeResult = {
            session,
            peerPublicKey: peerHandshake.edPublicKey,
            peerFingerprint,
            peerDisplayName: peerHandshake.displayName,
            bufferedMessages,
          };
          resolve(result);
        });
      } catch (err) {
        session.close();
        reject(err);
      }
    };

    session.on('message', onMessage);

    session.on('error', (err: Error) => {
      clearTimeout(timeout);
      reject(err);
    });

    session.on('close', () => {
      clearTimeout(timeout);
      reject(new Error('Connection closed during handshake'));
    });
  });
}

function validateHandshake(
  handshake: IdentityHandshakeMessage,
): void {
  // Check timestamp
  const now = Date.now();
  const diff = Math.abs(now - handshake.timestamp);
  if (diff > TIMESTAMP_TOLERANCE_MS) {
    throw new Error(
      `Handshake timestamp out of range: ${diff}ms (max ${TIMESTAMP_TOLERANCE_MS}ms)`,
    );
  }

  // Reconstruct the payload the peer signed:
  // They signed their own view of noisePublicKey (the remote noise key they see)
  // which they included in the handshake message.
  const noiseKey = handshake.noisePublicKey;
  const payload = new Uint8Array(noiseKey.length + 8);
  payload.set(noiseKey, 0);
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  view.setBigUint64(noiseKey.length, BigInt(handshake.timestamp), false);

  const valid = verify(handshake.signature, payload, handshake.edPublicKey);
  if (!valid) {
    throw new Error('Invalid handshake signature');
  }
}
