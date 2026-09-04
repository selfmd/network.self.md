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
import type { TTYARequest, TTYAResponse } from '../types.js';

class MockConnection extends EventEmitter {
  readonly writes: Buffer[] = [];
  destroyed = false;

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

function request(visitorId: string, content: string): TTYARequest {
  return {
    type: 0x07,
    visitorId,
    action: 'message',
    content,
    metadata: { ipHash: 'hashed-ip', timestamp: 1 },
  };
}

const authSecret = Buffer.from('shared-test-secret');
const agentPublicKey = Buffer.alloc(32, 7);

describe('TTYABridge mutual authentication', () => {
  let bridge: TTYABridge;
  let swarm: EventEmitter;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    mockState.swarmInstances.length = 0;
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    bridge = new TTYABridge(agentPublicKey, authSecret);
    await bridge.connect();
    swarm = mockState.swarmInstances[0] as EventEmitter;
  });

  afterEach(async () => {
    await bridge.disconnect();
    warnSpy.mockRestore();
  });

  function beginHandshake(
    connection: MockConnection,
    agentNonce = '11'.repeat(32),
  ): TTYAAuthResponseFrame {
    swarm.emit('connection', connection, {});
    connection.emit(
      'data',
      frame({
        type: 'ttya-auth-challenge',
        version: TTYA_AUTH_VERSION,
        agentNonce,
      }),
    );
    return parseFrame(connection.writes[0]) as unknown as TTYAAuthResponseFrame;
  }

  function finishHandshake(
    connection: MockConnection,
    response: TTYAAuthResponseFrame,
  ): void {
    const proof = createHmac('sha256', authSecret)
      .update(
        buildTTYAAuthProofPayload(
          'agent',
          response.agentNonce,
          response.bridgeNonce,
        ),
      )
      .digest('hex');
    connection.emit(
      'data',
      frame({
        type: 'ttya-auth-confirmation',
        version: TTYA_AUTH_VERSION,
        agentNonce: response.agentNonce,
        bridgeNonce: response.bridgeNonce,
        proof,
      }),
    );
  }

  it('releases queued plaintext only after the agent proves the full transcript', () => {
    bridge.sendToAgent(request('queued', 'private queued message'));
    const connection = new MockConnection();
    const response = beginHandshake(connection);

    expect(bridge.isConnected).toBe(false);
    expect(connection.writes.map(parseFrame)).toEqual([
      expect.objectContaining({ type: 'ttya-auth-response' }),
    ]);

    finishHandshake(connection, response);

    expect(bridge.isConnected).toBe(true);
    expect(connection.writes.map(parseFrame)).toContainEqual(
      expect.objectContaining({
        type: 0x07,
        visitorId: 'queued',
        content: 'private queued message',
      }),
    );
  });

  it('gives a peer with only a chosen challenge no queued or future requests', () => {
    bridge.sendToAgent(request('queued', 'queued secret'));
    const rogue = new MockConnection();
    beginHandshake(rogue, '00'.repeat(32));

    bridge.sendToAgent(request('future', 'future secret'));

    const wireMessages = rogue.writes.map(parseFrame);
    expect(wireMessages).toHaveLength(1);
    expect(wireMessages[0].type).toBe('ttya-auth-response');
    expect(wireMessages).not.toContainEqual(expect.objectContaining({ type: 0x07 }));
    expect(bridge.isConnected).toBe(false);
  });

  it('closes an oversized authentication frame before allocating its payload', () => {
    bridge.sendToAgent(request('queued', 'never released'));
    const rogue = new MockConnection();
    swarm.emit('connection', rogue, {});
    const oversizedHeader = Buffer.alloc(4);
    oversizedHeader.writeUInt32BE(MAX_TTYA_FRAME_SIZE + 1, 0);

    rogue.emit('data', oversizedHeader);

    expect(rogue.destroyed).toBe(true);
    expect(rogue.writes).toEqual([]);
    expect(bridge.isConnected).toBe(false);
  });

  it.each(['approve', 'reject', 'reply'] as const)(
    'rejects a forged %s response before agent authentication',
    (action) => {
      const received: TTYAResponse[] = [];
      bridge.onAgentResponse((response) => received.push(response));
      const rogue = new MockConnection();
      beginHandshake(rogue);

      rogue.emit(
        'data',
        frame({
          type: 0x08,
          visitorId: 'victim',
          action,
          content: action === 'reply' ? 'forged' : undefined,
        }),
      );

      expect(received).toEqual([]);
      expect(rogue.destroyed).toBe(true);
      expect(bridge.isConnected).toBe(false);
    },
  );

  it('reconnects after a rogue peer without stale socket events losing state', () => {
    bridge.sendToAgent(request('queued', 'survives reconnect'));
    const rogue = new MockConnection();
    const rogueResponse = beginHandshake(rogue);
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
    expect(rogue.destroyed).toBe(true);

    const agent = new MockConnection();
    const response = beginHandshake(agent, '44'.repeat(32));
    finishHandshake(agent, response);
    rogue.emit('close');

    expect(bridge.isConnected).toBe(true);
    expect(agent.writes.map(parseFrame)).toContainEqual(
      expect.objectContaining({ visitorId: 'queued', content: 'survives reconnect' }),
    );

    bridge.sendToAgent(request('future', 'on authenticated reconnect'));
    expect(agent.writes.map(parseFrame)).toContainEqual(
      expect.objectContaining({ visitorId: 'future' }),
    );
  });
});
