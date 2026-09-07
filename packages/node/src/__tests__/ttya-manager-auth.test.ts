import { EventEmitter } from 'node:events';
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_TTYA_FRAME_SIZE,
  TTYA_AUTH_VERSION,
  buildTTYAAuthProofPayload,
  buildTTYADataProofPayload,
  buildTTYASessionKeyPayload,
  type TTYAAuthChallengeFrame,
  type TTYADataFrame,
} from '@networkselfmd/core';

const mockState = vi.hoisted(() => ({ swarmInstances: [] as unknown[] }));

vi.mock('hyperswarm', async () => {
  const { EventEmitter: MockEventEmitter } = await import('node:events');
  class MockHyperswarm extends MockEventEmitter {
    constructor() {
      super();
      mockState.swarmInstances.push(this);
    }
    join(): { flushed: () => Promise<void> } {
      return { flushed: async () => {} };
    }
    async destroy(): Promise<void> {}
  }
  return { default: MockHyperswarm };
});

import {
  MAX_TTYA_AUTH_CANDIDATES,
  TTYAManager,
  type TTYARequest,
} from '../ttya/ttya-manager.js';

class MockConnection extends EventEmitter {
  readonly writes: Buffer[] = [];
  readonly handshakeHash: Buffer;
  readonly remotePublicKey: Buffer;
  destroyed = false;

  constructor(bindingByte = 0x41, peerByte = 0x51) {
    super();
    this.handshakeHash = Buffer.alloc(64, bindingByte);
    this.remotePublicKey = Buffer.alloc(32, peerByte);
  }

  write(data: Uint8Array): boolean {
    this.writes.push(Buffer.from(data));
    return true;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('close');
  }
}

function frame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), 'utf8');
  const result = Buffer.alloc(4 + payload.length);
  result.writeUInt32BE(payload.length, 0);
  payload.copy(result, 4);
  return result;
}

function parseFrame<T>(value: Buffer): T {
  const length = value.readUInt32BE(0);
  return JSON.parse(value.subarray(4, 4 + length).toString('utf8')) as T;
}

function visitorRequest(visitorId: string): TTYARequest {
  return {
    type: 0x07,
    visitorId,
    action: 'message',
    content: 'visitor plaintext',
    metadata: { ipHash: 'hashed-ip', timestamp: 1 },
  };
}

const authSecret = Buffer.alloc(32, 0x61);

describe('TTYAManager mutual authentication', () => {
  let manager: TTYAManager;
  let swarm: EventEmitter;

  beforeEach(async () => {
    mockState.swarmInstances.length = 0;
    manager = new TTYAManager(Buffer.alloc(32, 7), authSecret);
    await manager.start();
    swarm = mockState.swarmInstances[0] as EventEmitter;
  });

  afterEach(async () => {
    await manager.stop();
    vi.useRealTimers();
  });

  function authenticate(connection: MockConnection): Buffer {
    swarm.emit('connection', connection, {});
    const challenge = parseFrame<TTYAAuthChallengeFrame>(connection.writes[0]);
    const bridgeNonce = '22'.repeat(32);
    const proof = createHmac('sha256', authSecret)
      .update(
        buildTTYAAuthProofPayload(
          'bridge',
          challenge.agentNonce,
          bridgeNonce,
          connection.handshakeHash,
        ),
      )
      .digest('hex');
    connection.emit(
      'data',
      frame({
        type: 'ttya-auth-response',
        version: TTYA_AUTH_VERSION,
        agentNonce: challenge.agentNonce,
        bridgeNonce,
        proof,
      }),
    );
    return createHmac('sha256', authSecret)
      .update(
        buildTTYASessionKeyPayload(
          challenge.agentNonce,
          bridgeNonce,
          connection.handshakeHash,
        ),
      )
      .digest();
  }

  function applicationFrame(
    request: TTYARequest,
    sessionKey: Uint8Array,
    sequence = 0,
  ): Buffer {
    const payload = Buffer.from(JSON.stringify(request), 'utf8');
    const value: TTYADataFrame = {
      type: 'ttya-data',
      version: TTYA_AUTH_VERSION,
      sequence,
      payload: payload.toString('base64'),
      proof: createHmac('sha256', sessionKey)
        .update(buildTTYADataProofPayload('bridge-to-agent', sequence, payload))
        .digest('hex'),
    };
    return frame(value);
  }

  it('handles fragmented auth and coalesced ordered application frames', () => {
    const requests: unknown[] = [];
    manager.on('visitor:request', (request) => requests.push(request));
    const connection = new MockConnection();
    swarm.emit('connection', connection, {});
    const challenge = parseFrame<TTYAAuthChallengeFrame>(connection.writes[0]);
    const bridgeNonce = '22'.repeat(32);
    const response = frame({
      type: 'ttya-auth-response',
      version: TTYA_AUTH_VERSION,
      agentNonce: challenge.agentNonce,
      bridgeNonce,
      proof: createHmac('sha256', authSecret)
        .update(
          buildTTYAAuthProofPayload(
            'bridge',
            challenge.agentNonce,
            bridgeNonce,
            connection.handshakeHash,
          ),
        )
        .digest('hex'),
    });
    connection.emit('data', response.subarray(0, 3));
    connection.emit('data', response.subarray(3));
    const sessionKey = createHmac('sha256', authSecret)
      .update(
        buildTTYASessionKeyPayload(
          challenge.agentNonce,
          bridgeNonce,
          connection.handshakeHash,
        ),
      )
      .digest();

    connection.emit(
      'data',
      Buffer.concat([
        applicationFrame(visitorRequest('first'), sessionKey, 0),
        applicationFrame(visitorRequest('second'), sessionKey, 1),
      ]),
    );

    expect(requests).toEqual([
      expect.objectContaining({ visitorId: 'first' }),
      expect.objectContaining({ visitorId: 'second' }),
    ]);
  });

  it('lets a valid candidate authenticate despite a silent first socket', () => {
    const silent = new MockConnection();
    swarm.emit('connection', silent, {});
    const valid = new MockConnection(0x42, 0x52);
    authenticate(valid);

    expect(silent.destroyed).toBe(true);
    expect(valid.destroyed).toBe(false);
    expect(valid.writes).toHaveLength(2);

    const late = new MockConnection(0x43, 0x53);
    swarm.emit('connection', late, {});
    expect(late.destroyed).toBe(true);
  });

  it('bounds authentication candidates and releases capacity on close', () => {
    const candidates = Array.from(
      { length: MAX_TTYA_AUTH_CANDIDATES },
      (_, index) => new MockConnection(0x40 + index, 0x50 + index),
    );
    for (const candidate of candidates) swarm.emit('connection', candidate, {});

    const overflow = new MockConnection(0x70, 0x71);
    swarm.emit('connection', overflow, {});
    expect(overflow.destroyed).toBe(true);

    candidates[0].destroy();
    const replacement = new MockConnection(0x72, 0x73);
    swarm.emit('connection', replacement, {});
    expect(replacement.destroyed).toBe(false);
    expect(replacement.writes).toHaveLength(1);
  });

  it('rejects a proof created for a different Noise connection', () => {
    const connection = new MockConnection(0x41);
    swarm.emit('connection', connection, {});
    const challenge = parseFrame<TTYAAuthChallengeFrame>(connection.writes[0]);
    const bridgeNonce = '22'.repeat(32);
    connection.emit(
      'data',
      frame({
        type: 'ttya-auth-response',
        version: TTYA_AUTH_VERSION,
        agentNonce: challenge.agentNonce,
        bridgeNonce,
        proof: createHmac('sha256', authSecret)
          .update(
            buildTTYAAuthProofPayload(
              'bridge',
              challenge.agentNonce,
              bridgeNonce,
              Buffer.alloc(64, 0x42),
            ),
          )
          .digest('hex'),
      }),
    );
    expect(connection.destroyed).toBe(true);
  });

  it('rejects replayed application traffic and backs off the failed peer', () => {
    const connection = new MockConnection();
    const sessionKey = authenticate(connection);
    const data = applicationFrame(visitorRequest('once'), sessionKey, 0);
    connection.emit('data', data);
    connection.emit('data', data);
    expect(connection.destroyed).toBe(true);

    const immediateRetry = new MockConnection();
    swarm.emit('connection', immediateRetry, {});
    expect(immediateRetry.destroyed).toBe(false);
    // An authenticated protocol failure is not counted as an auth failure.
    expect(immediateRetry.writes).toHaveLength(1);
  });

  it('rejects oversized advertised frames before receiving a body', () => {
    const connection = new MockConnection();
    swarm.emit('connection', connection, {});
    const header = Buffer.alloc(4);
    header.writeUInt32BE(MAX_TTYA_FRAME_SIZE + 1, 0);
    connection.emit('data', header);
    expect(connection.destroyed).toBe(true);

    const retry = new MockConnection();
    swarm.emit('connection', retry, {});
    expect(retry.destroyed).toBe(true);
    expect(retry.writes).toHaveLength(0);
  });

  it('closes a stalled authentication candidate at the deadline', () => {
    vi.useFakeTimers();
    const connection = new MockConnection();
    swarm.emit('connection', connection, {});

    vi.advanceTimersByTime(4_999);
    expect(connection.destroyed).toBe(false);
    vi.advanceTimersByTime(1);
    expect(connection.destroyed).toBe(true);

    const replacement = new MockConnection(0x42, 0x52);
    authenticate(replacement);
    expect(replacement.destroyed).toBe(false);
    expect(replacement.writes).toHaveLength(2);
  });
});
