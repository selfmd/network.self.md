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

const AUTH_TIMEOUT_MS = 5_000;
const AUTH_RATE_WINDOW_MS = 60_000;
const AUTH_FAILURES_PER_PEER = 5;
const AUTH_FAILURES_GLOBAL = 20;
const AUTH_BACKOFF_BASE_MS = 250;
const AUTH_BACKOFF_MAX_MS = 30_000;
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
  private responseHandler: ((response: TTYAResponse) => void) | null = null;
  private pendingRequests: TTYARequest[] = [];
  private decoder = new TTYAFrameDecoder();
  private authState: BridgeAuthState = 'awaiting-challenge';
  private agentNonce: string | null = null;
  private bridgeNonce: string | null = null;
  private channelBinding: Uint8Array | null = null;
  private sessionKey: Buffer | null = null;
  private receiveSequence = 0;
  private sendSequence = 0;
  private authTimeout: ReturnType<typeof setTimeout> | null = null;
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
    const connection = this.agentConnection;
    this.resetConnectionState();
    try {
      connection?.destroy();
    } catch {
      // ignore a closing transport
    }
    const swarm = this.swarm;
    this.swarm = null;
    if (swarm) await swarm.destroy();
    this.pendingRequests = [];
    this.authFailures.clear();
    this.globalAuthFailures = [];
  }

  sendToAgent(request: TTYARequest): void {
    if (this.agentConnection && this.authState === 'authenticated') {
      if (this.writeRequest(request, this.agentConnection)) return;
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
    return this.agentConnection !== null && this.authState === 'authenticated';
  }

  private acceptConnection(conn: TTYASocket): void {
    // A late or malicious socket cannot evict the current candidate/incumbent.
    if (this.agentConnection) {
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

    this.agentConnection = conn;
    this.decoder = new TTYAFrameDecoder();
    this.resetAuthentication(binding);
    conn.on('data', (chunk: Uint8Array) => {
      if (this.agentConnection !== conn) return;
      try {
        const frames = this.decoder.push(chunk);
        for (const frame of frames) {
          if (this.agentConnection !== conn) return;
          this.processFrame(conn, frame);
        }
      } catch {
        this.destroyConnection(conn, this.authState !== 'authenticated');
      }
    });
    conn.on('close', () => this.handleConnectionClosed(conn));
    conn.on('error', () => this.handleConnectionClosed(conn));

    this.authTimeout = setTimeout(() => {
      if (this.agentConnection === conn && this.authState !== 'authenticated') {
        this.destroyConnection(conn, true);
      }
    }, AUTH_TIMEOUT_MS);
    this.authTimeout.unref?.();
  }

  private processFrame(conn: TTYASocket, payload: Uint8Array): void {
    const parsed = parseJsonFrame(payload);
    if (this.authState === 'awaiting-challenge') {
      if (!isTTYAAuthChallengeFrame(parsed) || !this.channelBinding) {
        throw new Error('Invalid TTYA authentication challenge');
      }
      this.agentNonce = parsed.agentNonce;
      this.bridgeNonce = randomBytes(TTYA_AUTH_NONCE_BYTES).toString('hex');
      const response: TTYAAuthResponseFrame = {
        type: 'ttya-auth-response',
        version: TTYA_AUTH_VERSION,
        agentNonce: this.agentNonce,
        bridgeNonce: this.bridgeNonce,
        proof: createHmac('sha256', this.authSecret)
          .update(
            buildTTYAAuthProofPayload(
              'bridge',
              this.agentNonce,
              this.bridgeNonce,
              this.channelBinding,
            ),
          )
          .digest('hex'),
      };
      this.authState = 'awaiting-confirmation';
      conn.write(encodeFrame(response));
      return;
    }

    if (this.authState === 'awaiting-confirmation') {
      if (
        !isTTYAAuthConfirmationFrame(parsed) ||
        !this.verifyAgentConfirmation(parsed)
      ) {
        throw new Error('Invalid TTYA authentication confirmation');
      }
      this.sessionKey = createHmac('sha256', this.authSecret)
        .update(
          buildTTYASessionKeyPayload(
            this.agentNonce!,
            this.bridgeNonce!,
            this.channelBinding!,
          ),
        )
        .digest();
      this.authState = 'authenticated';
      this.agentNonce = null;
      this.bridgeNonce = null;
      this.clearAuthTimeout();
      this.authFailures.delete(connectionKey(conn));
      this.flushPendingRequests(conn);
      return;
    }

    if (!isTTYADataFrame(parsed)) {
      throw new Error('Expected authenticated TTYA data frame');
    }
    const response = this.verifyAndDecodeDataFrame(parsed);
    if (!isValidTTYAResponse(response)) {
      throw new Error('Invalid TTYA response');
    }
    this.responseHandler?.(response);
  }

  private verifyAgentConfirmation(frame: TTYAAuthConfirmationFrame): boolean {
    if (
      !this.agentNonce ||
      !this.bridgeNonce ||
      !this.channelBinding ||
      frame.agentNonce !== this.agentNonce ||
      frame.bridgeNonce !== this.bridgeNonce
    ) {
      return false;
    }
    const expected = createHmac('sha256', this.authSecret)
      .update(
        buildTTYAAuthProofPayload(
          'agent',
          this.agentNonce,
          this.bridgeNonce,
          this.channelBinding,
        ),
      )
      .digest();
    const received = Buffer.from(frame.proof, 'hex');
    return (
      received.length === expected.length && timingSafeEqual(expected, received)
    );
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
    this.receiveSequence += 1;
    return JSON.parse(payload.toString('utf8')) as unknown;
  }

  private writeRequest(request: TTYARequest, conn: TTYASocket): boolean {
    if (
      this.agentConnection !== conn ||
      this.authState !== 'authenticated' ||
      !this.sessionKey
    ) {
      return false;
    }
    try {
      const payload = Buffer.from(JSON.stringify(request), 'utf8');
      const sequence = this.sendSequence;
      const frame: TTYADataFrame = {
        type: 'ttya-data',
        version: TTYA_AUTH_VERSION,
        sequence,
        payload: payload.toString('base64'),
        proof: createHmac('sha256', this.sessionKey)
          .update(
            buildTTYADataProofPayload('bridge-to-agent', sequence, payload),
          )
          .digest('hex'),
      };
      conn.write(encodeFrame(frame));
      this.sendSequence += 1;
      return true;
    } catch {
      this.destroyConnection(conn, false);
      return false;
    }
  }

  private flushPendingRequests(conn: TTYASocket): void {
    const queued = this.pendingRequests;
    this.pendingRequests = [];
    for (let index = 0; index < queued.length; index += 1) {
      if (!this.writeRequest(queued[index], conn)) {
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

  private clearAuthTimeout(): void {
    if (this.authTimeout) clearTimeout(this.authTimeout);
    this.authTimeout = null;
  }

  private resetAuthentication(binding: Uint8Array | null = null): void {
    this.clearAuthTimeout();
    this.authState = 'awaiting-challenge';
    this.agentNonce = null;
    this.bridgeNonce = null;
    this.channelBinding = binding;
    this.sessionKey = null;
    this.receiveSequence = 0;
    this.sendSequence = 0;
  }

  private handleConnectionClosed(conn: TTYASocket): void {
    if (this.agentConnection !== conn) return;
    this.resetConnectionState();
  }

  private destroyConnection(conn: TTYASocket, authFailure: boolean): void {
    if (this.agentConnection === conn) {
      if (authFailure) this.recordAuthFailure(connectionKey(conn));
      this.resetConnectionState();
    }
    this.closeSocket(conn);
  }

  private resetConnectionState(): void {
    this.agentConnection = null;
    this.decoder.reset();
    this.resetAuthentication();
  }

  private closeSocket(conn: TTYASocket): void {
    try {
      conn.destroy();
    } catch {
      // ignore a stale socket
    }
  }
}
