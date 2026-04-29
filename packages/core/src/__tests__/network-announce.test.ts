import { describe, it, expect } from 'vitest';
import { encodeMessage, decodeMessage, MessageType, sign, verify, generateIdentity } from '../index.js';
import type { NetworkAnnounceMessage } from '../index.js';
import { signAnnounce, verifyAnnounce } from '../protocol/announce-signature.js';

describe('NetworkAnnounce message', () => {
  it('encodes and decodes round-trip', () => {
    const msg: NetworkAnnounceMessage = {
      type: MessageType.NetworkAnnounce,
      groups: [{
        groupId: new Uint8Array([1, 2, 3]),
        name: 'builders',
        selfMd: 'We build network.self.md. Ship > discuss.',
        memberCount: 3,
      }],
      signature: new Uint8Array(64),
      timestamp: Date.now(),
    };
    const encoded = encodeMessage(msg);
    const decoded = decodeMessage(encoded) as NetworkAnnounceMessage;
    expect(decoded.type).toBe(MessageType.NetworkAnnounce);
    expect(decoded.groups).toHaveLength(1);
    expect(decoded.groups[0].name).toBe('builders');
    expect(decoded.groups[0].selfMd).toBe('We build network.self.md. Ship > discuss.');
  });

  it('handles empty groups list', () => {
    const msg: NetworkAnnounceMessage = {
      type: MessageType.NetworkAnnounce,
      groups: [],
      signature: new Uint8Array(64),
      timestamp: Date.now(),
    };
    const encoded = encodeMessage(msg);
    const decoded = decodeMessage(encoded) as NetworkAnnounceMessage;
    expect(decoded.groups).toHaveLength(0);
  });
});

describe('NetworkAnnounce signature', () => {
  it('signAnnounce produces a valid signature verified by verifyAnnounce', () => {
    const identity = generateIdentity('test-agent');
    const groups = [{
      groupId: new Uint8Array([1, 2, 3]),
      name: 'builders',
      selfMd: 'We build things.',
      memberCount: 2,
    }];
    const timestamp = Date.now();

    const signature = signAnnounce(groups, timestamp, identity.edPrivateKey);
    const valid = verifyAnnounce(groups, timestamp, signature, identity.edPublicKey);
    expect(valid).toBe(true);
  });

  it('rejects signature from a different key', () => {
    const identity1 = generateIdentity('agent-1');
    const identity2 = generateIdentity('agent-2');
    const groups = [{
      groupId: new Uint8Array([4, 5, 6]),
      name: 'research',
      selfMd: 'Papers only.',
      memberCount: 1,
    }];
    const timestamp = Date.now();

    const signature = signAnnounce(groups, timestamp, identity1.edPrivateKey);
    const valid = verifyAnnounce(groups, timestamp, signature, identity2.edPublicKey);
    expect(valid).toBe(false);
  });

  it('rejects signature when payload is tampered', () => {
    const identity = generateIdentity('test-agent');
    const groups = [{
      groupId: new Uint8Array([1, 2, 3]),
      name: 'builders',
      selfMd: 'Original.',
      memberCount: 2,
    }];
    const timestamp = Date.now();

    const signature = signAnnounce(groups, timestamp, identity.edPrivateKey);

    // Tamper with selfMd
    const tampered = [{
      groupId: new Uint8Array([1, 2, 3]),
      name: 'builders',
      selfMd: 'Hijacked!',
      memberCount: 2,
    }];
    const valid = verifyAnnounce(tampered, timestamp, signature, identity.edPublicKey);
    expect(valid).toBe(false);
  });
});
