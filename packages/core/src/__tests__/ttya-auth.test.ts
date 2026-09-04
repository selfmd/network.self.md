import { describe, expect, it } from 'vitest';
import {
  TTYA_AUTH_VERSION,
  buildTTYAAuthProofPayload,
  isTTYAAuthChallengeFrame,
  isTTYAAuthConfirmationFrame,
  isTTYAAuthResponseFrame,
} from '../protocol/ttya-auth.js';

const agentNonce = '11'.repeat(32);
const bridgeNonce = '22'.repeat(32);
const proof = '33'.repeat(32);

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
    );
    const agentPayload = buildTTYAAuthProofPayload(
      'agent',
      agentNonce,
      bridgeNonce,
    );
    const changedTranscript = buildTTYAAuthProofPayload(
      'bridge',
      '44'.repeat(32),
      bridgeNonce,
    );

    expect(bridgePayload).not.toEqual(agentPayload);
    expect(bridgePayload).not.toEqual(changedTranscript);
  });
});
