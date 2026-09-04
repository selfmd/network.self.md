import { randomBytes } from '@noble/hashes/utils';
import { x25519 } from '@noble/curves/ed25519';
import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { Decoder, Encoder } from 'cbor-x';
import { encrypt, decrypt } from '../crypto/aead.js';
import { advanceChain, deriveKey } from '../crypto/kdf.js';
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

/** Plaintext carried inside a recipient-specific sender-key envelope. */
export interface SenderKeyDistributionPayload {
  groupId: Uint8Array;
  chainKey: Uint8Array;
  chainIndex: number;
  signingPublicKey: Uint8Array;
  epochVersion: number;
  epochHash: Uint8Array;
  timestamp: number;
}

const MAX_SKIP = 256;
const DISTRIBUTION_KEY_DOMAIN = new TextEncoder().encode(
  'networkselfmd-sender-key-distribution-key-v1',
);
const DISTRIBUTION_AAD_DOMAIN = new TextEncoder().encode(
  'networkselfmd-sender-key-distribution-aad-v1',
);
const encoder = new Encoder({ useRecords: false });
const decoder = new Decoder({ mapsAsObjects: true, useRecords: false });

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
    signingPublicKey: Uint8Array,
    epochVersion = 0,
    epochHash: Uint8Array = new Uint8Array(32),
  ): SenderKeyDistributionPayload {
    return {
      groupId,
      chainKey: state.chainKey,
      chainIndex: state.chainIndex,
      signingPublicKey,
      epochVersion,
      epochHash,
      timestamp: Date.now(),
    };
  },

  encryptDistribution(
    payload: SenderKeyDistributionPayload,
    senderXPrivateKey: Uint8Array,
    senderPublicKey: Uint8Array,
    recipientXPublicKey: Uint8Array,
    recipientPublicKey: Uint8Array,
  ): SenderKeyDistributionMessage {
    assertDistributionPayload(payload);
    assertLength(senderXPrivateKey, 32, 'sender X25519 private key');
    assertLength(senderPublicKey, 32, 'sender public key');
    assertLength(recipientXPublicKey, 32, 'recipient X25519 public key');
    assertLength(recipientPublicKey, 32, 'recipient public key');

    if (!bytesEqual(payload.signingPublicKey, senderPublicKey)) {
      throw new Error('Sender-key signing public key does not match sender identity');
    }

    const context = distributionContext(
      senderPublicKey,
      recipientPublicKey,
      payload.timestamp,
    );
    const sharedSecret = x25519.getSharedSecret(
      senderXPrivateKey,
      recipientXPublicKey,
    );
    const key = deriveKey(
      sharedSecret,
      DISTRIBUTION_KEY_DOMAIN,
      context,
      32,
    );
    const nonce = randomBytes(24);
    const aad = concatBytes(DISTRIBUTION_AAD_DOMAIN, context);
    const cipher = xchacha20poly1305(key, nonce, aad);

    return {
      type: MessageType.SenderKeyDistribution,
      recipientPublicKey,
      ciphertext: cipher.encrypt(encoder.encode(payload)),
      nonce,
      timestamp: payload.timestamp,
    };
  },

  decryptDistribution(
    message: SenderKeyDistributionMessage,
    recipientXPrivateKey: Uint8Array,
    recipientPublicKey: Uint8Array,
    authenticatedSenderXPublicKey: Uint8Array,
    authenticatedSenderPublicKey: Uint8Array,
  ): SenderKeyDistributionPayload {
    assertLength(message.recipientPublicKey, 32, 'recipient public key');
    assertLength(message.nonce, 24, 'sender-key distribution nonce');
    assertLength(recipientXPrivateKey, 32, 'recipient X25519 private key');
    assertLength(recipientPublicKey, 32, 'recipient public key');
    assertLength(authenticatedSenderXPublicKey, 32, 'sender X25519 public key');
    assertLength(authenticatedSenderPublicKey, 32, 'sender public key');
    if (!Number.isSafeInteger(message.timestamp) || message.timestamp < 0) {
      throw new Error('Invalid sender-key distribution timestamp');
    }
    if (!bytesEqual(message.recipientPublicKey, recipientPublicKey)) {
      throw new Error('Sender-key distribution is intended for another recipient');
    }

    const context = distributionContext(
      authenticatedSenderPublicKey,
      recipientPublicKey,
      message.timestamp,
    );
    const sharedSecret = x25519.getSharedSecret(
      recipientXPrivateKey,
      authenticatedSenderXPublicKey,
    );
    const key = deriveKey(
      sharedSecret,
      DISTRIBUTION_KEY_DOMAIN,
      context,
      32,
    );
    const aad = concatBytes(DISTRIBUTION_AAD_DOMAIN, context);
    const cipher = xchacha20poly1305(key, message.nonce, aad);
    const decoded = decoder.decode(cipher.decrypt(message.ciphertext));
    assertDistributionPayload(decoded);

    if (decoded.timestamp !== message.timestamp) {
      throw new Error('Sender-key distribution timestamp mismatch');
    }
    if (!bytesEqual(decoded.signingPublicKey, authenticatedSenderPublicKey)) {
      throw new Error(
        'Sender-key signing public key does not match authenticated session',
      );
    }

    return decoded;
  },
};

function distributionContext(
  senderPublicKey: Uint8Array,
  recipientPublicKey: Uint8Array,
  timestamp: number,
): Uint8Array {
  const timestampBytes = new Uint8Array(8);
  new DataView(timestampBytes.buffer).setBigUint64(0, BigInt(timestamp), false);
  return concatBytes(
    new Uint8Array([MessageType.SenderKeyDistribution]),
    senderPublicKey,
    recipientPublicKey,
    timestampBytes,
  );
}

function assertDistributionPayload(
  value: unknown,
): asserts value is SenderKeyDistributionPayload {
  if (!value || typeof value !== 'object') {
    throw new Error('Invalid sender-key distribution payload');
  }
  const payload = value as Partial<SenderKeyDistributionPayload>;
  assertLength(payload.groupId, 32, 'group id');
  assertLength(payload.chainKey, 32, 'sender chain key');
  assertLength(payload.signingPublicKey, 32, 'signing public key');
  assertLength(payload.epochHash, 32, 'group epoch hash');
  if (!Number.isSafeInteger(payload.chainIndex) || payload.chainIndex! < 0) {
    throw new Error('Invalid sender chain index');
  }
  if (!Number.isSafeInteger(payload.epochVersion) || payload.epochVersion! < 0) {
    throw new Error('Invalid group epoch version');
  }
  if (!Number.isSafeInteger(payload.timestamp) || payload.timestamp! < 0) {
    throw new Error('Invalid sender-key distribution timestamp');
  }
}

function assertLength(
  value: unknown,
  length: number,
  label: string,
): asserts value is Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw new Error(`Invalid ${label}`);
  }
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    parts.reduce((length, part) => length + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index++) {
    difference |= a[index] ^ b[index];
  }
  return difference === 0;
}
