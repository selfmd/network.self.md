import { describe, expect, it } from 'vitest';
import {
  canonicalGroupEpochEnvelope,
  createGenesisEpoch,
  createSignedEpoch,
  generateIdentity,
  MessageType,
  serializeEpoch,
  signGroupEpochEnvelope,
  verifyGroupEpochEnvelope,
} from '../index.js';

describe('GroupEpoch delivery envelope', () => {
  it('uses a fresh signed envelope timestamp without changing the epoch', () => {
    const sender = generateIdentity();
    const recipient = generateIdentity();
    const epoch = createSignedEpoch(
      createGenesisEpoch('01'.repeat(32), sender.edPublicKey, 100),
      sender.edPrivateKey,
    );
    const base = {
      type: MessageType.GroupEpoch,
      protocolVersion: 2,
      groupId: new Uint8Array(32).fill(1),
      epochData: serializeEpoch(epoch.epoch),
      signature: epoch.signature,
      hash: epoch.hash,
      senderFingerprint: sender.fingerprint,
      recipientFingerprint: recipient.fingerprint,
    } as const;
    const first = signGroupEpochEnvelope(
      { ...base, timestamp: 1_000 },
      sender.edPrivateKey,
    );
    const catchup = signGroupEpochEnvelope(
      { ...base, timestamp: 2_000 },
      sender.edPrivateKey,
    );
    expect(first.epochData).toEqual(catchup.epochData);
    expect(first.hash).toEqual(catchup.hash);
    expect(first.signature).toEqual(catchup.signature);
    expect(first.envelopeSignature).not.toEqual(catchup.envelopeSignature);
    expect(verifyGroupEpochEnvelope(catchup, sender.edPublicKey)).toBe(true);
    expect(
      verifyGroupEpochEnvelope(
        { ...catchup, recipientFingerprint: sender.fingerprint },
        sender.edPublicKey,
      ),
    ).toBe(false);
  });

  it('matches the canonical envelope golden vector', () => {
    const payload = canonicalGroupEpochEnvelope({
      type: MessageType.GroupEpoch,
      protocolVersion: 2,
      groupId: new Uint8Array(32).fill(1),
      epochData: new Uint8Array([2, 3]),
      signature: new Uint8Array(64).fill(4),
      hash: new Uint8Array(32).fill(5),
      senderFingerprint: 'y'.repeat(32),
      recipientFingerprint: 'b'.repeat(32),
      timestamp: 6,
    });
    expect(Buffer.from(payload).toString('hex')).toBe(
      '6e6574776f726b2e73656c662e6d642f47726f757045706f6368456e76656c6f70652f7632000a000201010101010101010101010101010101010101010101010101010101010101010000000202030404040404040404040404040404040404040404040404040404040404040404040404040404040404040404040404040404040404040404040404040404040405050505050505050505050505050505050505050505050505050505050505050000002079797979797979797979797979797979797979797979797979797979797979790000002062626262626262626262626262626262626262626262626262626262626262620000000000000006',
    );
  });
});
