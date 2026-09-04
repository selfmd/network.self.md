import {
  sign,
  verify,
  fingerprintFromPublicKey,
} from '@networkselfmd/core';
import type {
  AgentIdentity,
  IdentityHandshakeMessage,
  ProtocolMessage,
} from '@networkselfmd/core';
import { MessageType } from '@networkselfmd/core';
import { PeerSession } from './connection.js';

export const HANDSHAKE_PROTOCOL_VERSION = 1;
export const TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000; // ±5 minutes

const HANDSHAKE_CONTEXT = new TextEncoder().encode(
  'network.self.md/identity-handshake/v1\0',
);
const KEY_LENGTH = 32;
const SIGNATURE_LENGTH = 64;
const HANDSHAKE_HASH_LENGTH = 64;

export interface HandshakeResult {
  session: PeerSession;
  peerPublicKey: Uint8Array;
  peerFingerprint: string;
  peerDisplayName?: string;
  peerNoisePublicKey: Uint8Array;
  /** Messages that arrived during the handshake but were not handshake messages */
  bufferedMessages?: ProtocolMessage[];
}

export async function performHandshake(
  socket: ConstructorParameters<typeof PeerSession>[0],
  identity: AgentIdentity,
): Promise<HandshakeResult> {
  const session = new PeerSession(socket);
  session.state = 'handshaking';

  let localNoisePublicKey: Uint8Array;
  let remoteNoisePublicKey: Uint8Array;
  let handshakeHash: Uint8Array;
  try {
    localNoisePublicKey = requireTransportValue(
      session.localNoisePublicKey,
      'local Noise public key',
    );
    remoteNoisePublicKey = requireTransportValue(
      session.remoteNoisePublicKey,
      'remote Noise public key',
    );
    handshakeHash = requireTransportValue(
      session.handshakeHash,
      'Noise handshake hash',
      HANDSHAKE_HASH_LENGTH,
    );
  } catch (error) {
    session.close();
    throw error;
  }
  const timestamp = Date.now();
  const payload = createHandshakeSigningPayload(
    HANDSHAKE_PROTOCOL_VERSION,
    localNoisePublicKey,
    identity.xPublicKey,
    timestamp,
    handshakeHash,
  );

  const signature = sign(payload, identity.edPrivateKey);

  const handshakeMessage: ProtocolMessage = {
    type: MessageType.IdentityHandshake,
    edPublicKey: identity.edPublicKey,
    xPublicKey: identity.xPublicKey,
    noisePublicKey: localNoisePublicKey,
    signature,
    protocolVersion: HANDSHAKE_PROTOCOL_VERSION,
    timestamp,
    displayName: identity.displayName,
  };

  return new Promise<HandshakeResult>((resolve, reject) => {
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
    let settled = false;

    const cleanup = () => {
      clearTimeout(timeout);
      session.removeListener('message', onMessage);
      session.removeListener('error', onError);
      session.removeListener('close', onClose);
    };

    const fail = (error: Error, closeSession = true) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (closeSession) session.close();
      reject(error);
    };

    const onError = (error: Error) => fail(error);
    const onClose = () =>
      fail(new Error('Connection closed during handshake'), false);

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
        validateHandshake(peerHandshake, remoteNoisePublicKey, handshakeHash);

        const peerFingerprint = fingerprintFromPublicKey(peerHandshake.edPublicKey);

        session.setVerified(
          peerHandshake.edPublicKey,
          peerFingerprint,
          peerHandshake.displayName,
          peerHandshake.xPublicKey,
        );

        // Use queueMicrotask to resolve after the current synchronous
        // onData loop finishes, ensuring all messages in this batch
        // are buffered before we proceed.
        queueMicrotask(() => {
          if (settled) return;
          settled = true;
          cleanup();
          const result: HandshakeResult = {
            session,
            peerPublicKey: peerHandshake.edPublicKey,
            peerFingerprint,
            peerDisplayName: peerHandshake.displayName,
            peerNoisePublicKey: peerHandshake.noisePublicKey,
            bufferedMessages,
          };
          resolve(result);
        });
      } catch (err) {
        fail(err instanceof Error ? err : new Error('Invalid identity handshake'));
      }
    };

    const timeout = setTimeout(
      () => fail(new Error('Handshake timeout')),
      10_000,
    );

    session.on('message', onMessage);
    session.on('error', onError);
    session.on('close', onClose);

    try {
      session.send(handshakeMessage);
    } catch (error) {
      fail(
        error instanceof Error
          ? error
          : new Error('Failed to send identity handshake'),
      );
    }
  });
}

export function createHandshakeSigningPayload(
  protocolVersion: number,
  noisePublicKey: Uint8Array,
  xPublicKey: Uint8Array,
  timestamp: number,
  handshakeHash: Uint8Array,
): Uint8Array {
  const payload = new Uint8Array(
    HANDSHAKE_CONTEXT.length +
      4 +
      noisePublicKey.length +
      xPublicKey.length +
      8 +
      handshakeHash.length,
  );
  let offset = 0;
  payload.set(HANDSHAKE_CONTEXT, offset);
  offset += HANDSHAKE_CONTEXT.length;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  view.setUint32(offset, protocolVersion, false);
  offset += 4;
  payload.set(noisePublicKey, offset);
  offset += noisePublicKey.length;
  payload.set(xPublicKey, offset);
  offset += xPublicKey.length;
  view.setBigUint64(offset, BigInt(timestamp), false);
  offset += 8;
  payload.set(handshakeHash, offset);
  return payload;
}

export function validateHandshake(
  handshake: IdentityHandshakeMessage,
  remoteNoisePublicKey: Uint8Array,
  handshakeHash: Uint8Array,
  now = Date.now(),
): void {
  if (handshake.protocolVersion !== HANDSHAKE_PROTOCOL_VERSION) {
    throw new Error(
      `Unsupported handshake protocol version: ${handshake.protocolVersion}`,
    );
  }

  assertByteLength(handshake.edPublicKey, KEY_LENGTH, 'Ed25519 public key');
  assertByteLength(handshake.xPublicKey, KEY_LENGTH, 'X25519 public key');
  assertByteLength(handshake.noisePublicKey, KEY_LENGTH, 'Noise public key');
  assertByteLength(handshake.signature, SIGNATURE_LENGTH, 'Ed25519 signature');
  assertByteLength(remoteNoisePublicKey, KEY_LENGTH, 'remote Noise public key');
  assertByteLength(handshakeHash, HANDSHAKE_HASH_LENGTH, 'Noise handshake hash');

  if (!Number.isSafeInteger(handshake.timestamp) || handshake.timestamp < 0) {
    throw new Error('Invalid handshake timestamp');
  }

  const diff = Math.abs(now - handshake.timestamp);
  if (diff > TIMESTAMP_TOLERANCE_MS) {
    throw new Error(
      `Handshake timestamp out of range: ${diff}ms (max ${TIMESTAMP_TOLERANCE_MS}ms)`,
    );
  }

  if (!equalBytes(handshake.noisePublicKey, remoteNoisePublicKey)) {
    throw new Error('Claimed Noise public key does not match the transport');
  }

  const payload = createHandshakeSigningPayload(
    handshake.protocolVersion,
    handshake.noisePublicKey,
    handshake.xPublicKey,
    handshake.timestamp,
    handshakeHash,
  );

  const valid = verify(handshake.signature, payload, handshake.edPublicKey);
  if (!valid) {
    throw new Error('Invalid handshake signature');
  }
}

function requireTransportValue(
  value: Uint8Array | null,
  label: string,
  length = KEY_LENGTH,
): Uint8Array {
  if (!value || value.length !== length) {
    throw new Error(`Missing or invalid ${label}`);
  }
  return value;
}

function assertByteLength(
  value: unknown,
  length: number,
  label: string,
): asserts value is Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw new Error(`Invalid ${label}`);
  }
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) {
    difference |= a[i] ^ b[i];
  }
  return difference === 0;
}
