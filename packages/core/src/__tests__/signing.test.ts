import { describe, it, expect } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519';
import { randomBytes } from '@noble/hashes/utils';
import { signMessage, verifyMessageSignature } from '../protocol/signing.js';
import { MessageType } from '../protocol/types.js';
import type {
  GroupManagementMessage,
  GroupEncryptedMessage,
  SenderKeyDistributionMessage,
} from '../protocol/types.js';

function makeKeyPair() {
  const privateKey = randomBytes(32);
  const publicKey = ed25519.getPublicKey(privateKey);
  return { privateKey, publicKey };
}

describe('signMessage / verifyMessageSignature', () => {
  it('round-trips a GroupManagement kick signature', () => {
    const admin = makeKeyPair();
    const unsigned: Omit<GroupManagementMessage, 'signature'> = {
      type: MessageType.GroupManagement,
      action: 'kick',
      groupId: new Uint8Array(32).fill(7),
      targetFingerprint: 'target-fp',
      timestamp: 1700000000000,
      senderPublicKey: admin.publicKey,
    };
    const signed = signMessage<GroupManagementMessage>(unsigned, admin.privateKey);

    expect(signed.signature).toBeInstanceOf(Uint8Array);
    expect(signed.signature.length).toBeGreaterThan(0);
    expect(verifyMessageSignature(signed, admin.publicKey)).toBe(true);
  });

  it('rejects verification under a different public key', () => {
    const admin = makeKeyPair();
    const attacker = makeKeyPair();
    const unsigned: Omit<GroupManagementMessage, 'signature'> = {
      type: MessageType.GroupManagement,
      action: 'kick',
      groupId: new Uint8Array(32).fill(1),
      targetFingerprint: 'x',
      timestamp: 1700000000000,
      senderPublicKey: admin.publicKey,
    };
    const signed = signMessage<GroupManagementMessage>(unsigned, admin.privateKey);
    expect(verifyMessageSignature(signed, attacker.publicKey)).toBe(false);
  });

  it('rejects a message whose body was tampered after signing', () => {
    const admin = makeKeyPair();
    const signed = signMessage<GroupManagementMessage>(
      {
        type: MessageType.GroupManagement,
        action: 'kick',
        groupId: new Uint8Array(32).fill(9),
        targetFingerprint: 'victim',
        timestamp: 1700000000000,
        senderPublicKey: admin.publicKey,
      },
      admin.privateKey,
    );

    const tampered = { ...signed, targetFingerprint: 'someone-else' };
    expect(verifyMessageSignature(tampered, admin.publicKey)).toBe(false);
  });

  it('rejects a message with missing/empty signature', () => {
    const admin = makeKeyPair();
    const unsigned: GroupManagementMessage = {
      type: MessageType.GroupManagement,
      action: 'kick',
      groupId: new Uint8Array(32),
      targetFingerprint: 'x',
      timestamp: 1700000000000,
      senderPublicKey: admin.publicKey,
      signature: new Uint8Array(0),
    };
    expect(verifyMessageSignature(unsigned, admin.publicKey)).toBe(false);
  });

  it('round-trips a GroupEncryptedMessage signature', () => {
    const sender = makeKeyPair();
    const signed = signMessage<GroupEncryptedMessage>(
      {
        type: MessageType.GroupMessage,
        groupId: new Uint8Array(32).fill(2),
        senderFingerprint: 'sender-fp',
        senderPublicKey: sender.publicKey,
        chainIndex: 3,
        ciphertext: new Uint8Array([1, 2, 3, 4]),
        nonce: new Uint8Array(24).fill(0xaa),
        timestamp: 1700000000000,
      },
      sender.privateKey,
    );
    expect(verifyMessageSignature(signed, sender.publicKey)).toBe(true);
  });

  it('round-trips a SenderKeyDistribution signature', () => {
    const kp = makeKeyPair();
    const signed = signMessage<SenderKeyDistributionMessage>(
      {
        type: MessageType.SenderKeyDistribution,
        groupId: new Uint8Array(32).fill(5),
        chainKey: new Uint8Array(32).fill(0x11),
        chainIndex: 0,
        signingPublicKey: kp.publicKey,
        timestamp: 1700000000000,
      },
      kp.privateKey,
    );
    expect(verifyMessageSignature(signed, kp.publicKey)).toBe(true);
  });
});
