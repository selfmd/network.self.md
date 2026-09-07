import { sign, verify, fingerprintFromPublicKey } from '@networkselfmd/core';
import type {
  AgentIdentity,
  IdentityHandshakeMessage,
} from '@networkselfmd/core';
import { MessageType } from '@networkselfmd/core';
import { SENDER_KEY_CAPABILITY } from '@networkselfmd/core';
import { PeerSession } from './connection.js';

export const HANDSHAKE_PROTOCOL_VERSION = 3;
export const TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000; // ±5 minutes
export const HANDSHAKE_CAPABILITIES = [
  SENDER_KEY_CAPABILITY,
  'group-epoch-v1',
  'group-metadata-v1',
  'reliable-delivery-v1',
] as const;

const HANDSHAKE_CONTEXT = new TextEncoder().encode(
  'network.self.md/identity-handshake/v3\0',
);
const KEY_LENGTH = 32;
const SIGNATURE_LENGTH = 64;
const HANDSHAKE_HASH_LENGTH = 64;
const VERSION_LENGTH = 4;
const TIMESTAMP_LENGTH = 8;
export const HANDSHAKE_TRANSCRIPT_LENGTH =
  HANDSHAKE_CONTEXT.length +
  VERSION_LENGTH +
  KEY_LENGTH +
  KEY_LENGTH +
  TIMESTAMP_LENGTH +
  HANDSHAKE_HASH_LENGTH;

export interface HandshakeResult {
  session: PeerSession;
  peerPublicKey: Uint8Array;
  peerFingerprint: string;
  peerDisplayName?: string;
  peerProtocolVersion: number;
  peerCapabilities: string[];
  peerNoisePublicKey: Uint8Array;
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
    session.destroy();
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

  const handshakeMessage: IdentityHandshakeMessage = {
    type: MessageType.IdentityHandshake,
    edPublicKey: identity.edPublicKey,
    xPublicKey: identity.xPublicKey,
    noisePublicKey: localNoisePublicKey,
    signature,
    protocolVersion: HANDSHAKE_PROTOCOL_VERSION,
    capabilities: [...HANDSHAKE_CAPABILITIES],
    timestamp,
    displayName: identity.displayName,
  };

  return new Promise<HandshakeResult>((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      clearTimeout(timeout);
      session.removeListener('message', onMessage);
      session.removeListener('error', onError);
      session.removeListener('close', onClose);
    };

    const fail = (error: Error, destroySession = true) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (destroySession) session.destroy();
      reject(error);
    };

    const onError = (error: Error) => fail(error);
    const onClose = () =>
      fail(new Error('Connection closed during handshake'), false);

    const onMessage = (message: IdentityHandshakeMessage) => {
      if (message.type !== MessageType.IdentityHandshake) {
        fail(
          new Error(
            'Application frame received before identity authentication',
          ),
        );
        return;
      }

      clearTimeout(timeout);

      try {
        const peerHandshake = message as IdentityHandshakeMessage;
        validateHandshake(peerHandshake, remoteNoisePublicKey, handshakeHash);

        const peerFingerprint = fingerprintFromPublicKey(
          peerHandshake.edPublicKey,
        );

        session.setVerified(
          peerHandshake.edPublicKey,
          peerFingerprint,
          peerHandshake.displayName,
          peerHandshake.xPublicKey,
          peerHandshake.protocolVersion,
          peerHandshake.capabilities,
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
            peerProtocolVersion: peerHandshake.protocolVersion,
            peerCapabilities: peerHandshake.capabilities ?? [],
            peerNoisePublicKey: peerHandshake.noisePublicKey,
          };
          resolve(result);
        });
      } catch (err) {
        fail(
          err instanceof Error ? err : new Error('Invalid identity handshake'),
        );
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
  if (
    !Number.isInteger(protocolVersion) ||
    protocolVersion < 0 ||
    protocolVersion > 0xffffffff
  ) {
    throw new Error('Invalid handshake protocol version');
  }
  assertByteLength(noisePublicKey, KEY_LENGTH, 'Noise public key');
  assertByteLength(xPublicKey, KEY_LENGTH, 'X25519 public key');
  assertByteLength(
    handshakeHash,
    HANDSHAKE_HASH_LENGTH,
    'Noise handshake hash',
  );
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new Error('Invalid handshake timestamp');
  }

  const payload = new Uint8Array(HANDSHAKE_TRANSCRIPT_LENGTH);
  let offset = 0;
  payload.set(HANDSHAKE_CONTEXT, offset);
  offset += HANDSHAKE_CONTEXT.length;
  const view = new DataView(
    payload.buffer,
    payload.byteOffset,
    payload.byteLength,
  );
  view.setUint32(offset, protocolVersion, false);
  offset += VERSION_LENGTH;
  payload.set(noisePublicKey, offset);
  offset += KEY_LENGTH;
  payload.set(xPublicKey, offset);
  offset += KEY_LENGTH;
  view.setBigUint64(offset, BigInt(timestamp), false);
  offset += TIMESTAMP_LENGTH;
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
      `Incompatible handshake protocol version: local=${HANDSHAKE_PROTOCOL_VERSION} remote=${String(handshake.protocolVersion)}`,
    );
  }

  assertByteLength(handshake.edPublicKey, KEY_LENGTH, 'Ed25519 public key');
  assertByteLength(handshake.xPublicKey, KEY_LENGTH, 'X25519 public key');
  assertByteLength(handshake.noisePublicKey, KEY_LENGTH, 'Noise public key');
  assertByteLength(handshake.signature, SIGNATURE_LENGTH, 'Ed25519 signature');
  assertByteLength(remoteNoisePublicKey, KEY_LENGTH, 'remote Noise public key');
  assertByteLength(
    handshakeHash,
    HANDSHAKE_HASH_LENGTH,
    'Noise handshake hash',
  );

  if (!Number.isSafeInteger(handshake.timestamp) || handshake.timestamp < 0) {
    throw new Error('Invalid handshake timestamp');
  }

  if (
    handshake.displayName !== undefined &&
    (typeof handshake.displayName !== 'string' ||
      new TextEncoder().encode(handshake.displayName).length > 128)
  ) {
    throw new Error('Invalid handshake display name');
  }

  const capabilities = handshake.capabilities;
  if (
    !Array.isArray(capabilities) ||
    capabilities.length !== HANDSHAKE_CAPABILITIES.length ||
    !HANDSHAKE_CAPABILITIES.every((capability) =>
      capabilities.includes(capability),
    )
  ) {
    throw new Error('Unsupported handshake protocol capabilities');
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
