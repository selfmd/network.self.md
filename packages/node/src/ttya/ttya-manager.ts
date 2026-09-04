import { EventEmitter } from 'node:events';
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import Hyperswarm from 'hyperswarm';
import {
  MAX_TTYA_FRAME_SIZE,
  TTYA_AUTH_NONCE_BYTES,
  TTYA_AUTH_VERSION,
  buildTTYAAuthProofPayload,
  deriveKey,
  isTTYAAuthResponseFrame,
  type TTYAAuthChallengeFrame,
  type TTYAAuthConfirmationFrame,
  type TTYAAuthResponseFrame,
} from '@networkselfmd/core';

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
  lastActivity: number;
}

/** Time to wait for challenge-response before disconnecting (5 seconds) */
const AUTH_TIMEOUT_MS = 5_000;

/** Interval for visitor cleanup (5 minutes) */
const VISITOR_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

/** Visitors with no activity for this long are removed (30 minutes) */
const VISITOR_STALE_TIMEOUT_MS = 30 * 60 * 1000;

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

function encodeFrame(
  msg: TTYAResponse | TTYAAuthChallengeFrame | TTYAAuthConfirmationFrame,
): Buffer {
  const json = JSON.stringify(msg);
  const payload = Buffer.from(json, 'utf-8');
  if (payload.length > MAX_TTYA_FRAME_SIZE) {
    throw new Error('TTYA frame exceeds maximum size');
  }
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
  private authSecret: Uint8Array;
  private swarm: Hyperswarm | null = null;
  private bridgeConnection: any = null;
  private receiveBuffer = Buffer.alloc(0);
  private visitors = new Map<string, TTYAVisitor>();
  private authenticated = false;
  private pendingAgentNonce: string | null = null;
  private authTimeout: ReturnType<typeof setTimeout> | null = null;
  private visitorCleanupTimer: ReturnType<typeof setInterval> | null = null;
  isRunning = false;

  constructor(edPublicKey: Uint8Array, authSecret: Uint8Array) {
    super();
    this.edPublicKey = edPublicKey;
    this.authSecret = authSecret;
  }

  async start(): Promise<void> {
    if (this.isRunning) return;

    this.swarm = new Hyperswarm();

    this.swarm.on('connection', (conn: any, _info: any) => {
      if (this.bridgeConnection && this.authenticated) {
        conn.destroy();
        return;
      }

      if (this.bridgeConnection) {
        const previousConnection = this.bridgeConnection;
        this.bridgeConnection = null;
        this.clearAuthTimeout();
        try {
          previousConnection.destroy();
        } catch {
          // ignore a stale unauthenticated connection
        }
      }

      this.bridgeConnection = conn;
      this.receiveBuffer = Buffer.alloc(0);
      this.authenticated = false;
      this.pendingAgentNonce = null;

      conn.on('data', (chunk: Buffer) => {
        if (this.bridgeConnection !== conn) return;
        this.receiveBuffer = Buffer.concat([this.receiveBuffer, chunk]);
        this.processBuffer(conn);

        if (this.receiveBuffer.length > MAX_TTYA_FRAME_SIZE + 4) {
          console.warn('[TTYAManager] Incomplete frame exceeded maximum size; closing peer');
          this.destroyConnection(conn);
        }
      });

      conn.on('close', () => {
        this.handleConnectionClosed(conn);
      });

      conn.on('error', () => {
        this.handleConnectionClosed(conn);
      });

      // Register all connection handlers before starting the handshake.
      const agentNonce = randomBytes(TTYA_AUTH_NONCE_BYTES).toString('hex');
      this.pendingAgentNonce = agentNonce;
      const challengeFrame: TTYAAuthChallengeFrame = {
        type: 'ttya-auth-challenge',
        version: TTYA_AUTH_VERSION,
        agentNonce,
      };

      this.authTimeout = setTimeout(() => {
        if (!this.authenticated && this.bridgeConnection === conn) {
          console.warn('[TTYAManager] Authentication timed out; closing peer');
          this.destroyConnection(conn);
        }
      }, AUTH_TIMEOUT_MS);

      try {
        conn.write(encodeFrame(challengeFrame));
      } catch {
        this.destroyConnection(conn);
        return;
      }
    });

    const topic = deriveKey(this.edPublicKey, 'networkselfmd-ttya-v1', '', 32);
    const discovery = this.swarm.join(Buffer.from(topic), { server: true, client: true });
    await discovery.flushed();
    this.isRunning = true;

    // Periodically remove stale visitors to prevent memory leaks
    this.visitorCleanupTimer = setInterval(() => {
      this.cleanupStaleVisitors();
    }, VISITOR_CLEANUP_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return;
    this.isRunning = false;

    if (this.visitorCleanupTimer) {
      clearInterval(this.visitorCleanupTimer);
      this.visitorCleanupTimer = null;
    }

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
    this.pendingAgentNonce = null;
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
    if (!this.bridgeConnection || !this.authenticated) return;
    try {
      this.bridgeConnection.write(encodeFrame(response));
    } catch {
      this.destroyConnection(this.bridgeConnection);
    }
  }

  private clearAuthTimeout(): void {
    if (this.authTimeout) {
      clearTimeout(this.authTimeout);
      this.authTimeout = null;
    }
  }

  private processBuffer(conn?: any): void {
    const activeConnection = conn || this.bridgeConnection;
    if (!activeConnection || this.bridgeConnection !== activeConnection) return;

    // If not authenticated, expect the first frame to be a challenge-response
    if (!this.authenticated) {
      // Need at least 4 bytes for the length prefix
      if (this.receiveBuffer.length < 4) return;
      const len = this.receiveBuffer.readUInt32BE(0);
      if (len > MAX_TTYA_FRAME_SIZE) {
        console.warn('[TTYAManager] Authentication frame exceeded maximum size; closing peer');
        this.destroyConnection(activeConnection);
        return;
      }
      if (this.receiveBuffer.length < 4 + len) return;

      const payload = this.receiveBuffer.subarray(4, 4 + len);
      this.receiveBuffer = Buffer.from(this.receiveBuffer.subarray(4 + len));

      try {
        const parsed: unknown = JSON.parse(payload.toString('utf-8'));
        if (isTTYAAuthResponseFrame(parsed)) {
          if (this.verifyBridgeResponse(parsed)) {
            const confirmation = this.createAuthConfirmation(parsed);
            try {
              activeConnection.write(encodeFrame(confirmation));
            } catch {
              this.destroyConnection(activeConnection);
              return;
            }
            this.authenticated = true;
            this.pendingAgentNonce = null;
            this.clearAuthTimeout();
            // Continue processing any remaining data in the buffer
            if (this.receiveBuffer.length > 0) {
              this.processBuffer(activeConnection);
            }
            return;
          }
        }
      } catch {
        // malformed frame
      }

      // Auth failed — destroy connection
      console.warn('[TTYAManager] Mutual authentication failed; closing peer');
      this.destroyConnection(activeConnection);
      return;
    }

    // Authenticated — process TTYA requests normally
    let requests: TTYARequest[];
    let consumed: number;
    try {
      ({ requests, consumed } = decodeFrames(this.receiveBuffer));
    } catch {
      console.warn('[TTYAManager] Invalid request frame; closing peer');
      this.destroyConnection(activeConnection);
      return;
    }

    this.receiveBuffer = Buffer.from(this.receiveBuffer.subarray(consumed));

    for (const req of requests) {
      this.handleRequest(req);
    }
  }

  private cleanupStaleVisitors(): void {
    const now = Date.now();
    for (const [id, visitor] of this.visitors) {
      if (now - visitor.lastActivity > VISITOR_STALE_TIMEOUT_MS) {
        this.visitors.delete(id);
      }
    }
  }

  private verifyBridgeResponse(frame: TTYAAuthResponseFrame): boolean {
    if (
      !this.pendingAgentNonce ||
      frame.agentNonce !== this.pendingAgentNonce
    ) {
      console.warn('[TTYAManager] No pending challenge for verification');
      return false;
    }

    try {
      const expectedHmac = createHmac('sha256', this.authSecret)
        .update(
          buildTTYAAuthProofPayload(
            'bridge',
            frame.agentNonce,
            frame.bridgeNonce,
          ),
        )
        .digest();
      const receivedHmac = Buffer.from(frame.proof, 'hex');

      if (receivedHmac.length !== expectedHmac.length) {
        return false;
      }

      return timingSafeEqual(expectedHmac, receivedHmac);
    } catch {
      return false;
    }
  }

  private createAuthConfirmation(
    response: TTYAAuthResponseFrame,
  ): TTYAAuthConfirmationFrame {
    const proof = createHmac('sha256', this.authSecret)
      .update(
        buildTTYAAuthProofPayload(
          'agent',
          response.agentNonce,
          response.bridgeNonce,
        ),
      )
      .digest('hex');
    return {
      type: 'ttya-auth-confirmation',
      version: TTYA_AUTH_VERSION,
      agentNonce: response.agentNonce,
      bridgeNonce: response.bridgeNonce,
      proof,
    };
  }

  private handleConnectionClosed(conn: any): void {
    if (this.bridgeConnection !== conn) return;
    this.clearAuthTimeout();
    this.bridgeConnection = null;
    this.authenticated = false;
    this.pendingAgentNonce = null;
    this.receiveBuffer = Buffer.alloc(0);
  }

  private destroyConnection(conn: any): void {
    this.handleConnectionClosed(conn);
    try {
      conn.destroy();
    } catch {
      // ignore
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
        lastActivity: Date.now(),
      });
    } else {
      const visitor = this.visitors.get(req.visitorId)!;
      visitor.lastActivity = Date.now();
    }

    this.emit('visitor:request', {
      visitorId: req.visitorId,
      content: req.content,
      ipHash: req.metadata.ipHash,
      timestamp: req.metadata.timestamp,
    });
  }
}
