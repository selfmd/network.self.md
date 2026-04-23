/**
 * Hyperswarm bridge for TTYA.
 *
 * Connects the web server to the agent node via the Hyperswarm P2P network.
 * Derives a TTYA-specific topic from the agent's Ed25519 public key,
 * joins it, and forwards messages between WebSocket visitors and the agent.
 */

import Hyperswarm from 'hyperswarm';
import b4a from 'b4a';
import { createHmac } from 'node:crypto';
import type { TTYARequest, TTYAResponse } from './types.js';

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

/**
 * Decode length-prefixed JSON frames from a buffer.
 * Returns parsed TTYAResponse objects and the number of bytes consumed.
 */
function decodeFrames(data: Buffer): { responses: TTYAResponse[]; consumed: number } {
  const responses: TTYAResponse[] = [];
  let offset = 0;

  while (offset + 4 <= data.length) {
    const len = data.readUInt32BE(offset);
    if (offset + 4 + len > data.length) break;
    const payload = data.subarray(offset + 4, offset + 4 + len);
    try {
      const msg = JSON.parse(payload.toString('utf-8')) as TTYAResponse;
      responses.push(msg);
    } catch {
      // skip malformed frames
    }
    offset += 4 + len;
  }

  return { responses, consumed: offset };
}

export class TTYABridge {
  private agentEdPublicKey: Uint8Array;
  private swarm: Hyperswarm | null = null;
  private agentConnection: any = null;
  private responseHandler: ((response: TTYAResponse) => void) | null = null;
  private pendingRequests: TTYARequest[] = [];
  private receiveBuffer = Buffer.alloc(0);

  constructor(agentEdPublicKey: Uint8Array) {
    this.agentEdPublicKey = agentEdPublicKey;
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

      // Flush any requests that queued before the agent connected
      for (const req of this.pendingRequests) {
        this.writeRequest(req);
      }
      this.pendingRequests = [];

      conn.on('data', (chunk: Buffer) => {
        this.receiveBuffer = Buffer.concat([this.receiveBuffer, chunk]);
        this.processReceiveBuffer();
      });

      conn.on('close', () => {
        this.agentConnection = null;
        this.receiveBuffer = Buffer.alloc(0);
      });

      conn.on('error', () => {
        this.agentConnection = null;
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
  }

  /**
   * Send a TTYARequest to the connected agent.
   * If agent is not connected yet, the request is queued.
   */
  sendToAgent(request: TTYARequest): void {
    if (this.agentConnection) {
      this.writeRequest(request);
    } else {
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
    return this.agentConnection !== null;
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
    const { responses, consumed } = decodeFrames(this.receiveBuffer);
    if (responses.length === 0) return;

    this.receiveBuffer = Buffer.from(this.receiveBuffer.subarray(consumed));

    for (const response of responses) {
      if (this.responseHandler) {
        this.responseHandler(response);
      }
    }
  }
}
