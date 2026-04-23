declare module 'hyperswarm' {
  import { EventEmitter } from 'events';

  interface HyperswarmOptions {
    keyPair?: { publicKey: Buffer; secretKey: Buffer };
    seed?: Buffer;
    maxPeers?: number;
  }

  interface JoinOptions {
    client?: boolean;
    server?: boolean;
  }

  class Hyperswarm extends EventEmitter {
    constructor(opts?: HyperswarmOptions);
    join(topic: Buffer, opts?: JoinOptions): any;
    leave(topic: Buffer): Promise<void>;
    flush(): Promise<void>;
    destroy(): Promise<void>;
    on(event: 'connection', listener: (conn: any, info: any) => void): this;
    on(event: string, listener: (...args: any[]) => void): this;
  }

  export = Hyperswarm;
}

declare module 'b4a' {
  const b4a: {
    from(input: string | Buffer | Uint8Array, encoding?: string): Buffer;
    toString(buf: Buffer | Uint8Array, encoding?: string): string;
    alloc(size: number, fill?: number): Buffer;
    isBuffer(value: any): boolean;
    concat(buffers: (Buffer | Uint8Array)[]): Buffer;
    equals(a: Buffer | Uint8Array, b: Buffer | Uint8Array): boolean;
  };
  export = b4a;
}
