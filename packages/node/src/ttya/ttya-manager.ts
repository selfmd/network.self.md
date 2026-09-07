import { EventEmitter } from 'node:events';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import Hyperswarm from 'hyperswarm';
import {
  MAX_TTYA_FRAME_SIZE,
  MAX_TTYA_USER_AGENT_BYTES,
  MAX_TTYA_CONTENT_BYTES,
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

interface ManagerConnectionState {
  readonly decoder: TTYAFrameDecoder;
  readonly binding: Uint8Array;
  readonly key: string;
  pendingAgentNonce: string;
  sessionKey: Buffer | null;
  authenticated: boolean;
  receiveSequence: number;
  sendSequence: number;
  authTimeout: ReturnType<typeof setTimeout> | null;
}

const AUTH_TIMEOUT_MS = 5_000;
const AUTH_RATE_WINDOW_MS = 60_000;
const AUTH_FAILURES_PER_PEER = 5;
const AUTH_FAILURES_GLOBAL = 20;
const AUTH_BACKOFF_BASE_MS = 250;
const AUTH_BACKOFF_MAX_MS = 30_000;
export const MAX_TTYA_AUTH_CANDIDATES = 4;
const VISITOR_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const VISITOR_STALE_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_VISITOR_ID_BYTES = 128;
const MAX_IP_HASH_BYTES = 128;
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
      !hasMaxBytes(value.content, MAX_TTYA_CONTENT_BYTES))
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
      !hasMaxBytes(metadata.userAgent, MAX_TTYA_USER_AGENT_BYTES))
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
  private connections = new Map<TTYASocket, ManagerConnectionState>();
  private visitors = new Map<string, TTYAVisitor>();
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
    const connections = [...this.connections.keys()];
    this.bridgeConnection = null;
    for (const connection of connections) {
      this.removeConnection(connection);
      this.closeSocket(connection);
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
    if (!hasMaxBytes(content, MAX_TTYA_CONTENT_BYTES)) {
      throw new Error(`TTYA reply exceeds ${MAX_TTYA_CONTENT_BYTES} bytes`);
    }
    this.sendResponse({ type: 0x08, visitorId, action: 'reply', content });
  }

  private acceptConnection(conn: TTYASocket): void {
    // An authenticated incumbent is stable. Before one exists, a small pool
    // prevents a single slow/hostile candidate from monopolizing the topic.
    if (this.bridgeConnection) {
      this.closeSocket(conn);
      return;
    }
    if (this.connections.size >= MAX_TTYA_AUTH_CANDIDATES) {
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

    const agentNonce = randomBytes(TTYA_AUTH_NONCE_BYTES).toString('hex');
    const state: ManagerConnectionState = {
      decoder: new TTYAFrameDecoder(),
      binding,
      key,
      pendingAgentNonce: agentNonce,
      sessionKey: null,
      authenticated: false,
      receiveSequence: 0,
      sendSequence: 0,
      authTimeout: null,
    };
    this.connections.set(conn, state);

    conn.on('data', (chunk: Uint8Array) => {
      if (this.connections.get(conn) !== state) return;
      try {
        const frames = state.decoder.push(chunk);
        for (const frame of frames) {
          if (this.connections.get(conn) !== state) return;
          this.processFrame(conn, state, frame);
        }
      } catch {
        this.destroyConnection(conn, !state.authenticated);
      }
    });
    conn.on('close', () => this.handleConnectionClosed(conn));
    conn.on('error', () => this.handleConnectionClosed(conn));

    const challenge: TTYAAuthChallengeFrame = {
      type: 'ttya-auth-challenge',
      version: TTYA_AUTH_VERSION,
      agentNonce,
    };

    state.authTimeout = setTimeout(() => {
      if (this.connections.get(conn) === state && !state.authenticated) {
        this.destroyConnection(conn, true);
      }
    }, AUTH_TIMEOUT_MS);
    state.authTimeout.unref?.();

    try {
      conn.write(encodeFrame(challenge));
    } catch {
      this.destroyConnection(conn, true);
    }
  }

  private processFrame(
    conn: TTYASocket,
    state: ManagerConnectionState,
    payload: Uint8Array,
  ): void {
    const parsed = parseJsonFrame(payload);
    if (!state.authenticated) {
      if (
        !isTTYAAuthResponseFrame(parsed) ||
        !this.verifyBridgeResponse(state, parsed)
      ) {
        throw new Error('Invalid TTYA bridge authentication');
      }

      const confirmation = this.createAuthConfirmation(state, parsed);
      const sessionKey = createHmac('sha256', this.authSecret)
        .update(
          buildTTYASessionKeyPayload(
            parsed.agentNonce,
            parsed.bridgeNonce,
            state.binding,
          ),
        )
        .digest();

      if (this.bridgeConnection && this.bridgeConnection !== conn) {
        this.destroyConnection(conn, false);
        return;
      }
      state.sessionKey = sessionKey;
      state.authenticated = true;
      state.pendingAgentNonce = '';
      this.clearAuthTimeout(state);
      this.authFailures.delete(state.key);
      this.bridgeConnection = conn;
      for (const candidate of [...this.connections.keys()]) {
        if (candidate !== conn) this.destroyConnection(candidate, false);
      }
      conn.write(encodeFrame(confirmation));
      return;
    }

    if (!isTTYADataFrame(parsed)) {
      throw new Error('Expected authenticated TTYA data frame');
    }
    const request = this.verifyAndDecodeDataFrame(state, parsed);
    if (!isValidTTYARequest(request)) {
      throw new Error('Invalid TTYA request');
    }
    this.handleRequest(request);
  }

  private verifyBridgeResponse(
    state: ManagerConnectionState,
    frame: TTYAAuthResponseFrame,
  ): boolean {
    if (
      !state.pendingAgentNonce ||
      frame.agentNonce !== state.pendingAgentNonce
    ) {
      return false;
    }
    const expected = createHmac('sha256', this.authSecret)
      .update(
        buildTTYAAuthProofPayload(
          'bridge',
          frame.agentNonce,
          frame.bridgeNonce,
          state.binding,
        ),
      )
      .digest();
    const received = Buffer.from(frame.proof, 'hex');
    return (
      received.length === expected.length && timingSafeEqual(expected, received)
    );
  }

  private createAuthConfirmation(
    state: ManagerConnectionState,
    response: TTYAAuthResponseFrame,
  ): TTYAAuthConfirmationFrame {
    const proof = createHmac('sha256', this.authSecret)
      .update(
        buildTTYAAuthProofPayload(
          'agent',
          response.agentNonce,
          response.bridgeNonce,
          state.binding,
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

  private verifyAndDecodeDataFrame(
    state: ManagerConnectionState,
    frame: TTYADataFrame,
  ): unknown {
    if (!state.sessionKey || frame.sequence !== state.receiveSequence) {
      throw new Error('Invalid TTYA data sequence');
    }
    const payload = Buffer.from(frame.payload, 'base64');
    if (payload.toString('base64') !== frame.payload) {
      throw new Error('Non-canonical TTYA data payload');
    }
    const expected = createHmac('sha256', state.sessionKey)
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
    state.receiveSequence += 1;
    return JSON.parse(payload.toString('utf8')) as unknown;
  }

  private sendResponse(response: TTYAResponse): void {
    const conn = this.bridgeConnection;
    const state = conn ? this.connections.get(conn) : undefined;
    if (!conn || !state?.authenticated || !state.sessionKey) return;
    try {
      const payload = Buffer.from(JSON.stringify(response), 'utf8');
      const sequence = state.sendSequence;
      const dataFrame: TTYADataFrame = {
        type: 'ttya-data',
        version: TTYA_AUTH_VERSION,
        sequence,
        payload: payload.toString('base64'),
        proof: createHmac('sha256', state.sessionKey)
          .update(
            buildTTYADataProofPayload('agent-to-bridge', sequence, payload),
          )
          .digest('hex'),
      };
      conn.write(encodeFrame(dataFrame));
      state.sendSequence += 1;
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

  private clearAuthTimeout(state: ManagerConnectionState): void {
    if (state.authTimeout) clearTimeout(state.authTimeout);
    state.authTimeout = null;
  }

  private handleConnectionClosed(conn: TTYASocket): void {
    const state = this.connections.get(conn);
    if (state && !state.authenticated) this.recordAuthFailure(state.key);
    this.removeConnection(conn);
  }

  private destroyConnection(conn: TTYASocket, authFailure: boolean): void {
    const state = this.connections.get(conn);
    if (state && authFailure) this.recordAuthFailure(state.key);
    this.removeConnection(conn);
    this.closeSocket(conn);
  }

  private removeConnection(conn: TTYASocket): void {
    const state = this.connections.get(conn);
    if (!state) return;
    this.clearAuthTimeout(state);
    state.decoder.reset();
    this.connections.delete(conn);
    if (this.bridgeConnection === conn) this.bridgeConnection = null;
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
