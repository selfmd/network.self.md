import { describe, it, expect } from 'vitest';
import { generateIdentity } from '@networkselfmd/core';
import type { AgentIdentity } from '@networkselfmd/core';
import { performHandshake } from '../network/handshake.js';

function makeIdentity(): AgentIdentity {
  return generateIdentity();
}

function makeMockSocket(opts: { remotePublicKey: Buffer | undefined }) {
  return {
    write: () => true,
    end: () => {},
    destroy: () => {},
    on: () => {},
    removeAllListeners: () => {},
    remotePublicKey: opts.remotePublicKey,
  };
}

describe('performHandshake fail-closed on missing Noise key', () => {
  it('rejects when the socket has no remotePublicKey', async () => {
    const identity = makeIdentity();
    const socket = makeMockSocket({ remotePublicKey: undefined });

    await expect(performHandshake(socket, identity)).rejects.toThrow(
      /did not expose a Noise public key/i,
    );
  });

  it('rejects when remotePublicKey is an empty buffer', async () => {
    const identity = makeIdentity();
    const socket = makeMockSocket({ remotePublicKey: Buffer.alloc(0) });

    await expect(performHandshake(socket, identity)).rejects.toThrow(
      /did not expose a Noise public key/i,
    );
  });

  it('rejects when remotePublicKey is an all-zero 32-byte buffer', async () => {
    const identity = makeIdentity();
    const socket = makeMockSocket({ remotePublicKey: Buffer.alloc(32) });

    await expect(performHandshake(socket, identity)).rejects.toThrow(
      /did not expose a Noise public key/i,
    );
  });
});
