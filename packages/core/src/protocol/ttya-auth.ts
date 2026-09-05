export const TTYA_AUTH_PROTOCOL = 'networkselfmd-ttya-auth-v3' as const;
export const TTYA_AUTH_VERSION = 3 as const;
export const TTYA_AUTH_NONCE_BYTES = 32;
export const TTYA_AUTH_PROOF_BYTES = 32;
export const TTYA_AUTH_SECRET_MIN_BYTES = 32;
export const TTYA_CHANNEL_BINDING_MIN_BYTES = 32;
export const TTYA_CHANNEL_BINDING_MAX_BYTES = 128;
export const MAX_TTYA_FRAME_SIZE = 65_536;
/** Application limits enforced by both ends of the authenticated relay. */
export const MAX_TTYA_CONTENT_BYTES = 4_096;
export const MAX_TTYA_USER_AGENT_BYTES = 1_024;

export type TTYAAuthRole = 'bridge' | 'agent';
export type TTYADataDirection = 'bridge-to-agent' | 'agent-to-bridge';

export interface TTYAAuthChallengeFrame {
  type: 'ttya-auth-challenge';
  version: typeof TTYA_AUTH_VERSION;
  agentNonce: string;
}

export interface TTYAAuthResponseFrame {
  type: 'ttya-auth-response';
  version: typeof TTYA_AUTH_VERSION;
  agentNonce: string;
  bridgeNonce: string;
  proof: string;
}

export interface TTYAAuthConfirmationFrame {
  type: 'ttya-auth-confirmation';
  version: typeof TTYA_AUTH_VERSION;
  agentNonce: string;
  bridgeNonce: string;
  proof: string;
}

/** Every application message is carried in an authenticated, ordered envelope. */
export interface TTYADataFrame {
  type: 'ttya-data';
  version: typeof TTYA_AUTH_VERSION;
  sequence: number;
  /** Canonical base64 of the JSON application message. */
  payload: string;
  proof: string;
}

export type TTYAAuthFrame =
  | TTYAAuthChallengeFrame
  | TTYAAuthResponseFrame
  | TTYAAuthConfirmationFrame;

const HEX_PATTERN = /^[0-9a-f]+$/;
const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const encoder = new TextEncoder();

function isHexBytes(value: unknown, byteLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.length === byteLength * 2 &&
    HEX_PATTERN.test(value)
  );
}

function isSafeSequence(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function isTTYAAuthChallengeFrame(
  value: unknown,
): value is TTYAAuthChallengeFrame {
  if (value === null || typeof value !== 'object') return false;
  const frame = value as Record<string, unknown>;
  return (
    frame.type === 'ttya-auth-challenge' &&
    frame.version === TTYA_AUTH_VERSION &&
    isHexBytes(frame.agentNonce, TTYA_AUTH_NONCE_BYTES)
  );
}

export function isTTYAAuthResponseFrame(
  value: unknown,
): value is TTYAAuthResponseFrame {
  if (value === null || typeof value !== 'object') return false;
  const frame = value as Record<string, unknown>;
  return (
    frame.type === 'ttya-auth-response' &&
    frame.version === TTYA_AUTH_VERSION &&
    isHexBytes(frame.agentNonce, TTYA_AUTH_NONCE_BYTES) &&
    isHexBytes(frame.bridgeNonce, TTYA_AUTH_NONCE_BYTES) &&
    isHexBytes(frame.proof, TTYA_AUTH_PROOF_BYTES)
  );
}

export function isTTYAAuthConfirmationFrame(
  value: unknown,
): value is TTYAAuthConfirmationFrame {
  if (value === null || typeof value !== 'object') return false;
  const frame = value as Record<string, unknown>;
  return (
    frame.type === 'ttya-auth-confirmation' &&
    frame.version === TTYA_AUTH_VERSION &&
    isHexBytes(frame.agentNonce, TTYA_AUTH_NONCE_BYTES) &&
    isHexBytes(frame.bridgeNonce, TTYA_AUTH_NONCE_BYTES) &&
    isHexBytes(frame.proof, TTYA_AUTH_PROOF_BYTES)
  );
}

export function isTTYADataFrame(value: unknown): value is TTYADataFrame {
  if (value === null || typeof value !== 'object') return false;
  const frame = value as Record<string, unknown>;
  return (
    frame.type === 'ttya-data' &&
    frame.version === TTYA_AUTH_VERSION &&
    isSafeSequence(frame.sequence) &&
    typeof frame.payload === 'string' &&
    frame.payload.length > 0 &&
    BASE64_PATTERN.test(frame.payload) &&
    isHexBytes(frame.proof, TTYA_AUTH_PROOF_BYTES)
  );
}

function hexToBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function appendLengthPrefixed(
  target: Uint8Array,
  offset: number,
  value: Uint8Array,
): void {
  const view = new DataView(
    target.buffer,
    target.byteOffset,
    target.byteLength,
  );
  view.setUint16(offset, value.length, false);
  target.set(value, offset + 2);
}

/** Return an owned PSK copy after enforcing the production entropy floor. */
export function copyAndValidateTTYAAuthSecret(secret: Uint8Array): Uint8Array {
  if (
    !(secret instanceof Uint8Array) ||
    secret.length < TTYA_AUTH_SECRET_MIN_BYTES
  ) {
    throw new Error(
      `TTYA authentication secret must contain at least ${TTYA_AUTH_SECRET_MIN_BYTES} random bytes`,
    );
  }
  return new Uint8Array(secret);
}

/** Return an owned copy of the Noise handshake hash used as channel binding. */
export function copyAndValidateTTYAChannelBinding(
  binding: Uint8Array | null | undefined,
): Uint8Array {
  if (
    !(binding instanceof Uint8Array) ||
    binding.length < TTYA_CHANNEL_BINDING_MIN_BYTES ||
    binding.length > TTYA_CHANNEL_BINDING_MAX_BYTES
  ) {
    throw new Error('Missing or invalid Noise channel binding');
  }
  return new Uint8Array(binding);
}

/**
 * Canonical proof input for the mutual TTYA handshake. Both fresh nonces and
 * the local Noise transcript hash are covered, preventing a proof from being
 * relayed between two independent encrypted connections.
 */
export function buildTTYAAuthProofPayload(
  role: TTYAAuthRole,
  agentNonce: string,
  bridgeNonce: string,
  channelBinding: Uint8Array,
): Uint8Array {
  if (
    !isHexBytes(agentNonce, TTYA_AUTH_NONCE_BYTES) ||
    !isHexBytes(bridgeNonce, TTYA_AUTH_NONCE_BYTES)
  ) {
    throw new Error('Invalid TTYA authentication nonce');
  }
  const binding = copyAndValidateTTYAChannelBinding(channelBinding);
  const prefix = encoder.encode(`${TTYA_AUTH_PROTOCOL}\0proof\0${role}\0`);
  const payload = new Uint8Array(
    prefix.length + TTYA_AUTH_NONCE_BYTES * 2 + 2 + binding.length,
  );
  let offset = 0;
  payload.set(prefix, offset);
  offset += prefix.length;
  payload.set(hexToBytes(agentNonce), offset);
  offset += TTYA_AUTH_NONCE_BYTES;
  payload.set(hexToBytes(bridgeNonce), offset);
  offset += TTYA_AUTH_NONCE_BYTES;
  appendLengthPrefixed(payload, offset, binding);
  return payload;
}

/** Canonical input used to derive the post-authentication application key. */
export function buildTTYASessionKeyPayload(
  agentNonce: string,
  bridgeNonce: string,
  channelBinding: Uint8Array,
): Uint8Array {
  if (
    !isHexBytes(agentNonce, TTYA_AUTH_NONCE_BYTES) ||
    !isHexBytes(bridgeNonce, TTYA_AUTH_NONCE_BYTES)
  ) {
    throw new Error('Invalid TTYA authentication nonce');
  }
  const binding = copyAndValidateTTYAChannelBinding(channelBinding);
  const prefix = encoder.encode(`${TTYA_AUTH_PROTOCOL}\0session-key\0`);
  const payload = new Uint8Array(
    prefix.length + TTYA_AUTH_NONCE_BYTES * 2 + 2 + binding.length,
  );
  let offset = 0;
  payload.set(prefix, offset);
  offset += prefix.length;
  payload.set(hexToBytes(agentNonce), offset);
  offset += TTYA_AUTH_NONCE_BYTES;
  payload.set(hexToBytes(bridgeNonce), offset);
  offset += TTYA_AUTH_NONCE_BYTES;
  appendLengthPrefixed(payload, offset, binding);
  return payload;
}

/** Canonical input for an ordered application-frame MAC. */
export function buildTTYADataProofPayload(
  direction: TTYADataDirection,
  sequence: number,
  payload: Uint8Array,
): Uint8Array {
  if (!isSafeSequence(sequence)) {
    throw new Error('Invalid TTYA data sequence');
  }
  if (!(payload instanceof Uint8Array) || payload.length === 0) {
    throw new Error('Invalid TTYA data payload');
  }
  const prefix = encoder.encode(`${TTYA_AUTH_PROTOCOL}\0data\0${direction}\0`);
  const result = new Uint8Array(prefix.length + 8 + payload.length);
  result.set(prefix, 0);
  new DataView(
    result.buffer,
    result.byteOffset,
    result.byteLength,
  ).setBigUint64(prefix.length, BigInt(sequence), false);
  result.set(payload, prefix.length + 8);
  return result;
}

/**
 * Incremental length-prefixed frame parser. It accepts fragmented headers and
 * payloads, drains any number of coalesced frames, and rejects an oversized
 * length before allocating the advertised payload.
 */
export class TTYAFrameDecoder {
  private readonly header = new Uint8Array(4);
  private headerOffset = 0;
  private payload: Uint8Array | null = null;
  private payloadOffset = 0;

  push(chunk: Uint8Array): Uint8Array[] {
    if (!(chunk instanceof Uint8Array)) {
      throw new Error('TTYA frame chunk must be bytes');
    }

    const frames: Uint8Array[] = [];
    let offset = 0;
    while (offset < chunk.length) {
      if (this.payload === null) {
        const headerBytes = Math.min(
          4 - this.headerOffset,
          chunk.length - offset,
        );
        this.header.set(
          chunk.subarray(offset, offset + headerBytes),
          this.headerOffset,
        );
        this.headerOffset += headerBytes;
        offset += headerBytes;
        if (this.headerOffset < 4) continue;

        const length = new DataView(
          this.header.buffer,
          this.header.byteOffset,
          this.header.byteLength,
        ).getUint32(0, false);
        this.headerOffset = 0;
        if (length === 0 || length > MAX_TTYA_FRAME_SIZE) {
          this.reset();
          throw new Error(`Invalid TTYA frame length: ${length}`);
        }
        this.payload = new Uint8Array(length);
        this.payloadOffset = 0;
      }

      const payloadBytes = Math.min(
        this.payload.length - this.payloadOffset,
        chunk.length - offset,
      );
      this.payload.set(
        chunk.subarray(offset, offset + payloadBytes),
        this.payloadOffset,
      );
      this.payloadOffset += payloadBytes;
      offset += payloadBytes;

      if (this.payloadOffset === this.payload.length) {
        frames.push(this.payload);
        this.payload = null;
        this.payloadOffset = 0;
      }
    }
    return frames;
  }

  reset(): void {
    this.headerOffset = 0;
    this.payload = null;
    this.payloadOffset = 0;
  }
}
