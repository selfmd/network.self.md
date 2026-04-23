import { describe, it, expect } from 'vitest';
import {
  encodeMessage,
  decodeMessage,
  frameMessage,
  parseFrame,
  MAX_FRAME_SIZE,
} from '../protocol/messages.js';
import { MessageType, type ProtocolMessage } from '../protocol/types.js';

describe('messages (CBOR encoding)', () => {
  const sampleAck: ProtocolMessage = {
    type: MessageType.Ack,
    messageId: 'test-id-123',
    timestamp: 1700000000000,
  };

  const sampleHandshake: ProtocolMessage = {
    type: MessageType.IdentityHandshake,
    edPublicKey: new Uint8Array(32).fill(1),
    noisePublicKey: new Uint8Array(32).fill(2),
    signature: new Uint8Array(64).fill(3),
    displayName: 'agent-1',
    protocolVersion: 1,
    timestamp: 1700000000000,
  };

  it('encodes and decodes Ack message roundtrip', () => {
    const encoded = encodeMessage(sampleAck);
    expect(encoded).toBeInstanceOf(Uint8Array);
    const decoded = decodeMessage(encoded);
    expect(decoded.type).toBe(MessageType.Ack);
    expect((decoded as typeof sampleAck).messageId).toBe('test-id-123');
  });

  it('encodes and decodes IdentityHandshake roundtrip', () => {
    const encoded = encodeMessage(sampleHandshake);
    const decoded = decodeMessage(encoded);
    expect(decoded.type).toBe(MessageType.IdentityHandshake);
    const msg = decoded as typeof sampleHandshake;
    expect(msg.edPublicKey).toEqual(new Uint8Array(32).fill(1));
    expect(msg.displayName).toBe('agent-1');
    expect(msg.protocolVersion).toBe(1);
  });

  it('decodeMessage throws on invalid type', () => {
    const bad = encodeMessage({ ...sampleAck, type: 0xfe as any });
    expect(() => decodeMessage(bad)).toThrow(/invalid message type/i);
  });

  it('decodeMessage throws on missing type', () => {
    // Manually encode an object without type
    const { Encoder } = require('cbor-x');
    const enc = new Encoder({ useRecords: false });
    const bytes = enc.encode({ foo: 'bar' });
    expect(() => decodeMessage(bytes)).toThrow(/missing type/i);
  });
});

describe('framing', () => {
  const sampleMsg: ProtocolMessage = {
    type: MessageType.Ack,
    messageId: 'frame-test',
    timestamp: 1700000000000,
  };

  it('frames and parses a message roundtrip', () => {
    const frame = frameMessage(sampleMsg);
    expect(frame).toBeInstanceOf(Uint8Array);
    expect(frame.length).toBeGreaterThan(4);

    const result = parseFrame(frame);
    expect(result).not.toBeNull();
    expect(result!.message.type).toBe(MessageType.Ack);
    expect((result!.message as any).messageId).toBe('frame-test');
    expect(result!.bytesConsumed).toBe(frame.length);
  });

  it('returns null for incomplete frame (too short header)', () => {
    const result = parseFrame(new Uint8Array(3));
    expect(result).toBeNull();
  });

  it('returns null for incomplete frame (partial payload)', () => {
    const frame = frameMessage(sampleMsg);
    const partial = frame.slice(0, frame.length - 1);
    const result = parseFrame(partial);
    expect(result).toBeNull();
  });

  it('rejects frames exceeding MAX_FRAME_SIZE', () => {
    // Create a buffer with length prefix > MAX_FRAME_SIZE
    const buf = new Uint8Array(8);
    const view = new DataView(buf.buffer);
    view.setUint32(0, MAX_FRAME_SIZE + 1, false);
    expect(() => parseFrame(buf)).toThrow(/max_frame_size/i);
  });

  it('frameMessage rejects oversized messages', () => {
    // Create a message that encodes to > MAX_FRAME_SIZE
    const bigMsg: ProtocolMessage = {
      type: MessageType.Ack,
      messageId: 'x'.repeat(MAX_FRAME_SIZE),
      timestamp: 0,
    };
    expect(() => frameMessage(bigMsg)).toThrow(/max_frame_size/i);
  });
});
