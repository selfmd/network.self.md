import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
  frameMessage,
  generateIdentity,
  MessageType,
  sign,
} from '@networkselfmd/core';
import type {
  AgentIdentity,
  IdentityHandshakeMessage,
} from '@networkselfmd/core';
import {
  createHandshakeSigningPayload,
  HANDSHAKE_PROTOCOL_VERSION,
  performHandshake,
  TIMESTAMP_TOLERANCE_MS,
  validateHandshake,
} from '../network/handshake.js';

const TRANSPORT_A = new Uint8Array(32).fill(0xa1);
const TRANSPORT_B = new Uint8Array(32).fill(0xb2);
const HANDSHAKE_HASH = new Uint8Array(64).fill(0xc3);
const NOW = 1_800_000_000_000;

function signedHandshake(
  identity: AgentIdentity,
  noisePublicKey = TRANSPORT_A,
  handshakeHash = HANDSHAKE_HASH,
  timestamp = NOW,
): IdentityHandshakeMessage {
  return {
    type: MessageType.IdentityHandshake,
    edPublicKey: identity.edPublicKey,
    xPublicKey: identity.xPublicKey,
    noisePublicKey,
    signature: sign(
      createHandshakeSigningPayload(
        HANDSHAKE_PROTOCOL_VERSION,
        noisePublicKey,
        identity.xPublicKey,
        timestamp,
        handshakeHash,
      ),
      identity.edPrivateKey,
    ),
    protocolVersion: HANDSHAKE_PROTOCOL_VERSION,
    timestamp,
    displayName: identity.displayName,
  };
}

describe('identity handshake validation', () => {
  it('accepts a valid identity bound to the actual Noise connection', () => {
    const identity = generateIdentity('Alice');
    const handshake = signedHandshake(identity);

    expect(() =>
      validateHandshake(handshake, TRANSPORT_A, HANDSHAKE_HASH, NOW),
    ).not.toThrow();
  });

  it('rejects a substituted X25519 key', () => {
    const identity = generateIdentity();
    const attacker = generateIdentity();
    const handshake = signedHandshake(identity);

    expect(() =>
      validateHandshake(
        { ...handshake, xPublicKey: attacker.xPublicKey },
        TRANSPORT_A,
        HANDSHAKE_HASH,
        NOW,
      ),
    ).toThrow(/signature/i);
  });

  it('rejects a substituted Ed25519 identity', () => {
    const identity = generateIdentity();
    const attacker = generateIdentity();
    const handshake = signedHandshake(identity);

    expect(() =>
      validateHandshake(
        { ...handshake, edPublicKey: attacker.edPublicKey },
        TRANSPORT_A,
        HANDSHAKE_HASH,
        NOW,
      ),
    ).toThrow(/signature/i);
  });

  it('rejects a claimed Noise key that differs from socket.remotePublicKey', () => {
    const identity = generateIdentity();
    const handshake = signedHandshake(identity, TRANSPORT_A);

    expect(() =>
      validateHandshake(handshake, TRANSPORT_B, HANDSHAKE_HASH, NOW),
    ).toThrow(/does not match the transport/i);
  });

  it('rejects a stale timestamp', () => {
    const identity = generateIdentity();
    const timestamp = NOW - TIMESTAMP_TOLERANCE_MS - 1;
    const handshake = signedHandshake(
      identity,
      TRANSPORT_A,
      HANDSHAKE_HASH,
      timestamp,
    );

    expect(() =>
      validateHandshake(handshake, TRANSPORT_A, HANDSHAKE_HASH, NOW),
    ).toThrow(/timestamp out of range/i);
  });

  it('rejects an in-range timestamp substituted after signing', () => {
    const identity = generateIdentity();
    const handshake = signedHandshake(identity);

    expect(() =>
      validateHandshake(
        { ...handshake, timestamp: handshake.timestamp + 1 },
        TRANSPORT_A,
        HANDSHAKE_HASH,
        NOW,
      ),
    ).toThrow(/signature/i);
  });

  it('rejects unsupported protocol versions', () => {
    const identity = generateIdentity();
    const handshake = signedHandshake(identity);

    expect(() =>
      validateHandshake(
        { ...handshake, protocolVersion: HANDSHAKE_PROTOCOL_VERSION + 1 },
        TRANSPORT_A,
        HANDSHAKE_HASH,
        NOW,
      ),
    ).toThrow(/unsupported handshake protocol version/i);
  });

  it('rejects replay on a different Noise session', () => {
    const identity = generateIdentity();
    const handshake = signedHandshake(identity);
    const differentHandshakeHash = new Uint8Array(64).fill(0xd4);

    expect(() =>
      validateHandshake(
        handshake,
        TRANSPORT_A,
        differentHandshakeHash,
        NOW,
      ),
    ).toThrow(/signature/i);
  });
});

class LocalNoiseSocket extends EventEmitter {
  peer?: LocalNoiseSocket;
  lastWrite?: Uint8Array;
  ended = false;

  constructor(
    readonly publicKey: Buffer,
    readonly remotePublicKey: Buffer,
    readonly handshakeHash: Buffer,
  ) {
    super();
  }

  write(data: Uint8Array): boolean {
    this.lastWrite = data.slice();
    queueMicrotask(() => this.peer?.emit('data', Buffer.from(data)));
    return true;
  }

  end(): void {
    this.ended = true;
    this.emit('close');
  }

  destroy(): void {
    this.end();
  }
}

function localNoiseSocketPair(): [LocalNoiseSocket, LocalNoiseSocket] {
  const a = new LocalNoiseSocket(
    Buffer.from(TRANSPORT_A),
    Buffer.from(TRANSPORT_B),
    Buffer.from(HANDSHAKE_HASH),
  );
  const b = new LocalNoiseSocket(
    Buffer.from(TRANSPORT_B),
    Buffer.from(TRANSPORT_A),
    Buffer.from(HANDSHAKE_HASH),
  );
  a.peer = b;
  b.peer = a;
  return [a, b];
}

describe('performHandshake over local sockets', () => {
  it('has each peer claim and sign its own local Noise public key', async () => {
    const alice = generateIdentity('Alice');
    const bob = generateIdentity('Bob');
    const [aliceSocket, bobSocket] = localNoiseSocketPair();

    const [aliceResult, bobResult] = await Promise.all([
      performHandshake(aliceSocket, alice),
      performHandshake(bobSocket, bob),
    ]);

    expect(aliceResult.peerPublicKey).toEqual(bob.edPublicKey);
    expect(aliceResult.peerNoisePublicKey).toEqual(TRANSPORT_B);
    expect(bobResult.peerPublicKey).toEqual(alice.edPublicKey);
    expect(bobResult.peerNoisePublicKey).toEqual(TRANSPORT_A);
    expect(aliceResult.session.state).toBe('verified');
    expect(bobResult.session.state).toBe('verified');
  });

  it('closes the socket when the peer identity is not bound to the transport', async () => {
    const alice = generateIdentity('Alice');
    const mallory = generateIdentity('Mallory');
    const [aliceSocket, mallorySocket] = localNoiseSocketPair();
    const handshake = performHandshake(aliceSocket, alice);

    await new Promise((resolve) => setImmediate(resolve));
    mallorySocket.write(
      frameMessage(
        signedHandshake(mallory, TRANSPORT_A, HANDSHAKE_HASH, Date.now()),
      ),
    );

    await expect(handshake).rejects.toThrow(/does not match the transport/i);
    expect(aliceSocket.ended).toBe(true);
  });

  it('closes instead of replacing identity after the connection is verified', async () => {
    const alice = generateIdentity('Alice');
    const bob = generateIdentity('Bob');
    const [aliceSocket, bobSocket] = localNoiseSocketPair();
    const [aliceResult] = await Promise.all([
      performHandshake(aliceSocket, alice),
      performHandshake(bobSocket, bob),
    ]);

    const replacement = signedHandshake(
      generateIdentity('Mallory'),
      TRANSPORT_B,
      HANDSHAKE_HASH,
      Date.now(),
    );
    bobSocket.write(frameMessage(replacement));
    await new Promise((resolve) => setImmediate(resolve));

    expect(aliceResult.session.state).toBe('closed');
    expect(aliceResult.session.peerPublicKey).toEqual(bob.edPublicKey);
  });
});
