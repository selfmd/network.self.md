export const TTYA_AUTH_PROTOCOL = 'networkselfmd-ttya-auth-v2' as const;
export const TTYA_AUTH_VERSION = 2 as const;
export const TTYA_AUTH_NONCE_BYTES = 32;
export const TTYA_AUTH_PROOF_BYTES = 32;
export const MAX_TTYA_FRAME_SIZE = 65_536;

export type TTYAAuthRole = 'bridge' | 'agent';

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

export type TTYAAuthFrame =
  | TTYAAuthChallengeFrame
  | TTYAAuthResponseFrame
  | TTYAAuthConfirmationFrame;

const HEX_BYTE_PATTERN = /^[0-9a-f]{2}$/;

function isHexBytes(value: unknown, byteLength: number): value is string {
  if (typeof value !== 'string' || value.length !== byteLength * 2) {
    return false;
  }

  for (let offset = 0; offset < value.length; offset += 2) {
    if (!HEX_BYTE_PATTERN.test(value.slice(offset, offset + 2))) {
      return false;
    }
  }

  return true;
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

function hexToBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Canonical proof input for the mutual TTYA handshake.
 *
 * Both proofs cover both fresh nonces. The role byte-string provides domain
 * separation, so a bridge proof obtained from a chosen challenge cannot be
 * replayed as an agent proof.
 */
export function buildTTYAAuthProofPayload(
  role: TTYAAuthRole,
  agentNonce: string,
  bridgeNonce: string,
): Uint8Array {
  if (
    !isHexBytes(agentNonce, TTYA_AUTH_NONCE_BYTES) ||
    !isHexBytes(bridgeNonce, TTYA_AUTH_NONCE_BYTES)
  ) {
    throw new Error('Invalid TTYA authentication nonce');
  }

  const prefix = new TextEncoder().encode(`${TTYA_AUTH_PROTOCOL}\0${role}\0`);
  const payload = new Uint8Array(
    prefix.length + TTYA_AUTH_NONCE_BYTES * 2,
  );
  payload.set(prefix, 0);
  payload.set(hexToBytes(agentNonce), prefix.length);
  payload.set(
    hexToBytes(bridgeNonce),
    prefix.length + TTYA_AUTH_NONCE_BYTES,
  );
  return payload;
}
