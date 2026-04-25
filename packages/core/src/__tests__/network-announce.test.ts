import { describe, it, expect } from 'vitest';
import { encodeMessage, decodeMessage, MessageType } from '../protocol/index.js';
import type { NetworkAnnounceMessage } from '../protocol/index.js';

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
      timestamp: Date.now(),
    };
    const encoded = encodeMessage(msg);
    const decoded = decodeMessage(encoded) as NetworkAnnounceMessage;
    expect(decoded.groups).toHaveLength(0);
  });
});
