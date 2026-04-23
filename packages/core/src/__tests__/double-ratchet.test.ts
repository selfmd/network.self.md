import { describe, it, expect } from 'vitest';
import { DoubleRatchet } from '../protocol/double-ratchet.js';
import { x25519 } from '@noble/curves/ed25519';
import { randomBytes } from '@noble/hashes/utils';

describe('DoubleRatchet', () => {
  function setupSession() {
    const sharedSecret = randomBytes(32);
    const bobRatchetPrivate = randomBytes(32);
    const bobRatchetPublic = x25519.getPublicKey(bobRatchetPrivate);

    const aliceState = DoubleRatchet.initSender(sharedSecret, bobRatchetPublic);
    const bobState = DoubleRatchet.initReceiver(sharedSecret, {
      privateKey: bobRatchetPrivate,
      publicKey: bobRatchetPublic,
    });

    return { aliceState, bobState };
  }

  it('initializes sender and receiver states', () => {
    const { aliceState, bobState } = setupSession();

    expect(aliceState.sendChainKey).not.toBeNull();
    expect(aliceState.receiveRatchetPublic).not.toBeNull();
    expect(aliceState.sendMessageNumber).toBe(0);

    expect(bobState.sendChainKey).toBeNull();
    expect(bobState.receiveChainKey).toBeNull();
    expect(bobState.receiveRatchetPublic).toBeNull();
  });

  it('encrypts and decrypts a single message (Alice → Bob)', () => {
    const { aliceState, bobState } = setupSession();
    const plaintext = new TextEncoder().encode('Hello Bob!');

    const {
      ciphertext,
      nonce,
      ratchetPublicKey,
      previousChainLength,
      messageNumber,
      nextState: aliceNext,
    } = DoubleRatchet.encrypt(aliceState, plaintext);

    expect(messageNumber).toBe(0);
    expect(aliceNext.sendMessageNumber).toBe(1);

    const { plaintext: decrypted, nextState: bobNext } = DoubleRatchet.decrypt(
      bobState,
      ratchetPublicKey,
      previousChainLength,
      messageNumber,
      nonce,
      ciphertext
    );

    expect(decrypted).toEqual(plaintext);
    expect(bobNext.receiveMessageNumber).toBe(1);
  });

  it('handles multiple messages in one direction', () => {
    let { aliceState, bobState } = setupSession();

    const messages: Array<{
      ciphertext: Uint8Array;
      nonce: Uint8Array;
      ratchetPublicKey: Uint8Array;
      previousChainLength: number;
      messageNumber: number;
    }> = [];

    for (let i = 0; i < 5; i++) {
      const plaintext = new TextEncoder().encode(`msg-${i}`);
      const result = DoubleRatchet.encrypt(aliceState, plaintext);
      messages.push(result);
      aliceState = result.nextState;
    }

    // Decrypt all in order
    let bobCurrent = bobState;
    for (let i = 0; i < 5; i++) {
      const { plaintext, nextState } = DoubleRatchet.decrypt(
        bobCurrent,
        messages[i].ratchetPublicKey,
        messages[i].previousChainLength,
        messages[i].messageNumber,
        messages[i].nonce,
        messages[i].ciphertext
      );
      expect(new TextDecoder().decode(plaintext)).toBe(`msg-${i}`);
      bobCurrent = nextState;
    }
  });

  it('handles bidirectional communication with ratchet steps', () => {
    let { aliceState, bobState } = setupSession();

    // Alice sends to Bob
    const plaintext1 = new TextEncoder().encode('Alice to Bob');
    const enc1 = DoubleRatchet.encrypt(aliceState, plaintext1);
    aliceState = enc1.nextState;

    const dec1 = DoubleRatchet.decrypt(
      bobState,
      enc1.ratchetPublicKey,
      enc1.previousChainLength,
      enc1.messageNumber,
      enc1.nonce,
      enc1.ciphertext
    );
    bobState = dec1.nextState;
    expect(dec1.plaintext).toEqual(plaintext1);

    // Bob replies to Alice (triggers DH ratchet)
    const plaintext2 = new TextEncoder().encode('Bob to Alice');
    const enc2 = DoubleRatchet.encrypt(bobState, plaintext2);
    bobState = enc2.nextState;

    const dec2 = DoubleRatchet.decrypt(
      aliceState,
      enc2.ratchetPublicKey,
      enc2.previousChainLength,
      enc2.messageNumber,
      enc2.nonce,
      enc2.ciphertext
    );
    aliceState = dec2.nextState;
    expect(dec2.plaintext).toEqual(plaintext2);

    // Alice sends again (another ratchet)
    const plaintext3 = new TextEncoder().encode('Alice again');
    const enc3 = DoubleRatchet.encrypt(aliceState, plaintext3);
    aliceState = enc3.nextState;

    const dec3 = DoubleRatchet.decrypt(
      bobState,
      enc3.ratchetPublicKey,
      enc3.previousChainLength,
      enc3.messageNumber,
      enc3.nonce,
      enc3.ciphertext
    );
    bobState = dec3.nextState;
    expect(dec3.plaintext).toEqual(plaintext3);
  });

  it('handles out-of-order messages', () => {
    let { aliceState, bobState } = setupSession();

    // Alice sends 3 messages
    const msgs: Array<{
      ciphertext: Uint8Array;
      nonce: Uint8Array;
      ratchetPublicKey: Uint8Array;
      previousChainLength: number;
      messageNumber: number;
    }> = [];

    for (let i = 0; i < 3; i++) {
      const result = DoubleRatchet.encrypt(
        aliceState,
        new TextEncoder().encode(`msg-${i}`)
      );
      msgs.push(result);
      aliceState = result.nextState;
    }

    // Bob receives msg 2 first (skipping 0 and 1)
    const { plaintext: p2, nextState: s1 } = DoubleRatchet.decrypt(
      bobState,
      msgs[2].ratchetPublicKey,
      msgs[2].previousChainLength,
      msgs[2].messageNumber,
      msgs[2].nonce,
      msgs[2].ciphertext
    );
    expect(new TextDecoder().decode(p2)).toBe('msg-2');

    // Bob receives msg 0 (from skipped keys)
    const { plaintext: p0, nextState: s2 } = DoubleRatchet.decrypt(
      s1,
      msgs[0].ratchetPublicKey,
      msgs[0].previousChainLength,
      msgs[0].messageNumber,
      msgs[0].nonce,
      msgs[0].ciphertext
    );
    expect(new TextDecoder().decode(p0)).toBe('msg-0');

    // Bob receives msg 1 (from skipped keys)
    const { plaintext: p1 } = DoubleRatchet.decrypt(
      s2,
      msgs[1].ratchetPublicKey,
      msgs[1].previousChainLength,
      msgs[1].messageNumber,
      msgs[1].nonce,
      msgs[1].ciphertext
    );
    expect(new TextDecoder().decode(p1)).toBe('msg-1');
  });
});
