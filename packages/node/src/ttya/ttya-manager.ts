import { EventEmitter } from 'node:events';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import Hyperswarm from 'hyperswarm';
import {
  MAX_TTYA_FRAME_SIZE,
  TTYA_AUTH_NONCE_BYTES,
  TTYA_AUTH_VERSION,
  TTYAFrameDecoder,
  buildTTYAAuthProofPayload,
  buildTTYADataProofPayload,
  buildTTYASessionKeyPayload,
  copyAndValidateTTYAAuthSecret,
  copyAndValidateTTYAChannelBinding,
  deriveKey,
  isTTYAAuthResponseFrame,
  isTTYADataFrame,
  type TTYAAuthChallengeFrame,
  type TTYAAuthConfirmationFrame,
  type TTYAAuthResponseFrame,
  type TTYADataFrame,
} from '@networkselfmd/core';

/** TTYA request sent from web bridge to agent node via Hyperswarm. */
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

/** TTYA response sent from agent node to web bridge via Hyperswarm. */
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

interface TTYASocket {
  handshakeHash?: Uint8Array | null;
  remotePublicKey?: Uint8Array | null;
  write(data: Uint8Array): boolean;
  destroy(): void;
  on(event: string, listener: (...args: any[]) => void): unknown;
}

interface AuthFailureState {
  failures: number;
  lastFailure: number;
  blockedUntil: number;
}

const AUTH_TIMEOUT_MS = 5_000;
const AUTH_RATE_WINDOW_MS = 60_000;
const AUTH_FAILURES_PER_PEER = 5;
const AUTH_FAILURES_GLOBAL = 20;
const AUTH_BACKOFF_BASE_MS = 250;
const AUTH_BACKOFF_MAX_MS = 30_000;
const VISITOR_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const VISITOR_STALE_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_VISITOR_ID_BYTES = 128;
const MAX_CONTENT_BYTES = 4_096;
const MAX_IP_HASH_BYTES = 128;
const MAX_USER_AGENT_BYTES = 1_024;
const VALID_REQUEST_ACTIONS = new Set(['message', 'connect', 'disconnect']);

function hasMaxBytes(value: string, maximum: number): boolean {
  return Buffer.byteLength(value, 'utf8') <= maximum;
}

function isValidTTYARequest(obj: unknown): obj is TTYARequest {
  if (obj === null || typeof obj !== 'object') return false;
  const value = obj as Record<string, unknown>;
  if (value.type !== 0x07) return false;
  if (
    typeof value.visitorId !== 'string' ||
    value.visitorId.length === 0 ||
    !hasMaxBytes(value.visitorId, MAX_VISITOR_ID_BYTES)
  ) {
    return false;
  }
  if (
    typeof value.action !== 'string' ||
    !VALID_REQUEST_ACTIONS.has(value.action)
  ) {
    return false;
  }
  if (
    value.content !== undefined &&
    (typeof value.content !== 'string' ||
      !hasMaxBytes(value.content, MAX_CONTENT_BYTES))
  ) {
    return false;
  }
  if (value.metadata === null || typeof value.metadata !== 'object')
    return false;
  const metadata = value.metadata as Record<string, unknown>;
  if (
    typeof metadata.ipHash !== 'string' ||
    metadata.ipHash.length === 0 ||
    !hasMaxBytes(metadata.ipHash, MAX_IP_HASH_BYTES)
  ) {
    return false;
  }
  if (
    !Number.isSafeInteger(metadata.timestamp) ||
    (metadata.timestamp as number) < 0
  ) {
    return false;
  }
  if (
    metadata.userAgent !== undefined &&
    (typeof metadata.userAgent !== 'string' ||
      !hasMaxBytes(metadata.userAgent, MAX_USER_AGENT_BYTES))
  ) {
    return false;
  }
  return true;
}

function encodeFrame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), 'utf8');
  if (payload.length === 0 || payload.length > MAX_TTYA_FRAME_SIZE) {
    throw new Error('TTYA frame exceeds maximum size');
  }
  const frame = Buffer.allocUnsafe(4 + payload.length);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

function parseJsonFrame(payload: Uint8Array): unknown {
  return JSON.parse(Buffer.from(payload).toString('utf8')) as unknown;
}

function connectionKey(conn: TTYASocket): string {
  const remoteKey = conn.remotePublicKey;
  return remoteKey instanceof Uint8Array && remoteKey.length > 0
    ? Buffer.from(remoteKey).toString('hex')
    : 'unknown';
}

export class TTYAManager extends EventEmitter {
  private readonly edPublicKey: Uint8Array;
  private readonly authSecret: Uint8Array;
  private swarm: Hyperswarm | null = null;
  private startPromise: Promise<void> | null = null;
  private bridgeConnection: TTYASocket | null = null;
  private decoder = new TTYAFrameDecoder();
  private visitors = new Map<string, TTYAVisitor>();
  private authenticated = false;
  private pendingAgentNonce: string | null = null;
  private channelBinding: Uint8Array | null = null;
  private sessionKey: Buffer | null = null;
  private receiveSequence = 0;
  private sendSequence = 0;
  private authTimeout: ReturnType<typeof setTimeout> | null = null;
  private visitorCleanupTimer: ReturnType<typeof setInterval> | null = null;
  private authFailures = new Map<string, AuthFailureState>();
  private globalAuthFailures: number[] = [];
  isRunning = false;

  constructor(edPublicKey: Uint8Array, authSecret: Uint8Array) {
    super();
    if (!(edPublicKey instanceof Uint8Array) || edPublicKey.length !== 32) {
      throw new Error('TTYA agent Ed25519 public key must be 32 bytes');
    }
    this.edPublicKey = new Uint8Array(edPublicKey);
    this.authSecret = copyAndValidateTTYAAuthSecret(authSecret);
  }

  async start(): Promise<void> {
    if (this.isRunning) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startInternal();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  private async startInternal(): Promise<void> {
    const swarm = new Hyperswarm();
    this.swarm = swarm;
    swarm.on('connection', (conn: TTYASocket) => this.acceptConnection(conn));

    try {
      const topic = deriveKey(
        this.edPublicKey,
        'networkselfmd-ttya-v1',
        '',
        32,
      );
      const discovery = swarm.join(Buffer.from(topic), {
        server: true,
        client: false,
      });
      await discovery.flushed();
      if (this.swarm !== swarm) {
        await swarm.destroy();
        return;
      }
      this.isRunning = true;
      this.visitorCleanupTimer = setInterval(
        () => this.cleanupStaleVisitors(),
        VISITOR_CLEANUP_INTERVAL_MS,
      );
      this.visitorCleanupTimer.unref?.();
    } catch (error) {
      if (this.swarm === swarm) this.swarm = null;
      await swarm.destroy().catch(() => {});
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.startPromise) await this.startPromise.catch(() => {});
    this.isRunning = false;

    if (this.visitorCleanupTimer) {
      clearInterval(this.visitorCleanupTimer);
      this.visitorCleanupTimer = null;
    }
    this.clearAuthTimeout();

    const connection = this.bridgeConnection;
    this.resetConnectionState();
    try {
      connection?.destroy();
    } catch {
      // ignore a closing transport
    }

    const swarm = this.swarm;
    this.swarm = null;
    if (swarm) await swarm.destroy();

    this.visitors.clear();
    this.authFailures.clear();
    this.globalAuthFailures = [];
  }

  getPending(): TTYAVisitor[] {
    return Array.from(this.visitors.values())
      .filter((visitor) => visitor.status === 'pending')
      .map((visitor) => ({ ...visitor }));
  }

  approve(visitorId: string): void {
    const visitor = this.visitors.get(visitorId);
    if (!visitor) throw new Error(`Unknown visitor: ${visitorId}`);
    visitor.status = 'approved';
    this.sendResponse({ type: 0x08, visitorId, action: 'approve' });
  }

  reject(visitorId: string): void {
    const visitor = this.visitors.get(visitorId);
    if (!visitor) throw new Error(`Unknown visitor: ${visitorId}`);
    visitor.status = 'rejected';
    this.visitors.delete(visitorId);
    this.sendResponse({ type: 0x08, visitorId, action: 'reject' });
  }

  reply(visitorId: string, content: string): void {
    const visitor = this.visitors.get(visitorId);
    if (!visitor) throw new Error(`Unknown visitor: ${visitorId}`);
    if (!hasMaxBytes(content, MAX_CONTENT_BYTES)) {
      throw new Error(`TTYA reply exceeds ${MAX_CONTENT_BYTES} bytes`);
    }
    this.sendResponse({ type: 0x08, visitorId, action: 'reply', content });
  }

  private acceptConnection(conn: TTYASocket): void {
    // A candidate never displaces an incumbent, even while it authenticates.
    if (this.bridgeConnection) {
      this.closeSocket(conn);
      return;
    }

    const now = Date.now();
    const key = connectionKey(conn);
    if (!this.mayAttemptAuthentication(key, now)) {
      this.closeSocket(conn);
      return;
    }

    let binding: Uint8Array;
    try {
      binding = copyAndValidateTTYAChannelBinding(conn.handshakeHash);
    } catch {
      this.recordAuthFailure(key, now);
      this.closeSocket(conn);
      return;
    }

    this.bridgeConnection = conn;
    this.decoder = new TTYAFrameDecoder();
    this.authenticated = false;
    this.channelBinding = binding;
    this.sessionKey = null;
    this.receiveSequence = 0;
    this.sendSequence = 0;

    conn.on('data', (chunk: Uint8Array) => {
      if (this.bridgeConnection !== conn) return;
      try {
        const frames = this.decoder.push(chunk);
        for (const frame of frames) {
          if (this.bridgeConnection !== conn) return;
          this.processFrame(conn, frame);
        }
      } catch {
        this.destroyConnection(conn, !this.authenticated);
      }
    });
    conn.on('close', () => this.handleConnectionClosed(conn));
    conn.on('error', () => this.handleConnectionClosed(conn));

    const agentNonce = randomBytes(TTYA_AUTH_NONCE_BYTES).toString('hex');
    this.pendingAgentNonce = agentNonce;
    const challenge: TTYAAuthChallengeFrame = {
      type: 'ttya-auth-challenge',
      version: TTYA_AUTH_VERSION,
      agentNonce,
    };

    this.authTimeout = setTimeout(() => {
      if (this.bridgeConnection === conn && !this.authenticated) {
        this.destroyConnection(conn, true);
      }
    }, AUTH_TIMEOUT_MS);
    this.authTimeout.unref?.();

    try {
      conn.write(encodeFrame(challenge));
    } catch {
      this.destroyConnection(conn, true);
    }
  }

  private processFrame(conn: TTYASocket, payload: Uint8Array): void {
    const parsed = parseJsonFrame(payload);
    if (!this.authenticated) {
      if (
        !isTTYAAuthResponseFrame(parsed) ||
        !this.verifyBridgeResponse(parsed)
      ) {
        throw new Error('Invalid TTYA bridge authentication');
      }

      const confirmation = this.createAuthConfirmation(parsed);
      const binding = this.channelBinding!;
      const sessionKey = createHmac('sha256', this.authSecret)
        .update(
          buildTTYASessionKeyPayload(
            parsed.agentNonce,
            parsed.bridgeNonce,
            binding,
          ),
        )
        .digest();
      this.sessionKey = sessionKey;
      this.authenticated = true;
      this.pendingAgentNonce = null;
      this.clearAuthTimeout();
      this.authFailures.delete(connectionKey(conn));
      conn.write(encodeFrame(confirmation));
      return;
    }

    if (!isTTYADataFrame(parsed)) {
      throw new Error('Expected authenticated TTYA data frame');
    }
    const request = this.verifyAndDecodeDataFrame(parsed);
    if (!isValidTTYARequest(request)) {
      throw new Error('Invalid TTYA request');
    }
    this.handleRequest(request);
  }

  private verifyBridgeResponse(frame: TTYAAuthResponseFrame): boolean {
    if (
      !this.pendingAgentNonce ||
      !this.channelBinding ||
      frame.agentNonce !== this.pendingAgentNonce
    ) {
      return false;
    }
    const expected = createHmac('sha256', this.authSecret)
      .update(
        buildTTYAAuthProofPayload(
          'bridge',
          frame.agentNonce,
          frame.bridgeNonce,
          this.channelBinding,
        ),
      )
      .digest();
    const received = Buffer.from(frame.proof, 'hex');
    return (
      received.length === expected.length && timingSafeEqual(expected, received)
    );
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
          this.channelBinding!,
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

  private verifyAndDecodeDataFrame(frame: TTYADataFrame): unknown {
    if (!this.sessionKey || frame.sequence !== this.receiveSequence) {
      throw new Error('Invalid TTYA data sequence');
    }
    const payload = Buffer.from(frame.payload, 'base64');
    if (payload.toString('base64') !== frame.payload) {
      throw new Error('Non-canonical TTYA data payload');
    }
    const expected = createHmac('sha256', this.sessionKey)
      .update(
        buildTTYADataProofPayload('bridge-to-agent', frame.sequence, payload),
      )
      .digest();
    const received = Buffer.from(frame.proof, 'hex');
    if (
      received.length !== expected.length ||
      !timingSafeEqual(expected, received)
    ) {
      throw new Error('Invalid TTYA data proof');
    }
    this.receiveSequence += 1;
    return JSON.parse(payload.toString('utf8')) as unknown;
  }

  private sendResponse(response: TTYAResponse): void {
    const conn = this.bridgeConnection;
    if (!conn || !this.authenticated || !this.sessionKey) return;
    try {
      const payload = Buffer.from(JSON.stringify(response), 'utf8');
      const sequence = this.sendSequence;
      const dataFrame: TTYADataFrame = {
        type: 'ttya-data',
        version: TTYA_AUTH_VERSION,
        sequence,
        payload: payload.toString('base64'),
        proof: createHmac('sha256', this.sessionKey)
          .update(
            buildTTYADataProofPayload('agent-to-bridge', sequence, payload),
          )
          .digest('hex'),
      };
      conn.write(encodeFrame(dataFrame));
      this.sendSequence += 1;
    } catch {
      this.destroyConnection(conn, false);
    }
  }

  private mayAttemptAuthentication(key: string, now: number): boolean {
    for (const [failedKey, state] of this.authFailures) {
      if (now - state.lastFailure >= AUTH_RATE_WINDOW_MS) {
        this.authFailures.delete(failedKey);
      }
    }
    this.globalAuthFailures = this.globalAuthFailures.filter(
      (timestamp) => now - timestamp < AUTH_RATE_WINDOW_MS,
    );
    if (this.globalAuthFailures.length >= AUTH_FAILURES_GLOBAL) return false;

    const state = this.authFailures.get(key);
    if (!state) return true;
    return state.failures < AUTH_FAILURES_PER_PEER && now >= state.blockedUntil;
  }

  private recordAuthFailure(key: string, now = Date.now()): void {
    this.globalAuthFailures = this.globalAuthFailures.filter(
      (timestamp) => now - timestamp < AUTH_RATE_WINDOW_MS,
    );
    this.globalAuthFailures.push(now);
    const previous = this.authFailures.get(key);
    const failures =
      previous && now - previous.lastFailure < AUTH_RATE_WINDOW_MS
        ? previous.failures + 1
        : 1;
    this.authFailures.set(key, {
      failures,
      lastFailure: now,
      blockedUntil:
        now +
        Math.min(
          AUTH_BACKOFF_MAX_MS,
          AUTH_BACKOFF_BASE_MS * 2 ** Math.min(failures - 1, 16),
        ),
    });
  }

  private clearAuthTimeout(): void {
    if (this.authTimeout) clearTimeout(this.authTimeout);
    this.authTimeout = null;
  }

  private handleConnectionClosed(conn: TTYASocket): void {
    if (this.bridgeConnection !== conn) return;
    this.resetConnectionState();
  }

  private destroyConnection(conn: TTYASocket, authFailure: boolean): void {
    if (this.bridgeConnection === conn) {
      if (authFailure) this.recordAuthFailure(connectionKey(conn));
      this.resetConnectionState();
    }
    this.closeSocket(conn);
  }

  private resetConnectionState(): void {
    this.clearAuthTimeout();
    this.bridgeConnection = null;
    this.decoder.reset();
    this.authenticated = false;
    this.pendingAgentNonce = null;
    this.channelBinding = null;
    this.sessionKey = null;
    this.receiveSequence = 0;
    this.sendSequence = 0;
  }

  private closeSocket(conn: TTYASocket): void {
    try {
      conn.destroy();
    } catch {
      // ignore a stale socket
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

  private handleRequest(request: TTYARequest): void {
    if (request.action === 'disconnect') {
      this.visitors.delete(request.visitorId);
      this.emit('visitor:disconnect', request.visitorId);
      return;
    }

    const existing = this.visitors.get(request.visitorId);
    if (!existing) {
      this.visitors.set(request.visitorId, {
        visitorId: request.visitorId,
        firstMessage: request.content ?? '',
        ipHash: request.metadata.ipHash,
        timestamp: request.metadata.timestamp,
        status: 'pending',
        lastActivity: Date.now(),
      });
    } else {
      existing.lastActivity = Date.now();
    }

    this.emit('visitor:request', {
      visitorId: request.visitorId,
      content: request.content,
      ipHash: request.metadata.ipHash,
      timestamp: request.metadata.timestamp,
      status: this.visitors.get(request.visitorId)!.status,
    });
  }
}
