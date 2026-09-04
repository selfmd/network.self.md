import { EventEmitter } from 'node:events';
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TTYA_AUTH_VERSION,
  buildTTYAAuthProofPayload,
  type TTYAAuthChallengeFrame,
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

import { TTYAManager, type TTYARequest } from '../ttya/ttya-manager.js';

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

const authSecret = Buffer.from('shared-test-secret');

describe('TTYAManager mutual authentication', () => {
  let manager: TTYAManager;
  let swarm: EventEmitter;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    mockState.swarmInstances.length = 0;
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    manager = new TTYAManager(Buffer.alloc(32, 7), authSecret);
    await manager.start();
    swarm = mockState.swarmInstances[0] as EventEmitter;
  });

  afterEach(async () => {
    await manager.stop();
    warnSpy.mockRestore();
  });

  function authenticate(connection: MockConnection): void {
    swarm.emit('connection', connection, {});
    const challenge = parseFrame<TTYAAuthChallengeFrame>(connection.writes[0]);
    const bridgeNonce = '22'.repeat(32);
    const proof = createHmac('sha256', authSecret)
      .update(
        buildTTYAAuthProofPayload(
          'bridge',
          challenge.agentNonce,
          bridgeNonce,
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
  }

  it('verifies the bridge and returns an agent proof before accepting requests', () => {
    const requests: unknown[] = [];
    manager.on('visitor:request', (request) => requests.push(request));
    const connection = new MockConnection();
    authenticate(connection);

    expect(parseFrame(connection.writes[1])).toEqual(
      expect.objectContaining({
        type: 'ttya-auth-confirmation',
        version: TTYA_AUTH_VERSION,
      }),
    );

    connection.emit('data', frame(visitorRequest('authenticated')));
    expect(requests).toEqual([
      expect.objectContaining({ visitorId: 'authenticated' }),
    ]);
  });

  it('drops a forged bridge proof and ignores plaintext in the same packet', () => {
    const requests: unknown[] = [];
    manager.on('visitor:request', (request) => requests.push(request));
    const connection = new MockConnection();
    swarm.emit('connection', connection, {});
    const challenge = parseFrame<TTYAAuthChallengeFrame>(connection.writes[0]);

    connection.emit(
      'data',
      Buffer.concat([
        frame({
          type: 'ttya-auth-response',
          version: TTYA_AUTH_VERSION,
          agentNonce: challenge.agentNonce,
          bridgeNonce: '22'.repeat(32),
          proof: '00'.repeat(32),
        }),
        frame(visitorRequest('forged')),
      ]),
    );

    expect(connection.destroyed).toBe(true);
    expect(requests).toEqual([]);
    expect(connection.writes).toHaveLength(1);
  });

  it('replaces an unauthenticated peer and ignores its later close event', () => {
    const rogue = new MockConnection();
    swarm.emit('connection', rogue, {});

    const bridge = new MockConnection();
    authenticate(bridge);
    rogue.emit('close');

    bridge.emit('data', frame(visitorRequest('reconnected')));
    expect(rogue.destroyed).toBe(true);
    expect(manager.getPending()).toEqual([
      expect.objectContaining({ visitorId: 'reconnected' }),
    ]);
  });
});
