import { describe, expect, it } from 'vitest';
import {
  TTYA_AUTH_VERSION,
  TTYAFrameDecoder,
  buildTTYAAuthProofPayload,
  copyAndValidateTTYAAuthSecret,
  isTTYAAuthChallengeFrame,
  isTTYAAuthConfirmationFrame,
  isTTYAAuthResponseFrame,
} from '../protocol/ttya-auth.js';

const agentNonce = '11'.repeat(32);
const bridgeNonce = '22'.repeat(32);
const proof = '33'.repeat(32);
const channelBinding = new Uint8Array(64).fill(0x44);

describe('TTYA mutual-auth wire contract', () => {
  it('accepts only fixed-size lowercase hexadecimal fields', () => {
    expect(
      isTTYAAuthChallengeFrame({
        type: 'ttya-auth-challenge',
        version: TTYA_AUTH_VERSION,
        agentNonce,
      }),
    ).toBe(true);
    expect(
      isTTYAAuthResponseFrame({
        type: 'ttya-auth-response',
        version: TTYA_AUTH_VERSION,
        agentNonce,
        bridgeNonce,
        proof,
      }),
    ).toBe(true);
    expect(
      isTTYAAuthConfirmationFrame({
        type: 'ttya-auth-confirmation',
        version: TTYA_AUTH_VERSION,
        agentNonce,
        bridgeNonce,
        proof,
      }),
    ).toBe(true);

    expect(
      isTTYAAuthChallengeFrame({
        type: 'ttya-auth-challenge',
        version: TTYA_AUTH_VERSION,
        agentNonce: 'AA'.repeat(32),
      }),
    ).toBe(false);
    expect(
      isTTYAAuthResponseFrame({
        type: 'ttya-auth-response',
        version: TTYA_AUTH_VERSION,
        agentNonce,
        bridgeNonce,
        proof: '33'.repeat(31),
      }),
    ).toBe(false);
  });

  it('domain-separates bridge and agent proofs over the full transcript', () => {
    const bridgePayload = buildTTYAAuthProofPayload(
      'bridge',
      agentNonce,
      bridgeNonce,
      channelBinding,
    );
    const agentPayload = buildTTYAAuthProofPayload(
      'agent',
      agentNonce,
      bridgeNonce,
      channelBinding,
    );
    const changedTranscript = buildTTYAAuthProofPayload(
      'bridge',
      '44'.repeat(32),
      bridgeNonce,
      channelBinding,
    );
    const changedConnection = buildTTYAAuthProofPayload(
      'bridge',
      agentNonce,
      bridgeNonce,
      new Uint8Array(64).fill(0x55),
    );

    expect(bridgePayload).not.toEqual(agentPayload);
    expect(bridgePayload).not.toEqual(changedTranscript);
    expect(bridgePayload).not.toEqual(changedConnection);
  });

  it('requires and defensively copies a 32-byte-or-longer PSK', () => {
    expect(() => copyAndValidateTTYAAuthSecret(new Uint8Array(31))).toThrow(
      /at least 32 random bytes/i,
    );
    const input = new Uint8Array(32).fill(7);
    const copy = copyAndValidateTTYAAuthSecret(input);
    input.fill(9);
    expect(copy).toEqual(new Uint8Array(32).fill(7));
  });

  it('parses fragmented and coalesced frames without buffering an oversize body', () => {
    const encode = (value: string) => {
      const payload = new TextEncoder().encode(value);
      const frame = new Uint8Array(4 + payload.length);
      new DataView(frame.buffer).setUint32(0, payload.length, false);
      frame.set(payload, 4);
      return frame;
    };
    const first = encode('one');
    const second = encode('two');
    const decoder = new TTYAFrameDecoder();

    expect(decoder.push(first.subarray(0, 2))).toEqual([]);
    expect(
      decoder.push(new Uint8Array([...first.subarray(2), ...second])),
    ).toEqual([
      new TextEncoder().encode('one'),
      new TextEncoder().encode('two'),
    ]);

    const oversized = new Uint8Array(4);
    new DataView(oversized.buffer).setUint32(0, 65_537, false);
    expect(() => decoder.push(oversized)).toThrow(/invalid ttya frame length/i);
  });
});
