/** Noise-bound, mutually authenticated Hyperswarm bridge for TTYA. */
import Hyperswarm from 'hyperswarm';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
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
  isTTYAAuthChallengeFrame,
  isTTYAAuthConfirmationFrame,
  isTTYADataFrame,
  type TTYAAuthConfirmationFrame,
  type TTYAAuthResponseFrame,
  type TTYADataFrame,
} from '@networkselfmd/core';
import type { TTYARequest, TTYAResponse } from './types.js';

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

type BridgeAuthState =
  | 'awaiting-challenge'
  | 'awaiting-confirmation'
  | 'authenticated';

interface BridgeConnectionState {
  readonly decoder: TTYAFrameDecoder;
  readonly binding: Uint8Array;
  readonly key: string;
  authState: BridgeAuthState;
  agentNonce: string | null;
  bridgeNonce: string | null;
  sessionKey: Buffer | null;
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
const MAX_PENDING_REQUESTS = 1_000;
const MAX_VISITOR_ID_BYTES = 128;
const MAX_CONTENT_BYTES = 4_096;
const VALID_RESPONSE_ACTIONS = new Set(['approve', 'reject', 'reply']);

function hasMaxBytes(value: string, maximum: number): boolean {
  return Buffer.byteLength(value, 'utf8') <= maximum;
}

function isValidTTYAResponse(obj: unknown): obj is TTYAResponse {
  if (obj === null || typeof obj !== 'object') return false;
  const value = obj as Record<string, unknown>;
  if (value.type !== 0x08) return false;
  if (
    typeof value.visitorId !== 'string' ||
    value.visitorId.length === 0 ||
    !hasMaxBytes(value.visitorId, MAX_VISITOR_ID_BYTES)
  ) {
    return false;
  }
  if (
    typeof value.action !== 'string' ||
    !VALID_RESPONSE_ACTIONS.has(value.action)
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
  if (
    value.sessionToken !== undefined &&
    typeof value.sessionToken !== 'string'
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

export class TTYABridge {
  private readonly agentEdPublicKey: Uint8Array;
  private readonly authSecret: Uint8Array;
  private swarm: Hyperswarm | null = null;
  private connectPromise: Promise<void> | null = null;
  private agentConnection: TTYASocket | null = null;
  private connections = new Map<TTYASocket, BridgeConnectionState>();
  private responseHandler: ((response: TTYAResponse) => void) | null = null;
  private pendingRequests: TTYARequest[] = [];
  private authFailures = new Map<string, AuthFailureState>();
  private globalAuthFailures: number[] = [];

  constructor(agentEdPublicKey: Uint8Array, authSecret: Uint8Array) {
    if (
      !(agentEdPublicKey instanceof Uint8Array) ||
      agentEdPublicKey.length !== 32
    ) {
      throw new Error('TTYA agent Ed25519 public key must be 32 bytes');
    }
    this.agentEdPublicKey = new Uint8Array(agentEdPublicKey);
    this.authSecret = copyAndValidateTTYAAuthSecret(authSecret);
  }

  private deriveTopic(): Buffer {
    return Buffer.from(
      deriveKey(this.agentEdPublicKey, 'networkselfmd-ttya-v1', '', 32),
    );
  }

  async connect(): Promise<void> {
    if (this.connectPromise) return this.connectPromise;
    if (this.swarm) return;
    this.connectPromise = this.connectInternal();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  private async connectInternal(): Promise<void> {
    const swarm = new Hyperswarm();
    this.swarm = swarm;
    swarm.on('connection', (conn: TTYASocket) => this.acceptConnection(conn));
    try {
      swarm.join(this.deriveTopic(), { client: true, server: false });
      await swarm.flush();
      if (this.swarm !== swarm) await swarm.destroy();
    } catch (error) {
      if (this.swarm === swarm) this.swarm = null;
      await swarm.destroy().catch(() => {});
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (this.connectPromise) await this.connectPromise.catch(() => {});
    const connections = [...this.connections.keys()];
    this.agentConnection = null;
    for (const connection of connections) {
      this.removeConnection(connection);
      this.closeSocket(connection);
    }
    const swarm = this.swarm;
    this.swarm = null;
    if (swarm) await swarm.destroy();
    this.pendingRequests = [];
    this.authFailures.clear();
    this.globalAuthFailures = [];
  }

  sendToAgent(request: TTYARequest): void {
    const connection = this.agentConnection;
    const state = connection ? this.connections.get(connection) : undefined;
    if (connection && state?.authState === 'authenticated') {
      if (this.writeRequest(request, connection, state)) return;
    }
    if (this.pendingRequests.length >= MAX_PENDING_REQUESTS) {
      this.pendingRequests.shift();
    }
    this.pendingRequests.push(structuredClone(request));
  }

  onAgentResponse(handler: (response: TTYAResponse) => void): void {
    this.responseHandler = handler;
  }

  get isConnected(): boolean {
    if (!this.agentConnection) return false;
    return (
      this.connections.get(this.agentConnection)?.authState === 'authenticated'
    );
  }

  private acceptConnection(conn: TTYASocket): void {
    // Keep an authenticated incumbent stable, but allow a bounded race among
    // candidates so a silent first socket cannot monopolize the topic.
    if (this.agentConnection) {
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

    const state: BridgeConnectionState = {
      decoder: new TTYAFrameDecoder(),
      binding,
      key,
      authState: 'awaiting-challenge',
      agentNonce: null,
      bridgeNonce: null,
      sessionKey: null,
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
        this.destroyConnection(conn, state.authState !== 'authenticated');
      }
    });
    conn.on('close', () => this.handleConnectionClosed(conn));
    conn.on('error', () => this.handleConnectionClosed(conn));

    state.authTimeout = setTimeout(() => {
      if (
        this.connections.get(conn) === state &&
        state.authState !== 'authenticated'
      ) {
        this.destroyConnection(conn, true);
      }
    }, AUTH_TIMEOUT_MS);
    state.authTimeout.unref?.();
  }

  private processFrame(
    conn: TTYASocket,
    state: BridgeConnectionState,
    payload: Uint8Array,
  ): void {
    const parsed = parseJsonFrame(payload);
    if (state.authState === 'awaiting-challenge') {
      if (!isTTYAAuthChallengeFrame(parsed)) {
        throw new Error('Invalid TTYA authentication challenge');
      }
      state.agentNonce = parsed.agentNonce;
      state.bridgeNonce = randomBytes(TTYA_AUTH_NONCE_BYTES).toString('hex');
      const response: TTYAAuthResponseFrame = {
        type: 'ttya-auth-response',
        version: TTYA_AUTH_VERSION,
        agentNonce: state.agentNonce,
        bridgeNonce: state.bridgeNonce,
        proof: createHmac('sha256', this.authSecret)
          .update(
            buildTTYAAuthProofPayload(
              'bridge',
              state.agentNonce,
              state.bridgeNonce,
              state.binding,
            ),
          )
          .digest('hex'),
      };
      state.authState = 'awaiting-confirmation';
      conn.write(encodeFrame(response));
      return;
    }

    if (state.authState === 'awaiting-confirmation') {
      if (
        !isTTYAAuthConfirmationFrame(parsed) ||
        !this.verifyAgentConfirmation(state, parsed)
      ) {
        throw new Error('Invalid TTYA authentication confirmation');
      }
      state.sessionKey = createHmac('sha256', this.authSecret)
        .update(
          buildTTYASessionKeyPayload(
            state.agentNonce!,
            state.bridgeNonce!,
            state.binding,
          ),
        )
        .digest();
      if (this.agentConnection && this.agentConnection !== conn) {
        this.destroyConnection(conn, false);
        return;
      }
      state.authState = 'authenticated';
      state.agentNonce = null;
      state.bridgeNonce = null;
      this.clearAuthTimeout(state);
      this.authFailures.delete(state.key);
      this.agentConnection = conn;
      for (const candidate of [...this.connections.keys()]) {
        if (candidate !== conn) this.destroyConnection(candidate, false);
      }
      this.flushPendingRequests(conn, state);
      return;
    }

    if (!isTTYADataFrame(parsed)) {
      throw new Error('Expected authenticated TTYA data frame');
    }
    const response = this.verifyAndDecodeDataFrame(state, parsed);
    if (!isValidTTYAResponse(response)) {
      throw new Error('Invalid TTYA response');
    }
    this.responseHandler?.(response);
  }

  private verifyAgentConfirmation(
    state: BridgeConnectionState,
    frame: TTYAAuthConfirmationFrame,
  ): boolean {
    if (
      !state.agentNonce ||
      !state.bridgeNonce ||
      frame.agentNonce !== state.agentNonce ||
      frame.bridgeNonce !== state.bridgeNonce
    ) {
      return false;
    }
    const expected = createHmac('sha256', this.authSecret)
      .update(
        buildTTYAAuthProofPayload(
          'agent',
          state.agentNonce,
          state.bridgeNonce,
          state.binding,
        ),
      )
      .digest();
    const received = Buffer.from(frame.proof, 'hex');
    return (
      received.length === expected.length && timingSafeEqual(expected, received)
    );
  }

  private verifyAndDecodeDataFrame(
    state: BridgeConnectionState,
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
        buildTTYADataProofPayload('agent-to-bridge', frame.sequence, payload),
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

  private writeRequest(
    request: TTYARequest,
    conn: TTYASocket,
    state: BridgeConnectionState,
  ): boolean {
    if (
      this.agentConnection !== conn ||
      state.authState !== 'authenticated' ||
      !state.sessionKey
    ) {
      return false;
    }
    try {
      const payload = Buffer.from(JSON.stringify(request), 'utf8');
      const sequence = state.sendSequence;
      const frame: TTYADataFrame = {
        type: 'ttya-data',
        version: TTYA_AUTH_VERSION,
        sequence,
        payload: payload.toString('base64'),
        proof: createHmac('sha256', state.sessionKey)
          .update(
            buildTTYADataProofPayload('bridge-to-agent', sequence, payload),
          )
          .digest('hex'),
      };
      conn.write(encodeFrame(frame));
      state.sendSequence += 1;
      return true;
    } catch {
      this.destroyConnection(conn, false);
      return false;
    }
  }

  private flushPendingRequests(
    conn: TTYASocket,
    state: BridgeConnectionState,
  ): void {
    const queued = this.pendingRequests;
    this.pendingRequests = [];
    for (let index = 0; index < queued.length; index += 1) {
      if (!this.writeRequest(queued[index], conn, state)) {
        this.pendingRequests.unshift(...queued.slice(index));
        return;
      }
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

  private clearAuthTimeout(state: BridgeConnectionState): void {
    if (state.authTimeout) clearTimeout(state.authTimeout);
    state.authTimeout = null;
  }

  private handleConnectionClosed(conn: TTYASocket): void {
    const state = this.connections.get(conn);
    if (state && state.authState !== 'authenticated') {
      this.recordAuthFailure(state.key);
    }
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
    if (this.agentConnection === conn) this.agentConnection = null;
  }

  private closeSocket(conn: TTYASocket): void {
    try {
      conn.destroy();
    } catch {
      // ignore a stale socket
    }
  }
}
