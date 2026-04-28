import { EventEmitter } from 'node:events';
import Hyperswarm from 'hyperswarm';
import { deriveKey, verify } from '@networkselfmd/core';

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

/** Maximum clock skew allowed for auth frame timestamps (5 minutes) */
const AUTH_TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000;

/** Time to wait for auth frame before disconnecting (5 seconds) */
const AUTH_TIMEOUT_MS = 5_000;

/** Auth frame sent by bridge as first message */
interface TTYAAuthFrame {
  type: 'ttya-auth';
  bridgePublicKey: string;
  timestamp: number;
  signature: string;
}

function isValidAuthFrame(obj: unknown): obj is TTYAAuthFrame {
  if (obj === null || typeof obj !== 'object') return false;
  const o = obj as Record<string, unknown>;
  return (
    o.type === 'ttya-auth' &&
    typeof o.bridgePublicKey === 'string' &&
    typeof o.timestamp === 'number' &&
    typeof o.signature === 'string'
  );
}

/** Maximum allowed TTYA frame payload size (64 KB). Prevents OOM from malicious peers. */
const MAX_TTYA_FRAME_SIZE = 65536;

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
    if (len > MAX_TTYA_FRAME_SIZE) {
      throw new Error(`TTYA frame too large: ${len} bytes (max ${MAX_TTYA_FRAME_SIZE})`);
    }
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
  private authenticated = false;
  private bridgePublicKey: Uint8Array | null = null;
  private authTimeout: ReturnType<typeof setTimeout> | null = null;
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
      this.authenticated = false;
      this.bridgePublicKey = null;

      // Require auth frame within AUTH_TIMEOUT_MS
      this.authTimeout = setTimeout(() => {
        if (!this.authenticated && this.bridgeConnection === conn) {
          console.warn('[TTYAManager] Auth timeout — destroying connection');
          conn.destroy();
        }
      }, AUTH_TIMEOUT_MS);

      conn.on('data', (chunk: Buffer) => {
        this.receiveBuffer = Buffer.concat([this.receiveBuffer, chunk]);

        if (this.receiveBuffer.length > MAX_TTYA_FRAME_SIZE + 4) {
          console.warn(`[TTYAManager] Receive buffer exceeded max size (${this.receiveBuffer.length} bytes), destroying connection`);
          this.receiveBuffer = Buffer.alloc(0);
          conn.destroy();
          return;
        }

        this.processBuffer(conn);
      });

      conn.on('close', () => {
        this.clearAuthTimeout();
        this.bridgeConnection = null;
        this.authenticated = false;
        this.bridgePublicKey = null;
        this.receiveBuffer = Buffer.alloc(0);
      });

      conn.on('error', () => {
        this.clearAuthTimeout();
        this.bridgeConnection = null;
        this.authenticated = false;
        this.bridgePublicKey = null;
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

    this.clearAuthTimeout();

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
    this.authenticated = false;
    this.bridgePublicKey = null;
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

  private clearAuthTimeout(): void {
    if (this.authTimeout) {
      clearTimeout(this.authTimeout);
      this.authTimeout = null;
    }
  }

  private processBuffer(conn?: any): void {
    // If not authenticated, expect the first frame to be an auth frame
    if (!this.authenticated) {
      // Need at least 4 bytes for the length prefix
      if (this.receiveBuffer.length < 4) return;
      const len = this.receiveBuffer.readUInt32BE(0);
      if (this.receiveBuffer.length < 4 + len) return;

      const payload = this.receiveBuffer.subarray(4, 4 + len);
      this.receiveBuffer = Buffer.from(this.receiveBuffer.subarray(4 + len));

      try {
        const parsed: unknown = JSON.parse(payload.toString('utf-8'));
        if (isValidAuthFrame(parsed)) {
          if (this.verifyAuthFrame(parsed)) {
            this.authenticated = true;
            this.bridgePublicKey = Buffer.from(parsed.bridgePublicKey, 'hex');
            this.clearAuthTimeout();
            // Continue processing any remaining data in the buffer
            if (this.receiveBuffer.length > 0) {
              this.processBuffer(conn);
            }
            return;
          }
        }
      } catch {
        // malformed frame
      }

      // Auth failed — destroy connection
      console.warn('[TTYAManager] Auth failed — destroying connection');
      const target = conn || this.bridgeConnection;
      if (target) {
        try { target.destroy(); } catch { /* ignore */ }
      }
      return;
    }

    // Authenticated — process TTYA requests normally
    let requests: TTYARequest[];
    let consumed: number;
    try {
      ({ requests, consumed } = decodeFrames(this.receiveBuffer));
    } catch (err) {
      console.warn('[TTYAManager] Frame decode error, clearing buffer:', err);
      this.receiveBuffer = Buffer.alloc(0);
      const target = conn || this.bridgeConnection;
      if (target) { try { target.destroy(); } catch { /* ignore */ } }
      return;
    }
    if (requests.length === 0) return;

    this.receiveBuffer = Buffer.from(this.receiveBuffer.subarray(consumed));

    for (const req of requests) {
      this.handleRequest(req);
    }
  }

  private verifyAuthFrame(frame: TTYAAuthFrame): boolean {
    // Check timestamp within tolerance
    const now = Date.now();
    const diff = Math.abs(now - frame.timestamp);
    if (diff > AUTH_TIMESTAMP_TOLERANCE_MS) {
      console.warn('[TTYAManager] Auth frame timestamp out of range:', diff, 'ms');
      return false;
    }

    // Verify signature: sign(agentPublicKey || uint64BE(timestamp))
    try {
      const timestampBuf = Buffer.alloc(8);
      timestampBuf.writeBigUInt64BE(BigInt(frame.timestamp), 0);
      const message = Buffer.concat([Buffer.from(this.edPublicKey), timestampBuf]);
      const signature = Buffer.from(frame.signature, 'hex');
      const bridgePubKey = Buffer.from(frame.bridgePublicKey, 'hex');

      return verify(signature, message, bridgePubKey);
    } catch {
      return false;
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
