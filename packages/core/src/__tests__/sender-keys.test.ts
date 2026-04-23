import { describe, it, expect } from 'vitest';
import { SenderKeys, type SenderKeyRecord } from '../protocol/sender-keys.js';

describe('SenderKeys', () => {
  it('generates initial state with random chain key and index 0', () => {
    const state = SenderKeys.generate();
    expect(state.chainKey).toBeInstanceOf(Uint8Array);
    expect(state.chainKey.length).toBe(32);
    expect(state.chainIndex).toBe(0);
  });

  it('encrypt/decrypt roundtrip', () => {
    const state = SenderKeys.generate();
    const plaintext = new TextEncoder().encode('group message');
    const { ciphertext, nonce, chainIndex, nextState } = SenderKeys.encrypt(state, plaintext);

    expect(chainIndex).toBe(0);
    expect(nextState.chainIndex).toBe(1);

    const record: SenderKeyRecord = {
      chainKey: state.chainKey,
      chainIndex: 0,
      skippedKeys: new Map(),
    };

    const { plaintext: decrypted } = SenderKeys.decrypt(record, chainIndex, nonce, ciphertext);
    expect(decrypted).toEqual(plaintext);
  });

  it('chain advances correctly across multiple messages', () => {
    let state = SenderKeys.generate();
    const record: SenderKeyRecord = {
      chainKey: state.chainKey,
      chainIndex: 0,
      skippedKeys: new Map(),
    };

    const messages: Array<{ ciphertext: Uint8Array; nonce: Uint8Array; chainIndex: number }> = [];

    for (let i = 0; i < 5; i++) {
      const plaintext = new TextEncoder().encode(`message ${i}`);
      const result = SenderKeys.encrypt(state, plaintext);
      messages.push(result);
      state = result.nextState;
      expect(result.chainIndex).toBe(i);
    }

    // Decrypt in order
    let currentRecord = record;
    for (let i = 0; i < 5; i++) {
      const { plaintext, nextRecord } = SenderKeys.decrypt(
        currentRecord,
        messages[i].chainIndex,
        messages[i].nonce,
        messages[i].ciphertext
      );
      expect(new TextDecoder().decode(plaintext)).toBe(`message ${i}`);
      currentRecord = nextRecord;
    }
  });

  it('handles out-of-order decryption', () => {
    let state = SenderKeys.generate();
    const record: SenderKeyRecord = {
      chainKey: state.chainKey,
      chainIndex: 0,
      skippedKeys: new Map(),
    };

    const messages: Array<{ ciphertext: Uint8Array; nonce: Uint8Array; chainIndex: number }> = [];

    for (let i = 0; i < 3; i++) {
      const plaintext = new TextEncoder().encode(`msg-${i}`);
      const result = SenderKeys.encrypt(state, plaintext);
      messages.push(result);
      state = result.nextState;
    }

    // Decrypt message 2 first (skipping 0 and 1)
    const { plaintext: p2, nextRecord: r1 } = SenderKeys.decrypt(
      record,
      messages[2].chainIndex,
      messages[2].nonce,
      messages[2].ciphertext
    );
    expect(new TextDecoder().decode(p2)).toBe('msg-2');
    expect(r1.skippedKeys.size).toBe(2); // keys 0 and 1 cached

    // Now decrypt message 0 from skipped
    const { plaintext: p0, nextRecord: r2 } = SenderKeys.decrypt(
      r1,
      messages[0].chainIndex,
      messages[0].nonce,
      messages[0].ciphertext
    );
    expect(new TextDecoder().decode(p0)).toBe('msg-0');
    expect(r2.skippedKeys.size).toBe(1); // key 1 still cached

    // Now decrypt message 1 from skipped
    const { plaintext: p1, nextRecord: r3 } = SenderKeys.decrypt(
      r2,
      messages[1].chainIndex,
      messages[1].nonce,
      messages[1].ciphertext
    );
    expect(new TextDecoder().decode(p1)).toBe('msg-1');
    expect(r3.skippedKeys.size).toBe(0);
  });

  it('throws on too many skipped messages (max 256)', () => {
    const state = SenderKeys.generate();
    const record: SenderKeyRecord = {
      chainKey: state.chainKey,
      chainIndex: 0,
      skippedKeys: new Map(),
    };

    // Try to skip 257 messages
    let advancedState = state;
    for (let i = 0; i < 257; i++) {
      const result = SenderKeys.encrypt(advancedState, new Uint8Array([0]));
      advancedState = result.nextState;
    }

    const { ciphertext, nonce, chainIndex } = SenderKeys.encrypt(
      advancedState,
      new TextEncoder().encode('too far')
    );

    expect(() =>
      SenderKeys.decrypt(record, chainIndex, nonce, ciphertext)
    ).toThrow(/too many skipped/i);
  });

  it('createDistribution produces valid message', () => {
    const state = SenderKeys.generate();
    const groupId = new Uint8Array(16);
    const signingKey = new Uint8Array(32);
    const dist = SenderKeys.createDistribution(groupId, state, signingKey);

    expect(dist.type).toBe(0x03);
    expect(dist.groupId).toBe(groupId);
    expect(dist.chainKey).toBe(state.chainKey);
    expect(dist.chainIndex).toBe(state.chainIndex);
    expect(dist.signingPublicKey).toBe(signingKey);
    expect(typeof dist.timestamp).toBe('number');
  });
});
