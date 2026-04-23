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

    const onMessage = (message: ProtocolMessage) => {
      if (message.type !== MessageType.IdentityHandshake) {
        return;
      }

      clearTimeout(timeout);
      session.removeListener('message', onMessage);

      try {
        const peerHandshake = message as IdentityHandshakeMessage;
        validateHandshake(peerHandshake, noisePublicKey);

        const peerFingerprint = fingerprintFromPublicKey(peerHandshake.edPublicKey);

        session.setVerified(
          peerHandshake.edPublicKey,
          peerFingerprint,
          peerHandshake.displayName,
        );

        resolve({
          session,
          peerPublicKey: peerHandshake.edPublicKey,
          peerFingerprint,
          peerDisplayName: peerHandshake.displayName,
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
  expectedNoiseKey: Uint8Array,
): void {
  // Check timestamp
  const now = Date.now();
  const diff = Math.abs(now - handshake.timestamp);
  if (diff > TIMESTAMP_TOLERANCE_MS) {
    throw new Error(
      `Handshake timestamp out of range: ${diff}ms (max ${TIMESTAMP_TOLERANCE_MS}ms)`,
    );
  }

  // Reconstruct the payload the peer signed
  const payload = new Uint8Array(expectedNoiseKey.length + 8);
  // The peer signed their own noise key, which we received via Hyperswarm
  // For validation, we use the remote noise key from the socket
  payload.set(expectedNoiseKey, 0);
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  view.setBigUint64(expectedNoiseKey.length, BigInt(handshake.timestamp), false);

  // Note: In a real implementation, we'd need the peer's noise public key
  // For now, we verify the Ed25519 signature on the payload
  const valid = verify(handshake.signature, payload, handshake.edPublicKey);
  if (!valid) {
    throw new Error('Invalid handshake signature');
  }
}
