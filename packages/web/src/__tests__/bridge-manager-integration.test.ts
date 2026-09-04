import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    async flush(): Promise<void> {}
    async destroy(): Promise<void> {}
  }
  return { default: MockHyperswarm };
});

import { TTYAManager, type TTYARequest } from '@networkselfmd/node';
import { TTYABridge } from '../bridge.js';
import type { TTYAResponse } from '../types.js';

class LocalNoiseSocket extends EventEmitter {
  peer: LocalNoiseSocket | null = null;
  readonly writes: Buffer[] = [];
  readonly handshakeHash: Buffer;
  readonly remotePublicKey: Buffer;
  destroyed = false;

  constructor(bindingByte: number, peerByte: number) {
    super();
    this.handshakeHash = Buffer.alloc(64, bindingByte);
    this.remotePublicKey = Buffer.alloc(32, peerByte);
  }

  write(data: Uint8Array): boolean {
    const copy = Buffer.from(data);
    this.writes.push(copy);
    // Deliberately fragment every write, exercising both incremental parsers.
    this.peer?.emit('data', copy.subarray(0, Math.min(3, copy.length)));
    if (copy.length > 3) this.peer?.emit('data', copy.subarray(3));
    return true;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('close');
  }
}

function socketPair(
  managerBindingByte = 0x41,
  bridgeBindingByte = managerBindingByte,
): [LocalNoiseSocket, LocalNoiseSocket] {
  const managerSocket = new LocalNoiseSocket(managerBindingByte, 0x51);
  const bridgeSocket = new LocalNoiseSocket(bridgeBindingByte, 0x52);
  managerSocket.peer = bridgeSocket;
  bridgeSocket.peer = managerSocket;
  return [managerSocket, bridgeSocket];
}

function request(visitorId: string): TTYARequest {
  return {
    type: 0x07,
    visitorId,
    action: 'message',
    content: 'hello from a real bridge',
    metadata: { ipHash: 'hashed-ip', timestamp: Date.now() },
  };
}

function wireType(wire: Buffer): unknown {
  const length = wire.readUInt32BE(0);
  return (
    JSON.parse(wire.subarray(4, 4 + length).toString('utf8')) as {
      type?: unknown;
    }
  ).type;
}

const secret = Buffer.alloc(32, 0x73);
const publicKey = Buffer.alloc(32, 0x71);

describe('TTYA bridge and manager integration', () => {
  let manager: TTYAManager;
  let bridge: TTYABridge;
  let managerSwarm: EventEmitter;
  let bridgeSwarm: EventEmitter;

  beforeEach(async () => {
    mockState.swarmInstances.length = 0;
    manager = new TTYAManager(publicKey, secret);
    bridge = new TTYABridge(publicKey, secret);
    await manager.start();
    await bridge.connect();
    managerSwarm = mockState.swarmInstances[0] as EventEmitter;
    bridgeSwarm = mockState.swarmInstances[1] as EventEmitter;
  });

  afterEach(async () => {
    await bridge.disconnect();
    await manager.stop();
    vi.useRealTimers();
  });

  it('authenticates end to end and binds requests and responses to the session', () => {
    const responses: TTYAResponse[] = [];
    bridge.onAgentResponse((response) => responses.push(response));
    bridge.sendToAgent(request('visitor-1'));
    const [managerSocket, bridgeSocket] = socketPair();

    // Bridge must be listening before the manager synchronously sends challenge.
    bridgeSwarm.emit('connection', bridgeSocket, {});
    managerSwarm.emit('connection', managerSocket, {});

    expect(bridge.isConnected).toBe(true);
    expect(manager.getPending()).toEqual([
      expect.objectContaining({
        visitorId: 'visitor-1',
        firstMessage: 'hello from a real bridge',
      }),
    ]);

    manager.approve('visitor-1');
    expect(responses).toEqual([
      expect.objectContaining({ visitorId: 'visitor-1', action: 'approve' }),
    ]);
    expect(
      managerSocket.writes.some((wire) =>
        wire.includes(Buffer.from('visitor-1')),
      ),
    ).toBe(false);
  });

  it('blocks a full two-socket relay whose Noise transcripts differ', () => {
    bridge.sendToAgent(request('must-stay-private'));
    const [managerSocket, bridgeSocket] = socketPair(0x41, 0x42);

    bridgeSwarm.emit('connection', bridgeSocket, {});
    managerSwarm.emit('connection', managerSocket, {});

    expect(managerSocket.destroyed).toBe(true);
    expect(bridge.isConnected).toBe(false);
    expect(manager.getPending()).toEqual([]);
    expect(bridgeSocket.writes.map(wireType)).toEqual(['ttya-auth-response']);
  });

  it('keeps an incumbent candidate during concurrent connection attempts and reconnects cleanly', () => {
    const [managerSocket, bridgeSocket] = socketPair();
    bridgeSwarm.emit('connection', bridgeSocket, {});

    const rogueBridgeSocket = new LocalNoiseSocket(0x43, 0x53);
    bridgeSwarm.emit('connection', rogueBridgeSocket, {});
    expect(rogueBridgeSocket.destroyed).toBe(true);
    expect(bridgeSocket.destroyed).toBe(false);

    managerSwarm.emit('connection', managerSocket, {});
    expect(bridge.isConnected).toBe(true);

    managerSocket.destroy();
    bridgeSocket.destroy();
    const [reconnectedManager, reconnectedBridge] = socketPair(0x44, 0x44);
    bridgeSwarm.emit('connection', reconnectedBridge, {});
    managerSwarm.emit('connection', reconnectedManager, {});
    managerSocket.emit('close');
    bridgeSocket.emit('close');
    expect(bridge.isConnected).toBe(true);
    bridge.sendToAgent(request('after-reconnect'));
    expect(manager.getPending()).toEqual([
      expect.objectContaining({ visitorId: 'after-reconnect' }),
    ]);
  });

  it('times out a bridge candidate that never sends a challenge', () => {
    vi.useFakeTimers();
    const bridgeSocket = new LocalNoiseSocket(0x45, 0x55);
    bridgeSwarm.emit('connection', bridgeSocket, {});

    vi.advanceTimersByTime(5_000);
    expect(bridgeSocket.destroyed).toBe(true);
    expect(bridge.isConnected).toBe(false);

    const immediateRetry = new LocalNoiseSocket(0x45, 0x55);
    bridgeSwarm.emit('connection', immediateRetry, {});
    expect(immediateRetry.destroyed).toBe(true);
  });
});
