import { EventEmitter } from 'node:events';
import NoiseSecretStream from '@hyperswarm/secret-stream';
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
  HANDSHAKE_TRANSCRIPT_LENGTH,
  performHandshake,
  TIMESTAMP_TOLERANCE_MS,
  validateHandshake,
} from '../network/handshake.js';
import {
  MAX_COALESCED_HANDSHAKE_TAIL_BYTES,
  PeerSession,
} from '../network/connection.js';
import { SwarmManager } from '../network/swarm.js';

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
        { ...handshake, protocolVersion: 1 },
        TRANSPORT_A,
        HANDSHAKE_HASH,
        NOW,
      ),
    ).toThrow(/incompatible handshake protocol version.*local=2.*remote=1/i);
  });

  it('uses the documented fixed canonical transcript layout', () => {
    const timestamp = 0x010203040506;
    const payload = createHandshakeSigningPayload(
      HANDSHAKE_PROTOCOL_VERSION,
      TRANSPORT_A,
      TRANSPORT_B,
      timestamp,
      HANDSHAKE_HASH,
    );

    expect(payload).toHaveLength(HANDSHAKE_TRANSCRIPT_LENGTH);
    expect(payload).toHaveLength(178);
    expect(new TextDecoder().decode(payload.slice(0, 37))).toBe(
      'network.self.md/identity-handshake/v2',
    );
    expect(payload[37]).toBe(0);
    expect(new DataView(payload.buffer).getUint32(38, false)).toBe(2);
    expect(payload.slice(42, 74)).toEqual(TRANSPORT_A);
    expect(payload.slice(74, 106)).toEqual(TRANSPORT_B);
    expect(new DataView(payload.buffer).getBigUint64(106, false)).toBe(
      BigInt(timestamp),
    );
    expect(payload.slice(114, 178)).toEqual(HANDSHAKE_HASH);
  });

  it('rejects variable-length transcript fields', () => {
    expect(() =>
      createHandshakeSigningPayload(
        HANDSHAKE_PROTOCOL_VERSION,
        TRANSPORT_A.slice(1),
        TRANSPORT_B,
        NOW,
        HANDSHAKE_HASH,
      ),
    ).toThrow(/noise public key/i);
  });

  it('rejects replay on a different Noise session', () => {
    const identity = generateIdentity();
    const handshake = signedHandshake(identity);
    const differentHandshakeHash = new Uint8Array(64).fill(0xd4);

    expect(() =>
      validateHandshake(handshake, TRANSPORT_A, differentHandshakeHash, NOW),
    ).toThrow(/signature/i);
  });
});

class LocalNoiseSocket extends EventEmitter {
  peer?: LocalNoiseSocket;
  lastWrite?: Uint8Array;
  ended = false;
  destroyed = false;
  endCalls = 0;
  destroyCalls = 0;

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
    this.endCalls++;
    this.ended = true;
    this.emit('close');
  }

  destroy(): void {
    this.destroyCalls++;
    this.destroyed = true;
    this.emit('close');
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

const sampleAck = (messageId: string) =>
  ({
    type: MessageType.Ack,
    messageId,
    timestamp: NOW,
  }) as const;

function concatFrames(
  ...messages: Parameters<typeof frameMessage>[0][]
): Buffer {
  return Buffer.concat(
    messages.map((message) => Buffer.from(frameMessage(message))),
  );
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
    expect(aliceSocket.destroyed).toBe(true);
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
    expect(aliceSocket.destroyed).toBe(true);
  });

  it('rejects a pre-authentication application-frame flood without buffering it', async () => {
    const alice = generateIdentity('Alice');
    const [aliceSocket, peerSocket] = localNoiseSocketPair();
    const handshake = performHandshake(aliceSocket, alice);
    const flood = concatFrames(
      ...Array.from({ length: 2_000 }, (_, index) =>
        sampleAck(`pre-auth-${index}`),
      ),
    );

    peerSocket.write(flood);

    await expect(handshake).rejects.toThrow(/before identity authentication/i);
    expect(aliceSocket.destroyCalls).toBe(1);
    expect(aliceSocket.destroyed).toBe(true);
  });

  it('accepts split handshake framing and a bounded coalesced follow-up', async () => {
    const alice = generateIdentity('Alice');
    const bob = generateIdentity('Bob');
    const [aliceSocket, bobSocket] = localNoiseSocketPair();
    const handshake = performHandshake(aliceSocket, alice);
    const handshakeFrame = frameMessage(
      signedHandshake(bob, TRANSPORT_B, HANDSHAKE_HASH, Date.now()),
    );
    const splitAt = Math.floor(handshakeFrame.length / 2);

    bobSocket.write(handshakeFrame.slice(0, splitAt));
    bobSocket.write(
      Buffer.concat([
        Buffer.from(handshakeFrame.slice(splitAt)),
        Buffer.from(frameMessage(sampleAck('coalesced-tail'))),
      ]),
    );

    const result = await handshake;
    const received: unknown[] = [];
    result.session.on('message', (message) => received.push(message));
    expect(result.session.state).toBe('verified');
    result.session.setReady();
    expect(received).toEqual([sampleAck('coalesced-tail')]);
  });

  it('bounds and retains an authenticated tail split across data chunks', async () => {
    const alice = generateIdentity('Alice');
    const bob = generateIdentity('Bob');
    const [aliceSocket, bobSocket] = localNoiseSocketPair();
    const handshake = performHandshake(aliceSocket, alice);

    bobSocket.write(
      frameMessage(
        signedHandshake(bob, TRANSPORT_B, HANDSHAKE_HASH, Date.now()),
      ),
    );
    bobSocket.write(frameMessage(sampleAck('separate-pre-ready-chunk')));

    const result = await handshake;
    const received: unknown[] = [];
    result.session.on('message', (message) => received.push(message));
    result.session.setReady();

    expect(received).toEqual([sampleAck('separate-pre-ready-chunk')]);
    expect(aliceSocket.destroyCalls).toBe(0);
  });

  it('destroys the stream for a duplicate handshake before a coalesced follow-up', async () => {
    const alice = generateIdentity('Alice');
    const bob = generateIdentity('Bob');
    const [aliceSocket, bobSocket] = localNoiseSocketPair();
    const handshake = performHandshake(aliceSocket, alice);
    const peerHandshake = signedHandshake(
      bob,
      TRANSPORT_B,
      HANDSHAKE_HASH,
      Date.now(),
    );

    bobSocket.write(
      concatFrames(peerHandshake, peerHandshake, sampleAck('must-not-deliver')),
    );

    await expect(handshake).rejects.toThrow(/already completed/i);
    expect(aliceSocket.destroyCalls).toBe(1);
  });

  it('destroys an oversized coalesced post-handshake tail', async () => {
    const alice = generateIdentity('Alice');
    const bob = generateIdentity('Bob');
    const [aliceSocket, bobSocket] = localNoiseSocketPair();
    const handshake = performHandshake(aliceSocket, alice);
    const oversizedTail = sampleAck(
      'x'.repeat(MAX_COALESCED_HANDSHAKE_TAIL_BYTES),
    );

    bobSocket.write(
      concatFrames(
        signedHandshake(bob, TRANSPORT_B, HANDSHAKE_HASH, Date.now()),
        oversizedTail,
      ),
    );

    await expect(handshake).rejects.toThrow(
      /coalesced post-handshake data limit/i,
    );
    expect(aliceSocket.destroyCalls).toBe(1);
  });
});

describe('PeerSession lifecycle', () => {
  it('is terminal after close and ignores post-close delivery', () => {
    const [socket] = localNoiseSocketPair();
    const session = new PeerSession(socket);
    session.state = 'ready';
    const received: unknown[] = [];
    let closeEvents = 0;
    session.on('message', (message) => received.push(message));
    session.on('close', () => closeEvents++);

    session.close();
    session.close();
    socket.emit('data', Buffer.from(frameMessage(sampleAck('late'))));
    socket.emit('close');
    socket.emit('end');
    socket.emit(
      'error',
      Object.assign(new Error('late reset'), { code: 'ECONNRESET' }),
    );

    expect(session.state).toBe('closed');
    expect(socket.endCalls).toBe(1);
    expect(closeEvents).toBe(1);
    expect(received).toEqual([]);
    expect(() => session.send(sampleAck('outbound-late'))).toThrow(/closed/i);
  });

  it('destroys malformed protocol frames', () => {
    const [socket] = localNoiseSocketPair();
    const session = new PeerSession(socket);
    session.state = 'ready';
    session.on('error', () => undefined);
    const oversized = Buffer.alloc(4);
    oversized.writeUInt32BE(1_048_577);

    socket.emit('data', oversized);

    expect(session.state).toBe('closed');
    expect(socket.destroyCalls).toBe(1);
  });
});

describe('SwarmManager session replacement', () => {
  it('keeps the replacement when the old session closes again', async () => {
    const alice = generateIdentity('Alice');
    const bob = generateIdentity('Bob');
    const manager = new SwarmManager({ identity: alice });
    manager.on('error', () => undefined);
    const handleConnection = (socket: LocalNoiseSocket): Promise<void> =>
      (
        manager as unknown as {
          handleConnection(
            socket: LocalNoiseSocket,
            peerInfo: unknown,
          ): Promise<void>;
        }
      ).handleConnection(socket, undefined);

    const [firstLocal, firstRemote] = localNoiseSocketPair();
    const [, firstRemoteResult] = await Promise.all([
      handleConnection(firstLocal),
      performHandshake(firstRemote, bob),
    ]);
    const firstSession = manager.getSession(bob.fingerprint);
    expect(firstSession).toBeDefined();

    const [replacementLocal, replacementRemote] = localNoiseSocketPair();
    const [, replacementRemoteResult] = await Promise.all([
      handleConnection(replacementLocal),
      performHandshake(replacementRemote, bob),
    ]);
    const replacement = manager.getSession(bob.fingerprint);

    expect(replacement).toBeDefined();
    expect(replacement).not.toBe(firstSession);
    expect(firstSession?.state).toBe('closed');
    firstSession?.emit('close');
    expect(manager.getSession(bob.fingerprint)).toBe(replacement);

    firstRemoteResult.session.close();
    replacementRemoteResult.session.close();
    replacement?.close();
  });
});

async function realNoiseSocketPair(
  initiatorKeyPair: ReturnType<typeof NoiseSecretStream.keyPair>,
  responderKeyPair: ReturnType<typeof NoiseSecretStream.keyPair>,
): Promise<[NoiseSecretStream, NoiseSecretStream]> {
  const initiator = new NoiseSecretStream(true, undefined, {
    keyPair: initiatorKeyPair,
  });
  const responder = new NoiseSecretStream(false, undefined, {
    keyPair: responderKeyPair,
  });
  initiator.rawStream.pipe(responder.rawStream).pipe(initiator.rawStream);
  await Promise.all([initiator.opened, responder.opened]);
  return [initiator, responder];
}

describe('real Noise transport binding', () => {
  it('authenticates real Noise metadata and rejects replay on a new session', async () => {
    const aliceIdentity = generateIdentity('Alice');
    const bobIdentity = generateIdentity('Bob');
    const aliceNoise = NoiseSecretStream.keyPair(Buffer.alloc(32, 0x11));
    const bobNoise = NoiseSecretStream.keyPair(Buffer.alloc(32, 0x22));
    const [firstAliceSocket, firstBobSocket] = await realNoiseSocketPair(
      aliceNoise,
      bobNoise,
    );

    const [aliceResult, bobResult] = await Promise.all([
      performHandshake(firstAliceSocket, aliceIdentity),
      performHandshake(firstBobSocket, bobIdentity),
    ]);
    expect(aliceResult.peerNoisePublicKey).toEqual(
      new Uint8Array(firstAliceSocket.remotePublicKey),
    );
    expect(bobResult.peerNoisePublicKey).toEqual(
      new Uint8Array(firstBobSocket.remotePublicKey),
    );

    const captured = signedHandshake(
      bobIdentity,
      new Uint8Array(firstAliceSocket.remotePublicKey),
      new Uint8Array(firstAliceSocket.handshakeHash),
      Date.now(),
    );
    const [secondAliceSocket, secondBobSocket] = await realNoiseSocketPair(
      aliceNoise,
      bobNoise,
    );
    expect(secondAliceSocket.handshakeHash).not.toEqual(
      firstAliceSocket.handshakeHash,
    );
    expect(() =>
      validateHandshake(
        captured,
        new Uint8Array(secondAliceSocket.remotePublicKey),
        new Uint8Array(secondAliceSocket.handshakeHash),
      ),
    ).toThrow(/signature/i);

    aliceResult.session.close();
    bobResult.session.close();
    secondAliceSocket.destroy();
    secondBobSocket.destroy();
  });
});
