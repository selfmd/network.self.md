import { describe, it, expect } from 'vitest';
import type { PrivateInboundMessageEvent } from '@networkselfmd/node';
import { toInboundEventDTO } from '../tools/messaging.js';

const base: PrivateInboundMessageEvent = {
  kind: 'group',
  messageId: 'm1',
  groupId: new Uint8Array([0xde, 0xad]),
  senderPublicKey: new Uint8Array([0xbe, 0xef, 0x01]),
  senderFingerprint: 'fp1',
  plaintext: new TextEncoder().encode('hi'),
  timestamp: 10,
  receivedAt: 20,
};

describe('toInboundEventDTO', () => {
  it('hex-encodes groupId and senderPublicKey; always sets plaintextBase64', () => {
    const dto = toInboundEventDTO(base);
    expect(dto.groupIdHex).toBe('dead');
    expect(dto.senderPublicKeyHex).toBe('beef01');
    expect(dto.plaintextBase64).toBe(Buffer.from('hi').toString('base64'));
  });

  it('sets plaintextUtf8 only for valid UTF-8', () => {
    expect(toInboundEventDTO(base).plaintextUtf8).toBe('hi');

    const bad = toInboundEventDTO({
      ...base,
      plaintext: new Uint8Array([0xc3, 0x28]), // invalid UTF-8
    });
    expect(bad.plaintextUtf8).toBeUndefined();
    expect(bad.plaintextBase64).toBe(Buffer.from([0xc3, 0x28]).toString('base64'));
  });

  it('omits groupIdHex when no groupId is present', () => {
    const dto = toInboundEventDTO({ ...base, groupId: undefined, kind: 'dm' });
    expect(dto.groupIdHex).toBeUndefined();
    expect(dto.kind).toBe('dm');
  });

  it('JSON.stringify does not leak numeric-keyed byte objects', () => {
    const dto = toInboundEventDTO(base);
    const serialized = JSON.stringify(dto);
    expect(serialized).not.toMatch(/"0":\s*\d+,\s*"1":\s*\d+/);
    expect(serialized).toContain('beef01');
    expect(serialized).toContain('dead');
    // plaintext bytes must not appear as raw numeric arrays either.
    expect(serialized).not.toContain('"plaintext":');
  });
});
