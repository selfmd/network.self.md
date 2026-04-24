import type { PrivateInboundMessageEvent } from '@networkselfmd/core';

export interface InboundEventQueueOptions {
  max?: number;
}

export type InboundEventHandler = (ev: PrivateInboundMessageEvent) => void;

// Bounded FIFO buffer for PrivateInboundMessageEvents so poll-based
// consumers (MCP, CLI) don't drop events between polls. Owner-local only —
// never queues PublicActivityEvent.
export class InboundEventQueue {
  private buf: PrivateInboundMessageEvent[] = [];
  private handlers: Set<InboundEventHandler> = new Set();
  private max: number;

  constructor(options: InboundEventQueueOptions = {}) {
    this.max = options.max ?? 1000;
  }

  push(ev: PrivateInboundMessageEvent): void {
    this.buf.push(ev);
    if (this.buf.length > this.max) {
      this.buf.splice(0, this.buf.length - this.max);
    }
    for (const h of this.handlers) {
      try {
        h(ev);
      } catch (err) {
        // Handler errors must not stop delivery to other handlers, but must
        // not be silently swallowed either. Rethrow on a microtask so the
        // process 'uncaughtException' / test runner sees it.
        queueMicrotask(() => {
          throw err;
        });
      }
    }
  }

  drain(limit?: number): PrivateInboundMessageEvent[] {
    if (limit === undefined || limit >= this.buf.length) {
      const out = this.buf.slice();
      this.buf = [];
      return out;
    }
    return this.buf.splice(0, limit);
  }

  peek(limit?: number): PrivateInboundMessageEvent[] {
    if (limit === undefined) return this.buf.slice();
    return this.buf.slice(0, limit);
  }

  size(): number {
    return this.buf.length;
  }

  on(handler: InboundEventHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }
}
