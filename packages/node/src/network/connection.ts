import { EventEmitter } from 'node:events';
import {
  frameMessage,
  MAX_FRAME_SIZE,
  MessageType,
  parseFrame,
} from '@networkselfmd/core';
import type { ProtocolMessage } from '@networkselfmd/core';

export type ConnectionState =
  | 'connecting'
  | 'handshaking'
  | 'verified'
  | 'ready'
  | 'closed';

export const MAX_COALESCED_HANDSHAKE_TAIL_BYTES = 64 * 1024;

type SocketHandler = (...args: unknown[]) => void;
const ignorePostCloseSocketError: SocketHandler = () => undefined;

export interface PeerSocket {
  write: (data: Uint8Array) => boolean;
  end: () => void;
  destroy: () => void;
  on: (event: string, handler: SocketHandler) => void;
  removeListener: (event: string, handler: SocketHandler) => void;
  publicKey?: Buffer;
  remotePublicKey?: Buffer;
  handshakeHash?: Buffer;
}

export class PeerSession extends EventEmitter {
  state: ConnectionState = 'connecting';
  peerPublicKey: Uint8Array | null = null;
  peerXPublicKey: Uint8Array | null = null;
  peerFingerprint: string | null = null;
  peerDisplayName: string | null = null;
  peerProtocolVersion = 0;
  peerCapabilities = new Set<string>();
  readonly localNoisePublicKey: Uint8Array | null;
  readonly remoteNoisePublicKey: Uint8Array | null;
  readonly handshakeHash: Uint8Array | null;

  private buffer: Buffer = Buffer.alloc(0);
  private authenticatedTail: ProtocolMessage[] = [];
  private authenticatedTailBytes = 0;

  private readonly handleData: SocketHandler = (...args) => {
    this.onData(Buffer.from(args[0] as Uint8Array));
  };

  private readonly handleError: SocketHandler = (...args) => {
    const error = args[0] as Error & { code?: string };
    if (error.code === 'ECONNRESET') {
      this.transitionClosed('none');
      return;
    }
    this.transitionClosed('destroy', error);
  };

  private readonly handleClose: SocketHandler = () => {
    this.transitionClosed('none');
  };

  private readonly handleEnd: SocketHandler = () => {
    this.transitionClosed('none');
  };

  constructor(public readonly socket: PeerSocket) {
    super();
    this.localNoisePublicKey = socket.publicKey
      ? new Uint8Array(socket.publicKey)
      : null;
    this.remoteNoisePublicKey = socket.remotePublicKey
      ? new Uint8Array(socket.remotePublicKey)
      : null;
    this.handshakeHash = socket.handshakeHash
      ? new Uint8Array(socket.handshakeHash)
      : null;

    this.socket.on('data', this.handleData);
    this.socket.on('error', this.handleError);
    this.socket.on('close', this.handleClose);
    this.socket.on('end', this.handleEnd);
  }

  private onData(chunk: Buffer): void {
    if (this.state === 'closed') return;

    this.buffer = Buffer.concat([this.buffer, chunk]);

    const maximumBufferedBytes =
      this.state === 'verified'
        ? MAX_COALESCED_HANDSHAKE_TAIL_BYTES
        : 4 + MAX_FRAME_SIZE + MAX_COALESCED_HANDSHAKE_TAIL_BYTES;
    if (this.state !== 'ready' && this.buffer.length > maximumBufferedBytes) {
      this.protocolViolation(
        this.state === 'verified'
          ? 'Coalesced post-handshake data limit exceeded'
          : 'Pre-authentication data limit exceeded',
      );
      return;
    }

    while (this.buffer.length > 0) {
      try {
        const result = parseFrame(new Uint8Array(this.buffer));
        if (!result) return;

        const { message, bytesConsumed } = result;
        this.buffer = Buffer.from(this.buffer.subarray(bytesConsumed));

        if (message.type === MessageType.IdentityHandshake) {
          if (this.state !== 'handshaking') {
            this.protocolViolation(
              'Identity handshake already completed for this connection',
            );
            return;
          }

          this.emit('message', message);
          const stateAfterHandshake = this.state as ConnectionState;
          if (stateAfterHandshake === 'closed') return;

          // The handshake listener must validate and freeze the peer identity
          // synchronously before any following application frame is retained.
          if (stateAfterHandshake !== 'verified') {
            this.protocolViolation('Identity handshake was not accepted');
            return;
          }
          if (this.buffer.length > MAX_COALESCED_HANDSHAKE_TAIL_BYTES) {
            this.protocolViolation(
              'Coalesced post-handshake data limit exceeded',
            );
            return;
          }
          continue;
        }

        if (this.state === 'verified') {
          if (
            this.authenticatedTailBytes + bytesConsumed + this.buffer.length >
            MAX_COALESCED_HANDSHAKE_TAIL_BYTES
          ) {
            this.protocolViolation(
              'Coalesced post-handshake data limit exceeded',
            );
            return;
          }
          this.authenticatedTailBytes += bytesConsumed;
          this.authenticatedTail.push(message);
          continue;
        }

        if (this.state !== 'ready') {
          this.protocolViolation(
            'Application frame received before identity authentication',
          );
          return;
        }

        this.emit('message', message);
      } catch (error) {
        this.protocolViolation(
          error instanceof Error ? error : new Error('Invalid protocol frame'),
        );
        return;
      }
    }
  }

  send(message: ProtocolMessage): void {
    if (this.state === 'closed') {
      throw new Error('Cannot send on closed session');
    }
    this.socket.write(frameMessage(message));
  }

  close(): void {
    this.transitionClosed('end');
  }

  destroy(error?: Error): void {
    this.transitionClosed('destroy', error);
  }

  setVerified(
    peerPublicKey: Uint8Array,
    peerFingerprint: string,
    peerDisplayName?: string,
    peerXPublicKey?: Uint8Array,
    peerProtocolVersion = 0,
    peerCapabilities: string[] = [],
  ): void {
    if (
      this.state !== 'handshaking' ||
      this.peerPublicKey !== null ||
      this.peerFingerprint !== null
    ) {
      throw new Error('Session identity is immutable after handshake');
    }

    this.peerPublicKey = peerPublicKey;
    this.peerXPublicKey = peerXPublicKey ?? null;
    this.peerFingerprint = peerFingerprint;
    this.peerDisplayName = peerDisplayName ?? null;
    this.peerProtocolVersion = peerProtocolVersion;
    this.peerCapabilities = new Set(peerCapabilities);
    this.state = 'verified';
  }

  setReady(): void {
    if (this.state !== 'verified') return;

    this.state = 'ready';
    const tail = this.authenticatedTail;
    this.authenticatedTail = [];
    this.authenticatedTailBytes = 0;
    for (const message of tail) {
      if ((this.state as ConnectionState) === 'closed') return;
      this.emit('message', message);
    }
  }

  private protocolViolation(error: string | Error): void {
    this.transitionClosed(
      'destroy',
      typeof error === 'string' ? new Error(error) : error,
    );
  }

  private transitionClosed(
    socketAction: 'none' | 'end' | 'destroy',
    error?: Error,
  ): void {
    if (this.state === 'closed') return;

    this.state = 'closed';
    this.buffer = Buffer.alloc(0);
    this.authenticatedTail = [];
    this.authenticatedTailBytes = 0;
    this.detachSocketListeners();

    try {
      if (socketAction === 'destroy') {
        this.socket.destroy();
      } else if (socketAction === 'end') {
        this.socket.end();
      }
    } catch {
      // The session is already terminal even if socket teardown throws.
    }

    if (error && this.listenerCount('error') > 0) {
      this.emit('error', error);
    }
    this.emit('close');
  }

  private detachSocketListeners(): void {
    this.socket.removeListener('data', this.handleData);
    this.socket.removeListener('error', this.handleError);
    this.socket.removeListener('close', this.handleClose);
    this.socket.removeListener('end', this.handleEnd);
    // A reset can race local teardown. Keep a non-capturing listener so a late
    // socket error cannot become an uncaught EventEmitter "error" event.
    this.socket.on('error', ignorePostCloseSocketError);
  }
}
