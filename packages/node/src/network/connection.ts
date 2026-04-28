import { EventEmitter } from 'node:events';
import {
  frameMessage,
  parseFrame,
} from '@networkselfmd/core';
import type { ProtocolMessage } from '@networkselfmd/core';

export type ConnectionState = 'connecting' | 'handshaking' | 'verified' | 'ready' | 'closed';

export class PeerSession extends EventEmitter {
  state: ConnectionState = 'connecting';
  peerPublicKey: Uint8Array | null = null;
  peerXPublicKey: Uint8Array | null = null;
  peerFingerprint: string | null = null;
  peerDisplayName: string | null = null;
  noisePublicKey: Uint8Array | null = null;

  private buffer: Buffer = Buffer.alloc(0);

  constructor(
    public readonly socket: {
      write: (data: Uint8Array) => boolean;
      end: () => void;
      destroy: () => void;
      on: (event: string, handler: (...args: unknown[]) => void) => void;
      removeAllListeners: (event?: string) => void;
      remotePublicKey?: Buffer;
    },
  ) {
    super();
    this.noisePublicKey = socket.remotePublicKey
      ? new Uint8Array(socket.remotePublicKey)
      : null;

    this.socket.on('data', ((...args: unknown[]) => {
      this.onData(args[0] as Buffer);
    }) as (...args: unknown[]) => void);

    this.socket.on('error', ((...args: unknown[]) => {
      const err = args[0] as Error & { code?: string };
      // ECONNRESET is expected during teardown — treat as close, not error
      if (err.code === 'ECONNRESET') {
        if (this.state !== 'closed') {
          this.state = 'closed';
          this.emit('close');
        }
        return;
      }
      this.emit('error', err);
    }) as (...args: unknown[]) => void);

    this.socket.on('close', () => {
      this.state = 'closed';
      this.emit('close');
    });

    this.socket.on('end', () => {
      this.state = 'closed';
      this.emit('close');
    });
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (this.buffer.length > 0) {
      try {
        const result = parseFrame(new Uint8Array(this.buffer));
        if (!result) {
          // Not enough data yet
          return;
        }

        const { message, bytesConsumed } = result;
        this.buffer = Buffer.from(this.buffer.subarray(bytesConsumed));
        this.emit('message', message);
      } catch (err) {
        // Clear the corrupted buffer so future messages can still be parsed.
        // Without this, the bad data stays in the buffer and every subsequent
        // onData call fails immediately.
        this.buffer = Buffer.alloc(0);
        this.emit('error', err);
        return;
      }
    }
  }

  send(message: ProtocolMessage): void {
    if (this.state === 'closed') {
      throw new Error('Cannot send on closed session');
    }
    const framed = frameMessage(message);
    this.socket.write(framed);
  }

  close(): void {
    if (this.state !== 'closed') {
      this.state = 'closed';
      try {
        this.socket.end();
      } catch {
        // ignore
      }
      this.emit('close');
    }
  }

  setVerified(
    peerPublicKey: Uint8Array,
    peerFingerprint: string,
    peerDisplayName?: string,
    peerXPublicKey?: Uint8Array,
  ): void {
    this.peerPublicKey = peerPublicKey;
    this.peerXPublicKey = peerXPublicKey ?? null;
    this.peerFingerprint = peerFingerprint;
    this.peerDisplayName = peerDisplayName ?? null;
    this.state = 'verified';
  }

  setReady(): void {
    if (this.state === 'verified') {
      this.state = 'ready';
    }
  }
}
