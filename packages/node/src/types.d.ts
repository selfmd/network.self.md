declare module 'hyperswarm' {
  import { EventEmitter } from 'node:events';

  interface Discovery {
    flushed(): Promise<void>;
  }

  class Hyperswarm extends EventEmitter {
    constructor(options?: Record<string, unknown>);
    join(
      topic: Buffer,
      options?: { server?: boolean; client?: boolean },
    ): Discovery;
    leave(topic: Buffer): Promise<void>;
    destroy(): Promise<void>;
  }

  export default Hyperswarm;
}

declare module 'hyperdht' {
  class HyperDHT {
    constructor(options?: Record<string, unknown>);
    destroy(): Promise<void>;
  }
  export default HyperDHT;
}

declare module 'b4a' {
  export function from(input: string | Uint8Array, encoding?: string): Buffer;
  export function toString(buf: Buffer, encoding?: string): string;
  export function alloc(size: number, fill?: number): Buffer;
  export function isBuffer(value: unknown): value is Buffer;
}

declare module '@hyperswarm/secret-stream' {
  import { Duplex } from 'node:stream';

  interface NoiseKeyPair {
    publicKey: Buffer;
    secretKey: Buffer;
  }

  interface NoiseSecretStreamOptions {
    keyPair?: NoiseKeyPair;
    pattern?: string;
    remotePublicKey?: Buffer;
  }

  class NoiseSecretStream extends Duplex {
    constructor(
      isInitiator: boolean,
      rawStream?: Duplex,
      options?: NoiseSecretStreamOptions,
    );

    static keyPair(seed?: Buffer): NoiseKeyPair;

    readonly rawStream: Duplex;
    readonly opened: Promise<boolean>;
    readonly publicKey: Buffer;
    readonly remotePublicKey: Buffer;
    readonly handshakeHash: Buffer;
  }

  export default NoiseSecretStream;
}
