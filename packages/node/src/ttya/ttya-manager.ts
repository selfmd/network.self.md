import { EventEmitter } from 'node:events';
import Hyperswarm from 'hyperswarm';
import { deriveKey } from '@networkselfmd/core';

/** TTYA request sent from web bridge to agent node via Hyperswarm */
export interface TTYARequest {
  type: 0x07;
  visitorId: string;
  action: 'message' | 'connect' | 'disconnect';
  content?: string;
  metadata: {
    ipHash: string;
    userAgent?: string;
    timestamp: number;
  };
}

/** TTYA response sent from agent node to web bridge via Hyperswarm */
export interface TTYAResponse {
  type: 0x08;
  visitorId: string;
  action: 'approve' | 'reject' | 'reply';
  content?: string;
  sessionToken?: string;
}

export interface TTYAVisitor {
  visitorId: string;
  firstMessage: string;
  ipHash: string;
  timestamp: number;
  status: 'pending' | 'approved' | 'rejected';
}

const VALID_REQUEST_ACTIONS = new Set(['message', 'connect', 'disconnect']);

/**
 * Runtime validation for TTYARequest objects received over the wire.
 * Rejects messages with missing or wrong-type fields to prevent crashes
 * from malicious Hyperswarm peers.
 */
function isValidTTYARequest(obj: unknown): obj is TTYARequest {
  if (obj === null || typeof obj !== 'object') return false;
  const o = obj as Record<string, unknown>;
  if (o.type !== 0x07) return false;
  if (typeof o.visitorId !== 'string') return false;
  if (typeof o.action !== 'string' || !VALID_REQUEST_ACTIONS.has(o.action)) return false;
  if (o.content !== undefined && typeof o.content !== 'string') return false;
  if (o.metadata === null || typeof o.metadata !== 'object') return false;
  const meta = o.metadata as Record<string, unknown>;
  if (typeof meta.ipHash !== 'string') return false;
  if (typeof meta.timestamp !== 'number') return false;
  if (meta.userAgent !== undefined && typeof meta.userAgent !== 'string') return false;
  return true;
}

function encodeFrame(msg: TTYAResponse): Buffer {
  const json = JSON.stringify(msg);
  const payload = Buffer.from(json, 'utf-8');
  const frame = Buffer.alloc(4 + payload.length);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

function decodeFrames(data: Buffer): { requests: TTYARequest[]; consumed: number } {
  const requests: TTYARequest[] = [];
  let offset = 0;

  while (offset + 4 <= data.length) {
    const len = data.readUInt32BE(offset);
    if (offset + 4 + len > data.length) break;
    const payload = data.subarray(offset + 4, offset + 4 + len);
    try {
      const parsed: unknown = JSON.parse(payload.toString('utf-8'));
      if (isValidTTYARequest(parsed)) {
        requests.push(parsed);
      } else {
        console.warn('[TTYAManager] Skipping invalid request frame: failed validation');
      }
    } catch {
      // skip malformed frames
    }
    offset += 4 + len;
  }

  return { requests, consumed: offset };
}

export class TTYAManager extends EventEmitter {
  private edPublicKey: Uint8Array;
  private swarm: Hyperswarm | null = null;
  private bridgeConnection: any = null;
  private receiveBuffer = Buffer.alloc(0);
  private visitors = new Map<string, TTYAVisitor>();
  isRunning = false;

  constructor(edPublicKey: Uint8Array) {
    super();
    this.edPublicKey = edPublicKey;
  }

  async start(): Promise<void> {
    if (this.isRunning) return;

    this.swarm = new Hyperswarm();

    this.swarm.on('connection', (conn: any, _info: any) => {
      this.bridgeConnection = conn;
      this.receiveBuffer = Buffer.alloc(0);

      conn.on('data', (chunk: Buffer) => {
        this.receiveBuffer = Buffer.concat([this.receiveBuffer, chunk]);
        this.processBuffer();
      });

      conn.on('close', () => {
        this.bridgeConnection = null;
        this.receiveBuffer = Buffer.alloc(0);
      });

      conn.on('error', () => {
        this.bridgeConnection = null;
        this.receiveBuffer = Buffer.alloc(0);
      });
    });

    const topic = deriveKey(this.edPublicKey, 'networkselfmd-ttya-v1', '', 32);
    const discovery = this.swarm.join(Buffer.from(topic), { server: true, client: true });
    await discovery.flushed();
    this.isRunning = true;
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return;
    this.isRunning = false;

    if (this.bridgeConnection) {
      try {
        this.bridgeConnection.destroy();
      } catch {
        /* ignore */
      }
      this.bridgeConnection = null;
    }

    if (this.swarm) {
      await this.swarm.destroy();
      this.swarm = null;
    }

    this.visitors.clear();
    this.receiveBuffer = Buffer.alloc(0);
  }

  getPending(): TTYAVisitor[] {
    return Array.from(this.visitors.values()).filter((v) => v.status === 'pending');
  }

  approve(visitorId: string): void {
    const visitor = this.visitors.get(visitorId);
    if (!visitor) throw new Error('Unknown visitor: ' + visitorId);
    visitor.status = 'approved';
    this.sendResponse({ type: 0x08, visitorId, action: 'approve' });
  }

  reject(visitorId: string): void {
    const visitor = this.visitors.get(visitorId);
    if (!visitor) throw new Error('Unknown visitor: ' + visitorId);
    visitor.status = 'rejected';
    this.visitors.delete(visitorId);
    this.sendResponse({ type: 0x08, visitorId, action: 'reject' });
  }

  reply(visitorId: string, content: string): void {
    const visitor = this.visitors.get(visitorId);
    if (!visitor) throw new Error('Unknown visitor: ' + visitorId);
    this.sendResponse({ type: 0x08, visitorId, action: 'reply', content });
  }

  private sendResponse(response: TTYAResponse): void {
    if (!this.bridgeConnection) return;
    try {
      this.bridgeConnection.write(encodeFrame(response));
    } catch {
      // connection may have dropped
    }
  }

  private processBuffer(): void {
    const { requests, consumed } = decodeFrames(this.receiveBuffer);
    if (requests.length === 0) return;

    this.receiveBuffer = Buffer.from(this.receiveBuffer.subarray(consumed));

    for (const req of requests) {
      this.handleRequest(req);
    }
  }

  private handleRequest(req: TTYARequest): void {
    if (req.action === 'disconnect') {
      this.visitors.delete(req.visitorId);
      this.emit('visitor:disconnect', req.visitorId);
      return;
    }

    if (!this.visitors.has(req.visitorId)) {
      this.visitors.set(req.visitorId, {
        visitorId: req.visitorId,
        firstMessage: req.content ?? '',
        ipHash: req.metadata.ipHash,
        timestamp: req.metadata.timestamp,
        status: 'pending',
      });
    }

    this.emit('visitor:request', {
      visitorId: req.visitorId,
      content: req.content,
      ipHash: req.metadata.ipHash,
      timestamp: req.metadata.timestamp,
    });
  }
}
