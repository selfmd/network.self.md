/**
 * Hyperswarm bridge for TTYA.
 *
 * Connects the web server to the agent node via the Hyperswarm P2P network.
 * Derives a TTYA-specific topic from the agent's Ed25519 public key,
 * joins it, and forwards messages between WebSocket visitors and the agent.
 */

import Hyperswarm from 'hyperswarm';
import { createHmac } from 'node:crypto';
import type { TTYARequest, TTYAResponse } from './types.js';

/** Maximum allowed TTYA frame payload size (64 KB). Prevents OOM from malicious peers. */
const MAX_TTYA_FRAME_SIZE = 65536;

/**
 * HKDF-SHA256 implementation using Node.js crypto.
 * topic = hkdf(sha256, ikm, salt, info, length)
 */
function hkdfSha256(
  ikm: Uint8Array,
  salt: string,
  info: string,
  length: number,
): Uint8Array {
  const saltBuf = salt ? Buffer.from(salt, 'utf-8') : Buffer.alloc(32);
  // Extract
  const prk = createHmac('sha256', saltBuf).update(ikm).digest();
  // Expand
  const infoBuf = Buffer.from(info || '', 'utf-8');
  const n = Math.ceil(length / 32);
  const okm = Buffer.alloc(n * 32);
  let prev = Buffer.alloc(0);
  for (let i = 1; i <= n; i++) {
    prev = createHmac('sha256', prk)
      .update(Buffer.concat([prev, infoBuf, Buffer.from([i])]))
      .digest();
    prev.copy(okm, (i - 1) * 32);
  }
  return new Uint8Array(okm.subarray(0, length));
}

/**
 * Encode a TTYARequest as a length-prefixed JSON frame.
 * Wire format: [4 bytes uint32 BE length][JSON payload]
 *
 * In production this should use CBOR (cbor-x) matching the protocol spec.
 */
function encodeFrame(msg: TTYARequest): Uint8Array {
  const json = JSON.stringify(msg);
  const payload = Buffer.from(json, 'utf-8');
  const frame = Buffer.alloc(4 + payload.length);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  return new Uint8Array(frame);
}

const VALID_RESPONSE_ACTIONS = new Set(['approve', 'reject', 'reply']);

/**
 * Runtime validation for TTYAResponse objects received over the wire.
 * Rejects messages with missing or wrong-type fields to prevent crashes
 * from malicious Hyperswarm peers.
 */
function isValidTTYAResponse(obj: unknown): obj is TTYAResponse {
  if (obj === null || typeof obj !== 'object') return false;
  const o = obj as Record<string, unknown>;
  if (o.type !== 0x08) return false;
  if (typeof o.visitorId !== 'string') return false;
  if (typeof o.action !== 'string' || !VALID_RESPONSE_ACTIONS.has(o.action)) return false;
  if (o.content !== undefined && typeof o.content !== 'string') return false;
  if (o.sessionToken !== undefined && typeof o.sessionToken !== 'string') return false;
  return true;
}

/**
 * Decode length-prefixed JSON frames from a buffer.
 * Returns parsed TTYAResponse objects and the number of bytes consumed.
 */
function decodeFrames(data: Buffer): { responses: TTYAResponse[]; consumed: number } {
  const responses: TTYAResponse[] = [];
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
      if (isValidTTYAResponse(parsed)) {
        responses.push(parsed);
      } else {
        console.warn('[TTYABridge] Skipping invalid response frame: failed validation');
      }
    } catch {
      // skip malformed frames
    }
    offset += 4 + len;
  }

  return { responses, consumed: offset };
}

/** Challenge frame sent by agent to bridge on connection */
interface TTYAChallengeFrame {
  type: 'ttya-challenge';
  challenge: string; // hex-encoded 32 random bytes
}

function isValidChallengeFrame(obj: unknown): obj is TTYAChallengeFrame {
  if (obj === null || typeof obj !== 'object') return false;
  const o = obj as Record<string, unknown>;
  return (
    o.type === 'ttya-challenge' &&
    typeof o.challenge === 'string'
  );
}

const MAX_PENDING_REQUESTS = 1000;

export class TTYABridge {
  private agentEdPublicKey: Uint8Array;
  private authSecret: Uint8Array;
  private swarm: Hyperswarm | null = null;
  private agentConnection: any = null;
  private responseHandler: ((response: TTYAResponse) => void) | null = null;
  private pendingRequests: TTYARequest[] = [];
  private receiveBuffer = Buffer.alloc(0);
  private authenticated = false;

  constructor(agentEdPublicKey: Uint8Array, authSecret: Uint8Array) {
    this.agentEdPublicKey = agentEdPublicKey;
    this.authSecret = authSecret;
  }

  /**
   * Derive the TTYA topic from the agent's Ed25519 public key.
   * topic = hkdf(sha256, agentEdPublicKey, "networkselfmd-ttya-v1", "", 32)
   */
  private deriveTopic(): Buffer {
    const topic = hkdfSha256(this.agentEdPublicKey, 'networkselfmd-ttya-v1', '', 32);
    return Buffer.from(topic);
  }

  /**
   * Join the Hyperswarm topic and wait for the agent node to connect.
   */
  async connect(): Promise<void> {
    const topic = this.deriveTopic();

    this.swarm = new Hyperswarm();

    this.swarm.on('connection', (conn: any, _info: any) => {
      this.agentConnection = conn;
      this.authenticated = false;

      // Don't send requests yet — wait for challenge from agent

      conn.on('data', (chunk: Buffer) => {
        this.receiveBuffer = Buffer.concat([this.receiveBuffer, chunk]);

        if (this.receiveBuffer.length > MAX_TTYA_FRAME_SIZE + 4) {
          console.warn(`[TTYABridge] Receive buffer exceeded max size (${this.receiveBuffer.length} bytes), destroying connection`);
          this.receiveBuffer = Buffer.alloc(0);
          conn.destroy();
          return;
        }

        this.processReceiveBuffer();
      });

      conn.on('close', () => {
        this.agentConnection = null;
        this.authenticated = false;
        this.receiveBuffer = Buffer.alloc(0);
      });

      conn.on('error', () => {
        this.agentConnection = null;
        this.authenticated = false;
        this.receiveBuffer = Buffer.alloc(0);
      });
    });

    // Join the TTYA topic as a client (looking for the agent server)
    this.swarm.join(topic, { client: true, server: false });
    await this.swarm.flush();
  }

  /**
   * Disconnect from Hyperswarm.
   */
  async disconnect(): Promise<void> {
    if (this.agentConnection) {
      try {
        this.agentConnection.destroy();
      } catch {
        // ignore
      }
      this.agentConnection = null;
    }

    if (this.swarm) {
      await this.swarm.destroy();
      this.swarm = null;
    }

    this.receiveBuffer = Buffer.alloc(0);
    this.pendingRequests = [];
    this.authenticated = false;
  }

  /**
   * Send a TTYARequest to the connected agent.
   * If agent is not connected yet, the request is queued.
   */
  sendToAgent(request: TTYARequest): void {
    if (this.agentConnection && this.authenticated) {
      this.writeRequest(request);
    } else {
      if (this.pendingRequests.length >= MAX_PENDING_REQUESTS) {
        console.warn('[Bridge] Pending request queue full, dropping oldest');
        this.pendingRequests.shift();
      }
      this.pendingRequests.push(request);
    }
  }

  /**
   * Register handler for TTYAResponse messages from the agent.
   */
  onAgentResponse(handler: (response: TTYAResponse) => void): void {
    this.responseHandler = handler;
  }

  /** Whether we have an active connection to the agent node */
  get isConnected(): boolean {
    return this.agentConnection !== null && this.authenticated;
  }

  /**
   * Send a challenge-response HMAC back to the agent.
   */
  private sendChallengeResponse(challenge: string): void {
    if (!this.agentConnection) return;

    const challengeBytes = Buffer.from(challenge, 'hex');
    const hmacValue = createHmac('sha256', this.authSecret)
      .update(challengeBytes)
      .digest()
      .toString('hex');

    const responseFrame = {
      type: 'ttya-challenge-response',
      hmac: hmacValue,
    };

    const json = JSON.stringify(responseFrame);
    const jsonBuf = Buffer.from(json, 'utf-8');
    const frame = Buffer.alloc(4 + jsonBuf.length);
    frame.writeUInt32BE(jsonBuf.length, 0);
    jsonBuf.copy(frame, 4);

    try {
      this.agentConnection.write(frame);
    } catch {
      // connection may have dropped
    }
  }

  private writeRequest(request: TTYARequest): void {
    if (!this.agentConnection) return;
    try {
      const frame = encodeFrame(request);
      this.agentConnection.write(Buffer.from(frame));
    } catch {
      // connection may have dropped
    }
  }

  private processReceiveBuffer(): void {
    // If not authenticated, expect the first frame to be a challenge from the agent
    if (!this.authenticated) {
      if (this.receiveBuffer.length < 4) return;
      const len = this.receiveBuffer.readUInt32BE(0);
      if (len > MAX_TTYA_FRAME_SIZE) {
        console.warn('[TTYABridge] Challenge frame too large, destroying connection');
        this.receiveBuffer = Buffer.alloc(0);
        if (this.agentConnection) this.agentConnection.destroy();
        return;
      }
      if (this.receiveBuffer.length < 4 + len) return;

      const payload = this.receiveBuffer.subarray(4, 4 + len);
      this.receiveBuffer = Buffer.from(this.receiveBuffer.subarray(4 + len));

      try {
        const parsed: unknown = JSON.parse(payload.toString('utf-8'));
        if (isValidChallengeFrame(parsed)) {
          // Respond with HMAC
          this.sendChallengeResponse(parsed.challenge);
          this.authenticated = true;

          // Flush any requests that queued before authentication
          for (const req of this.pendingRequests) {
            this.writeRequest(req);
          }
          this.pendingRequests = [];

          // Continue processing any remaining data in the buffer
          if (this.receiveBuffer.length > 0) {
            this.processReceiveBuffer();
          }
          return;
        }
      } catch {
        // malformed frame
      }

      // Challenge parsing failed — destroy connection
      console.warn('[TTYABridge] Failed to parse challenge frame, destroying connection');
      this.receiveBuffer = Buffer.alloc(0);
      if (this.agentConnection) this.agentConnection.destroy();
      return;
    }

    // Authenticated — process TTYAResponse frames normally
    let responses: TTYAResponse[];
    let consumed: number;
    try {
      ({ responses, consumed } = decodeFrames(this.receiveBuffer));
    } catch (err) {
      console.warn('[TTYABridge] Frame decode error, clearing buffer:', err);
      this.receiveBuffer = Buffer.alloc(0);
      if (this.agentConnection) {
        this.agentConnection.destroy();
      }
      return;
    }
    if (responses.length === 0) return;

    this.receiveBuffer = Buffer.from(this.receiveBuffer.subarray(consumed));

    for (const response of responses) {
      if (this.responseHandler) {
        this.responseHandler(response);
      }
    }
  }
}
