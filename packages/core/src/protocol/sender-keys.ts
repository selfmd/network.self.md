import { randomBytes } from '@noble/hashes/utils';
import { encrypt, decrypt } from '../crypto/aead.js';
import { advanceChain } from '../crypto/kdf.js';
import type { SenderKeyDistributionMessage } from './types.js';
import { MessageType } from './types.js';

export interface SenderKeyState {
  chainKey: Uint8Array;
  chainIndex: number;
}

export interface SenderKeyRecord {
  chainKey: Uint8Array;
  chainIndex: number;
  skippedKeys: Map<number, Uint8Array>;
}

const MAX_SKIP = 256;

export const SenderKeys = {
  generate(): SenderKeyState {
    return {
      chainKey: randomBytes(32),
      chainIndex: 0,
    };
  },

  encrypt(
    state: SenderKeyState,
    plaintext: Uint8Array
  ): {
    ciphertext: Uint8Array;
    nonce: Uint8Array;
    chainIndex: number;
    nextState: SenderKeyState;
  } {
    const { messageKey, nextChainKey } = advanceChain(state.chainKey);
    const { ciphertext, nonce } = encrypt(messageKey, plaintext);
    return {
      ciphertext,
      nonce,
      chainIndex: state.chainIndex,
      nextState: {
        chainKey: nextChainKey,
        chainIndex: state.chainIndex + 1,
      },
    };
  },

  decrypt(
    record: SenderKeyRecord,
    chainIndex: number,
    nonce: Uint8Array,
    ciphertext: Uint8Array
  ): {
    plaintext: Uint8Array;
    nextRecord: SenderKeyRecord;
  } {
    // Check skipped keys first
    if (record.skippedKeys.has(chainIndex)) {
      const messageKey = record.skippedKeys.get(chainIndex)!;
      const plaintext = decrypt(messageKey, nonce, ciphertext);
      const newSkipped = new Map(record.skippedKeys);
      newSkipped.delete(chainIndex);
      return {
        plaintext,
        nextRecord: {
          chainKey: record.chainKey,
          chainIndex: record.chainIndex,
          skippedKeys: newSkipped,
        },
      };
    }

    if (chainIndex < record.chainIndex) {
      throw new Error(
        `Cannot decrypt: chain index ${chainIndex} already consumed and not in skipped keys`
      );
    }

    const skip = chainIndex - record.chainIndex;
    if (skip > MAX_SKIP) {
      throw new Error(
        `Too many skipped messages: ${skip} > ${MAX_SKIP}`
      );
    }

    // Advance chain, caching skipped keys
    let currentChainKey = record.chainKey;
    const newSkipped = new Map(record.skippedKeys);

    for (let i = record.chainIndex; i < chainIndex; i++) {
      const { messageKey, nextChainKey } = advanceChain(currentChainKey);
      newSkipped.set(i, messageKey);
      currentChainKey = nextChainKey;
    }

    // Derive message key for this index
    const { messageKey, nextChainKey } = advanceChain(currentChainKey);
    const plaintext = decrypt(messageKey, nonce, ciphertext);

    return {
      plaintext,
      nextRecord: {
        chainKey: nextChainKey,
        chainIndex: chainIndex + 1,
        skippedKeys: newSkipped,
      },
    };
  },

  createDistribution(
    groupId: Uint8Array,
    state: SenderKeyState,
    signingPublicKey: Uint8Array
  ): SenderKeyDistributionMessage {
    return {
      type: MessageType.SenderKeyDistribution,
      groupId,
      chainKey: state.chainKey,
      chainIndex: state.chainIndex,
      signingPublicKey,
      timestamp: Date.now(),
    };
  },
};
