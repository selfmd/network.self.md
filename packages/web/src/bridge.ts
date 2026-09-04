/**
 * Hyperswarm bridge for TTYA.
 *
 * Connects the web server to the agent node via the Hyperswarm P2P network.
 * Derives a TTYA-specific topic from the agent's Ed25519 public key,
 * joins it, and forwards messages between WebSocket visitors and the agent.
 */

import Hyperswarm from 'hyperswarm';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  MAX_TTYA_FRAME_SIZE,
  TTYA_AUTH_NONCE_BYTES,
  TTYA_AUTH_VERSION,
  buildTTYAAuthProofPayload,
  isTTYAAuthChallengeFrame,
  isTTYAAuthConfirmationFrame,
  type TTYAAuthConfirmationFrame,
  type TTYAAuthResponseFrame,
} from '@networkselfmd/core';
import type { TTYARequest, TTYAResponse } from './types.js';

/** Time to complete mutual authentication before disconnecting. */
const AUTH_TIMEOUT_MS = 5_000;

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
function encodeFrame(msg: TTYARequest | TTYAAuthResponseFrame): Buffer {
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

const MAX_PENDING_REQUESTS = 1000;

type BridgeAuthState =
  | 'awaiting-challenge'
  | 'awaiting-confirmation'
  | 'authenticated';

export class TTYABridge {
  private agentEdPublicKey: Uint8Array;
  private authSecret: Uint8Array;
  private swarm: Hyperswarm | null = null;
  private agentConnection: any = null;
  private responseHandler: ((response: TTYAResponse) => void) | null = null;
  private pendingRequests: TTYARequest[] = [];
  private receiveBuffer = Buffer.alloc(0);
  private authenticated = false;
  private authState: BridgeAuthState = 'awaiting-challenge';
  private agentNonce: string | null = null;
  private bridgeNonce: string | null = null;
  private authTimeout: ReturnType<typeof setTimeout> | null = null;

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
      if (this.agentConnection && this.authenticated) {
        conn.destroy();
        return;
      }

      if (this.agentConnection) {
        const previousConnection = this.agentConnection;
        this.agentConnection = null;
        try {
          previousConnection.destroy();
        } catch {
          // ignore a stale unauthenticated connection
        }
      }

      this.agentConnection = conn;
      this.resetAuthentication();
      this.receiveBuffer = Buffer.alloc(0);

      this.authTimeout = setTimeout(() => {
        if (this.agentConnection === conn && !this.authenticated) {
          console.warn('[TTYABridge] Authentication timed out; closing peer');
          this.destroyConnection(conn);
        }
      }, AUTH_TIMEOUT_MS);

      conn.on('data', (chunk: Buffer) => {
        if (this.agentConnection !== conn) return;
        this.receiveBuffer = Buffer.concat([this.receiveBuffer, chunk]);
        this.processReceiveBuffer(conn);

        if (this.receiveBuffer.length > MAX_TTYA_FRAME_SIZE + 4) {
          console.warn('[TTYABridge] Incomplete frame exceeded maximum size; closing peer');
          this.destroyConnection(conn);
        }
      });

      conn.on('close', () => {
        this.handleConnectionClosed(conn);
      });

      conn.on('error', () => {
        this.handleConnectionClosed(conn);
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
    this.resetAuthentication();
  }

  /**
   * Send a TTYARequest to the connected agent.
   * If agent is not connected yet, the request is queued.
   */
  sendToAgent(request: TTYARequest): void {
    if (this.agentConnection && this.authenticated) {
      if (this.writeRequest(request)) return;
    }

    if (this.pendingRequests.length >= MAX_PENDING_REQUESTS) {
      console.warn('[TTYABridge] Pending request queue full; dropping oldest');
      this.pendingRequests.shift();
    }
    this.pendingRequests.push(request);
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

  private sendAuthResponse(conn: any, response: TTYAAuthResponseFrame): boolean {
    if (this.agentConnection !== conn) return false;
    try {
      conn.write(encodeFrame(response));
      return true;
    } catch {
      this.destroyConnection(conn);
      return false;
    }
  }

  private writeRequest(request: TTYARequest, conn = this.agentConnection): boolean {
    if (!conn || this.agentConnection !== conn || !this.authenticated) return false;
    try {
      const frame = encodeFrame(request);
      conn.write(frame);
      return true;
    } catch {
      this.destroyConnection(conn);
      return false;
    }
  }

  private processReceiveBuffer(conn: any): void {
    if (this.agentConnection !== conn) return;

    if (this.authState !== 'authenticated') {
      if (this.receiveBuffer.length < 4) return;
      const len = this.receiveBuffer.readUInt32BE(0);
      if (len > MAX_TTYA_FRAME_SIZE) {
        console.warn('[TTYABridge] Authentication frame exceeded maximum size; closing peer');
        this.destroyConnection(conn);
        return;
      }
      if (this.receiveBuffer.length < 4 + len) return;

      const payload = this.receiveBuffer.subarray(4, 4 + len);
      this.receiveBuffer = Buffer.from(this.receiveBuffer.subarray(4 + len));

      try {
        const parsed: unknown = JSON.parse(payload.toString('utf-8'));
        if (
          this.authState === 'awaiting-challenge' &&
          isTTYAAuthChallengeFrame(parsed)
        ) {
          this.agentNonce = parsed.agentNonce;
          this.bridgeNonce = randomBytes(TTYA_AUTH_NONCE_BYTES).toString('hex');
          const proof = createHmac('sha256', this.authSecret)
            .update(
              buildTTYAAuthProofPayload(
                'bridge',
                this.agentNonce,
                this.bridgeNonce,
              ),
            )
            .digest('hex');
          const response: TTYAAuthResponseFrame = {
            type: 'ttya-auth-response',
            version: TTYA_AUTH_VERSION,
            agentNonce: this.agentNonce,
            bridgeNonce: this.bridgeNonce,
            proof,
          };

          if (!this.sendAuthResponse(conn, response)) return;
          this.authState = 'awaiting-confirmation';
          this.processReceiveBuffer(conn);
          return;
        }

        if (
          this.authState === 'awaiting-confirmation' &&
          isTTYAAuthConfirmationFrame(parsed) &&
          this.verifyAgentConfirmation(parsed)
        ) {
          this.authenticated = true;
          this.authState = 'authenticated';
          this.agentNonce = null;
          this.bridgeNonce = null;
          this.clearAuthTimeout();
          this.flushPendingRequests(conn);
          this.processReceiveBuffer(conn);
          return;
        }
      } catch {
        // malformed frame
      }

      console.warn('[TTYABridge] Mutual authentication failed; closing peer');
      this.destroyConnection(conn);
      return;
    }

    // Authenticated — process TTYAResponse frames normally
    let responses: TTYAResponse[];
    let consumed: number;
    try {
      ({ responses, consumed } = decodeFrames(this.receiveBuffer));
    } catch {
      console.warn('[TTYABridge] Invalid response frame; closing peer');
      this.destroyConnection(conn);
      return;
    }

    this.receiveBuffer = Buffer.from(this.receiveBuffer.subarray(consumed));

    for (const response of responses) {
      if (this.responseHandler) {
        this.responseHandler(response);
      }
    }
  }

  private verifyAgentConfirmation(
    frame: TTYAAuthConfirmationFrame,
  ): boolean {
    if (
      this.agentNonce === null ||
      this.bridgeNonce === null ||
      frame.agentNonce !== this.agentNonce ||
      frame.bridgeNonce !== this.bridgeNonce
    ) {
      return false;
    }

    const expectedProof = createHmac('sha256', this.authSecret)
      .update(
        buildTTYAAuthProofPayload(
          'agent',
          this.agentNonce,
          this.bridgeNonce,
        ),
      )
      .digest();
    const receivedProof = Buffer.from(frame.proof, 'hex');
    return (
      receivedProof.length === expectedProof.length &&
      timingSafeEqual(expectedProof, receivedProof)
    );
  }

  private flushPendingRequests(conn: any): void {
    const queued = this.pendingRequests;
    this.pendingRequests = [];

    for (let index = 0; index < queued.length; index += 1) {
      if (!this.writeRequest(queued[index], conn)) {
        this.pendingRequests.unshift(...queued.slice(index));
        return;
      }
    }
  }

  private clearAuthTimeout(): void {
    if (this.authTimeout) {
      clearTimeout(this.authTimeout);
      this.authTimeout = null;
    }
  }

  private resetAuthentication(): void {
    this.clearAuthTimeout();
    this.authenticated = false;
    this.authState = 'awaiting-challenge';
    this.agentNonce = null;
    this.bridgeNonce = null;
  }

  private handleConnectionClosed(conn: any): void {
    if (this.agentConnection !== conn) return;
    this.agentConnection = null;
    this.receiveBuffer = Buffer.alloc(0);
    this.resetAuthentication();
  }

  private destroyConnection(conn: any): void {
    this.handleConnectionClosed(conn);
    try {
      conn.destroy();
    } catch {
      // ignore
    }
  }
}
