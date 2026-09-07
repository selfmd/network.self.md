import { describe, expect, it } from 'vitest';
import { generateIdentity } from '../identity.js';
import { encodeMessage, decodeMessage, validateProtocolMessage } from '../protocol/messages.js';
import { MessageType, type DirectEncryptedMessage } from '../protocol/types.js';
import { signAuthenticatedMessage } from '../protocol/message-auth.js';
import {
  DELIVERY_TTL_MS, deliveryContentHash, signDelivery, verifyDelivery,
  type ReliableDeliveryMessage, type DeliveryReceiptMessage,
} from '../protocol/reliable-delivery.js';

function fixture() {
  const sender = generateIdentity();
  const recipient = generateIdentity();
  const timestamp = Date.now();
  const message = signAuthenticatedMessage<DirectEncryptedMessage>({
    type: MessageType.DirectMessage,
    senderFingerprint: sender.fingerprint, recipientFingerprint: recipient.fingerprint,
    ratchetPublicKey: new Uint8Array(32).fill(1), previousChainLength: 0, messageNumber: 0,
    nonce: new Uint8Array(24), ciphertext: new Uint8Array(16), timestamp,
  }, sender.edPrivateKey);
  const packet = signDelivery<ReliableDeliveryMessage>({
    type: MessageType.ReliableDelivery, id: 'stable-delivery-id',
    senderFingerprint: sender.fingerprint, recipientFingerprint: recipient.fingerprint,
    contentHash: deliveryContentHash('hello'), createdAt: timestamp,
    expiresAt: timestamp + DELIVERY_TTL_MS, timestamp, message,
  }, sender.edPrivateKey);
  return { sender, recipient, packet };
}

describe('reliable delivery wire authentication', () => {
  it('preserves signed delivery and receipt through CBOR encoding', () => {
    const { sender, recipient, packet } = fixture();
    const decoded = decodeMessage(encodeMessage(packet)) as ReliableDeliveryMessage;
    expect(verifyDelivery(decoded, sender.edPublicKey)).toBe(true);
    const receipt = signDelivery<DeliveryReceiptMessage>({
      type: MessageType.DeliveryReceipt, id: packet.id,
      senderFingerprint: recipient.fingerprint, recipientFingerprint: sender.fingerprint,
      timestamp: Date.now(),
    }, recipient.edPrivateKey);
    expect(verifyDelivery(decodeMessage(encodeMessage(receipt)) as DeliveryReceiptMessage, recipient.edPublicKey)).toBe(true);
    expect(verifyDelivery(receipt, sender.edPublicKey)).toBe(false);
    expect(verifyDelivery({ ...receipt, id: 'another-id' }, recipient.edPublicKey)).toBe(false);
    expect(verifyDelivery({ ...receipt, recipientFingerprint: recipient.fingerprint }, recipient.edPublicKey)).toBe(false);
  });

  it('binds every routing, lifetime, content and nested ciphertext field', () => {
    const { sender, recipient, packet } = fixture();
    const tampered: ReliableDeliveryMessage[] = [
      { ...packet, id: 'other' },
      { ...packet, senderFingerprint: recipient.fingerprint },
      { ...packet, recipientFingerprint: sender.fingerprint },
      { ...packet, contentHash: deliveryContentHash('different') },
      { ...packet, createdAt: packet.createdAt - 1 },
      { ...packet, expiresAt: packet.expiresAt + 1 },
      { ...packet, timestamp: packet.timestamp + 1 },
      { ...packet, message: { ...packet.message, ciphertext: new Uint8Array(16).fill(1) } },
      { ...packet, message: { ...packet.message, signature: new Uint8Array(64) } },
    ];
    for (const changed of tampered) expect(verifyDelivery(changed, sender.edPublicKey)).toBe(false);
    expect(deliveryContentHash('hello', new Uint8Array(32))).not.toBe(packet.contentHash);
  });

  it('rejects malformed IDs, coerced fingerprints, unknown fields and recursive envelopes', () => {
    const { packet } = fixture();
    for (const malformed of [
      { ...packet, id: '' }, { ...packet, id: 'x'.repeat(129) },
      { ...packet, senderFingerprint: [packet.senderFingerprint] },
      { ...packet, recipientFingerprint: [packet.recipientFingerprint] },
      { ...packet, createdAt: -1 }, { ...packet, contentHash: 'invalid' },
      { ...packet, signature: new Uint8Array(63) },
      { ...packet, unexpected: true }, { ...packet, message: packet },
    ]) expect(() => validateProtocolMessage(malformed)).toThrow();
  });
});
