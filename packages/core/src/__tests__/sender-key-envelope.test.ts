import { describe, expect, it } from 'vitest';
import {
  MessageType,
  senderKeyEnvelopeId,
  SENDER_KEY_ENVELOPE_VERSION,
} from '../index.js';

describe('sender-key encrypted envelope replay identity', () => {
  const envelope = {
    type: MessageType.SenderKeyDistribution,
    protocolVersion: SENDER_KEY_ENVELOPE_VERSION,
    recipientPublicKey: new Uint8Array(32).fill(1),
    ciphertext: new Uint8Array(16).fill(2),
    nonce: new Uint8Array(24).fill(3),
    timestamp: 4,
  } as const;

  it('binds recipient, nonce, ciphertext, timestamp, domain, and version', () => {
    const id = senderKeyEnvelopeId(envelope);
    expect(id).toHaveLength(32);
    expect(senderKeyEnvelopeId({ ...envelope })).toEqual(id);
    expect(
      senderKeyEnvelopeId({
        ...envelope,
        recipientPublicKey: new Uint8Array(32).fill(4),
      }),
    ).not.toEqual(id);
    expect(senderKeyEnvelopeId({ ...envelope, timestamp: 5 })).not.toEqual(id);
  });

  it('matches the replay-id golden vector', () => {
    expect(Buffer.from(senderKeyEnvelopeId(envelope)).toString('hex')).toBe(
      '628c1198459e45ee88f57a5cc5d31b058dada6ebe9613a5523256fce0d25fb47',
    );
  });
});
