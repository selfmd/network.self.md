import { EventEmitter } from 'node:events';
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_TTYA_FRAME_SIZE,
  TTYA_AUTH_VERSION,
  buildTTYAAuthProofPayload,
  type TTYAAuthResponseFrame,
} from '@networkselfmd/core';

const mockState = vi.hoisted(() => ({ swarmInstances: [] as unknown[] }));

vi.mock('hyperswarm', async () => {
  const { EventEmitter: MockEventEmitter } = await import('node:events');
  class MockHyperswarm extends MockEventEmitter {
    constructor() {
      super();
      mockState.swarmInstances.push(this);
    }
    join(): void {}
    async flush(): Promise<void> {}
    async destroy(): Promise<void> {}
  }
  return { default: MockHyperswarm };
});

import { TTYABridge } from '../bridge.js';
import type { TTYARequest } from '../types.js';

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

function parseFrame(value: Buffer): Record<string, unknown> {
  const length = value.readUInt32BE(0);
  return JSON.parse(value.subarray(4, 4 + length).toString('utf8')) as Record<
    string,
    unknown
  >;
}

const secret = Buffer.alloc(32, 0x61);
const publicKey = Buffer.alloc(32, 0x71);

describe('TTYABridge authentication', () => {
  let bridge: TTYABridge;
  let swarm: EventEmitter;

  beforeEach(async () => {
    mockState.swarmInstances.length = 0;
    bridge = new TTYABridge(publicKey, secret);
    await bridge.connect();
    swarm = mockState.swarmInstances[0] as EventEmitter;
  });

  afterEach(async () => {
    await bridge.disconnect();
  });

  function begin(connection: MockConnection): TTYAAuthResponseFrame {
    swarm.emit('connection', connection, {});
    connection.emit(
      'data',
      frame({
        type: 'ttya-auth-challenge',
        version: TTYA_AUTH_VERSION,
        agentNonce: '11'.repeat(32),
      }),
    );
    return parseFrame(connection.writes[0]) as unknown as TTYAAuthResponseFrame;
  }

  function finish(
    connection: MockConnection,
    response: TTYAAuthResponseFrame,
  ): void {
    connection.emit(
      'data',
      frame({
        type: 'ttya-auth-confirmation',
        version: TTYA_AUTH_VERSION,
        agentNonce: response.agentNonce,
        bridgeNonce: response.bridgeNonce,
        proof: createHmac('sha256', secret)
          .update(
            buildTTYAAuthProofPayload(
              'agent',
              response.agentNonce,
              response.bridgeNonce,
              connection.handshakeHash,
            ),
          )
          .digest('hex'),
      }),
    );
  }

  it('releases queued traffic only as a session-bound data frame', () => {
    const request: TTYARequest = {
      type: 0x07,
      visitorId: 'queued',
      action: 'message',
      content: 'private',
      metadata: { ipHash: 'hash', timestamp: 1 },
    };
    bridge.sendToAgent(request);
    const connection = new MockConnection();
    const response = begin(connection);
    expect(connection.writes.map(parseFrame)).toHaveLength(1);

    finish(connection, response);

    expect(bridge.isConnected).toBe(true);
    expect(connection.writes.map(parseFrame)).toEqual([
      expect.objectContaining({ type: 'ttya-auth-response' }),
      expect.objectContaining({ type: 'ttya-data', sequence: 0 }),
    ]);
  });

  it('does not allow a new socket to evict an unauthenticated incumbent', () => {
    const incumbent = new MockConnection();
    swarm.emit('connection', incumbent, {});
    const newcomer = new MockConnection();
    swarm.emit('connection', newcomer, {});
    expect(incumbent.destroyed).toBe(false);
    expect(newcomer.destroyed).toBe(true);
  });

  it('does not release queued or future requests to a chosen-challenge peer', () => {
    const queued: TTYARequest = {
      type: 0x07,
      visitorId: 'queued',
      action: 'message',
      content: 'queued secret',
      metadata: { ipHash: 'hash', timestamp: 1 },
    };
    bridge.sendToAgent(queued);
    const connection = new MockConnection();
    begin(connection);
    bridge.sendToAgent({ ...queued, visitorId: 'future' });

    expect(connection.writes.map(parseFrame)).toEqual([
      expect.objectContaining({ type: 'ttya-auth-response' }),
    ]);
    expect(bridge.isConnected).toBe(false);
  });

  it.each(['approve', 'reject', 'reply'] as const)(
    'rejects an unwrapped forged %s response before agent authentication',
    (action) => {
      const received: unknown[] = [];
      bridge.onAgentResponse((response) => received.push(response));
      const connection = new MockConnection();
      begin(connection);
      connection.emit(
        'data',
        frame({
          type: 0x08,
          visitorId: 'victim',
          action,
          content: action === 'reply' ? 'forged' : undefined,
        }),
      );

      expect(connection.destroyed).toBe(true);
      expect(received).toEqual([]);
      expect(bridge.isConnected).toBe(false);
    },
  );

  it('rejects an oversized advertised frame before receiving its body', () => {
    const connection = new MockConnection();
    swarm.emit('connection', connection, {});
    const header = Buffer.alloc(4);
    header.writeUInt32BE(MAX_TTYA_FRAME_SIZE + 1, 0);
    connection.emit('data', header);
    expect(connection.destroyed).toBe(true);
  });

  it('reconnects after a forged confirmation without stale events losing state', () => {
    const queued: TTYARequest = {
      type: 0x07,
      visitorId: 'survivor',
      action: 'message',
      content: 'survives reconnect',
      metadata: { ipHash: 'hash', timestamp: 1 },
    };
    bridge.sendToAgent(queued);
    const rogue = new MockConnection(0x41, 0x51);
    const rogueResponse = begin(rogue);
    rogue.emit(
      'data',
      frame({
        type: 'ttya-auth-confirmation',
        version: TTYA_AUTH_VERSION,
        agentNonce: rogueResponse.agentNonce,
        bridgeNonce: rogueResponse.bridgeNonce,
        proof: '00'.repeat(32),
      }),
    );

    const agent = new MockConnection(0x42, 0x52);
    const response = begin(agent);
    finish(agent, response);
    rogue.emit('close');

    expect(bridge.isConnected).toBe(true);
    expect(agent.writes.map(parseFrame)).toContainEqual(
      expect.objectContaining({ type: 'ttya-data' }),
    );
  });
});
