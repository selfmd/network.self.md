# @networkselfmd/core

Pure cryptographic primitives and protocol definitions for agent-to-agent encryption. No I/O, no networking, no storage—just pure functions.

**Transport-agnostic crypto library** that powers secure group messaging (Sender Keys) and direct communication (Double Ratchet) in the networkselfmd ecosystem.

## What's Inside

| Module | Purpose |
|--------|---------|
| **Identity** | Ed25519 keypairs, X25519 key derivation, fingerprinting |
| **AEAD** | XChaCha20-Poly1305 authenticated encryption |
| **KDF** | HKDF-SHA256 key derivation and chain advancement |
| **Signatures** | Ed25519 signing and verification |
| **Sender Keys** | Signal Protocol–style symmetric ratchet for group messages |
| **Double Ratchet** | Asynchronous DH ratchet + symmetric chains for 1-to-1 messages |
| **Messages** | CBOR encoding/framing, type definitions |

All crypto uses **audited libraries** ([Noble curves/hashes/ciphers](https://github.com/paulmillr/noble-crypto)). Zero custom cryptography.

## Installation

```bash
npm install @networkselfmd/core
```

or via pnpm:

```bash
pnpm add @networkselfmd/core
```

## Quick Start

### Identity

Generate an agent identity (Ed25519 keypair + X25519 derive):

```typescript
import { generateIdentity, fingerprintFromPublicKey } from '@networkselfmd/core';

const identity = generateIdentity('Alice');
console.log(identity.fingerprint); // "z-base-32 encoded, human readable"
// identity.edPublicKey (for signing)
// identity.edPrivateKey (keep safe!)
// identity.xPublicKey (for DH key exchange)
// identity.xPrivateKey (keep safe!)
```

### AEAD Encryption

Encrypt and decrypt with XChaCha20-Poly1305:

```typescript
import { encrypt, decrypt } from '@networkselfmd/core/crypto';

const key = new Uint8Array(32); // 256-bit key
const plaintext = new TextEncoder().encode('secret message');

const { ciphertext, nonce } = encrypt(key, plaintext);
const decrypted = decrypt(key, nonce, ciphertext);
console.log(new TextDecoder().decode(decrypted)); // "secret message"
```

### Key Derivation

Derive keys with HKDF-SHA256:

```typescript
import { deriveKey, advanceChain } from '@networkselfmd/core/crypto';

// Derive a key from input keying material
const derivedKey = deriveKey(
  inputKey,
  'optional-salt',
  'info-string',
  32 // length in bytes
);

// Advance a chain (for ratcheting)
const { messageKey, nextChainKey } = advanceChain(chainKey);
```

### Signatures

Sign and verify messages:

```typescript
import { sign, verify } from '@networkselfmd/core/crypto';

const message = new TextEncoder().encode('message');
const signature = sign(message, privateKey);

const isValid = verify(signature, message, publicKey);
console.log(isValid); // true
```

### Sender Keys (Group Messages)

Encrypt and decrypt group messages using symmetric ratcheting:

```typescript
import { SenderKeys } from '@networkselfmd/core/protocol';

// Sender: generate initial state and encrypt
const senderState = SenderKeys.generate();
const { ciphertext, nonce, chainIndex, nextState } = SenderKeys.encrypt(
  senderState,
  plaintext
);

// Update sender state after each encryption
let state = nextState;

// Receiver: create a record from sender's distribution message
const record: SenderKeyRecord = {
  chainKey: distributionMessage.chainKey,
  chainIndex: distributionMessage.chainIndex,
  skippedKeys: new Map(),
};

// Decrypt a message
const { plaintext: decrypted, nextRecord } = SenderKeys.decrypt(
  record,
  chainIndex,
  nonce,
  ciphertext
);
```

**Features:**
- One symmetric encryption per message (efficient for groups)
- Out-of-order delivery support via skipped key cache
- Per-sender ratchet chains
- Max skip limit (256) to prevent abuse

### Double Ratchet (Direct Messages)

Asymmetric DH ratchet for forward secrecy and break-in recovery:

```typescript
import { DoubleRatchet } from '@networkselfmd/core/protocol';

// Sender side
const sharedSecret = deriveKey(/* ... */);
const recipientRatchetPublic = /* ... */;
const senderState = DoubleRatchet.initSender(sharedSecret, recipientRatchetPublic);

const {
  ciphertext,
  nonce,
  ratchetPublicKey,
  previousChainLength,
  messageNumber,
  nextState,
} = DoubleRatchet.encrypt(senderState, plaintext);

// Send: ciphertext, nonce, ratchetPublicKey, previousChainLength, messageNumber

// Receiver side
const receiverState = DoubleRatchet.initReceiver(sharedSecret, ownRatchetKeyPair);

const { plaintext: decrypted, nextState: newReceiverState } =
  DoubleRatchet.decrypt(
    receiverState,
    receivedRatchetPublicKey,
    previousChainLength,
    messageNumber,
    nonce,
    ciphertext
  );
```

**Features:**
- X25519 key ratchet on every message (optional sender-side, mandatory receiver-side)
- Symmetric HKDF chains for message derivation
- Forward secrecy: compromising current keys doesn't expose past messages
- Break-in recovery: ratchet step derives new root key
- Skipped key cache for out-of-order delivery (max 256)

### Message Encoding

CBOR-encode and frame messages for network transmission:

```typescript
import { encodeMessage, frameMessage, parseFrame } from '@networkselfmd/core/protocol';

const message: GroupEncryptedMessage = {
  type: MessageType.GroupMessage,
  groupId: new Uint8Array(32),
  senderFingerprint: 'abc123...',
  chainIndex: 5,
  ciphertext: new Uint8Array(100),
  nonce: new Uint8Array(24),
  timestamp: Date.now(),
};

// Encode to CBOR bytes
const encoded = encodeMessage(message);

// Frame with 4-byte length prefix (for streaming)
const frame = frameMessage(message);

// Parse frame from a buffer
const result = parseFrame(buffer);
if (result) {
  const { message, bytesConsumed } = result;
  console.log(message.type); // MessageType.GroupMessage
  buffer = buffer.slice(bytesConsumed); // advance buffer
}
```

**Framing:**
- 4-byte big-endian uint32 length prefix
- CBOR-encoded payload
- Max frame size: 1 MiB
- Incomplete frames return `null` (buffer more data)

## API Reference

### Identity Module

- `generateIdentity(displayName?: string): AgentIdentity` — Generate Ed25519 + X25519 keypair
- `fingerprintFromPublicKey(edPublicKey: Uint8Array): string` — Derive z-base-32 fingerprint
- `zBase32Encode(data: Uint8Array): string` — Encode bytes as z-base-32

### Crypto Module

**AEAD:**
- `encrypt(key, plaintext): { ciphertext, nonce }` — XChaCha20-Poly1305
- `decrypt(key, nonce, ciphertext): Uint8Array` — Decrypt

**KDF:**
- `deriveKey(ikm, salt, info, length): Uint8Array` — HKDF-SHA256
- `advanceChain(chainKey): { messageKey, nextChainKey }` — Ratchet chain

**Signatures:**
- `sign(message, privateKey): Uint8Array` — Ed25519 sign
- `verify(signature, message, publicKey): boolean` — Ed25519 verify

### Protocol Module

**Sender Keys:**
- `SenderKeys.generate(): SenderKeyState`
- `SenderKeys.encrypt(state, plaintext): { ciphertext, nonce, chainIndex, nextState }`
- `SenderKeys.decrypt(record, chainIndex, nonce, ciphertext): { plaintext, nextRecord }`
- `SenderKeys.createDistribution(groupId, state, signingPublicKey): SenderKeyDistributionMessage`

**Double Ratchet:**
- `DoubleRatchet.initSender(sharedSecret, recipientRatchetPublic): DoubleRatchetState`
- `DoubleRatchet.initReceiver(sharedSecret, ownRatchetKeyPair): DoubleRatchetState`
- `DoubleRatchet.encrypt(state, plaintext): { ciphertext, nonce, ratchetPublicKey, previousChainLength, messageNumber, nextState }`
- `DoubleRatchet.decrypt(state, ratchetPublicKey, previousChainLength, messageNumber, nonce, ciphertext): { plaintext, nextState }`

**Messages:**
- `encodeMessage(message: ProtocolMessage): Uint8Array` — CBOR encode
- `decodeMessage(bytes: Uint8Array): ProtocolMessage` — CBOR decode
- `frameMessage(message: ProtocolMessage): Uint8Array` — Add length prefix
- `parseFrame(buffer: Uint8Array): { message, bytesConsumed } | null` — Parse framed message

## Type Definitions

### AgentIdentity

```typescript
interface AgentIdentity {
  edPrivateKey: Uint8Array;      // Ed25519 private key
  edPublicKey: Uint8Array;       // Ed25519 public key
  xPrivateKey: Uint8Array;       // X25519 private key (DH)
  xPublicKey: Uint8Array;        // X25519 public key (DH)
  fingerprint: string;           // Human-readable identifier
  displayName?: string;
}
```

### Sender Key State

```typescript
interface SenderKeyState {
  chainKey: Uint8Array;          // Current chain key
  chainIndex: number;            // Message counter
}

interface SenderKeyRecord {
  chainKey: Uint8Array;
  chainIndex: number;
  skippedKeys: Map<number, Uint8Array>; // For out-of-order delivery
}
```

### Double Ratchet State

```typescript
interface DoubleRatchetState {
  rootKey: Uint8Array;           // Root secret
  sendChainKey: Uint8Array | null;
  receiveChainKey: Uint8Array | null;
  sendRatchetPrivate: Uint8Array;
  sendRatchetPublic: Uint8Array;
  receiveRatchetPublic: Uint8Array | null;
  sendMessageNumber: number;
  receiveMessageNumber: number;
  previousChainLength: number;
  skippedKeys: Map<string, Uint8Array>;
}
```

### Protocol Messages

- `IdentityHandshake` — Peer authentication (Ed25519 signature + display name)
- `GroupSync` — Group membership and epoch
- `SenderKeyDistribution` — Share sender's chain for group membership
- `GroupMessage` — Encrypted message to group (Sender Keys)
- `DirectMessage` — Encrypted 1-to-1 message (Double Ratchet)
- `GroupManagement` — Invite, join, leave, kick, promote
- `TTYARequest` — Request from visitor to agent owner
- `TTYAResponse` — Agent's reply to visitor
- `Ack` — Acknowledgment

## Design Principles

1. **Pure Functions** — No side effects. State in, state out: `(state, input) => (state, output)`
2. **No Persistence** — Library doesn't touch disk or databases. Callers own state management.
3. **No Networking** — Library doesn't open sockets or make HTTP calls.
4. **Audited Crypto** — All cryptographic operations use Noble (peer-audited libraries).
5. **Deterministic** — No hidden randomness (nonces are explicit outputs).
6. **Composable** — Mix and match Sender Keys, Double Ratchet, or your own protocol.

## Tech Stack

- **Signing & Curves:** [@noble/curves](https://github.com/paulmillr/noble-crypto) (Ed25519, X25519)
- **Hashing & Derivation:** [@noble/hashes](https://github.com/paulmillr/noble-crypto) (SHA-256, HKDF, HMAC)
- **AEAD:** [@noble/ciphers](https://github.com/paulmillr/noble-crypto) (XChaCha20-Poly1305)
- **Encoding:** [cbor-x](https://github.com/kriszyp/cbor-x) (CBOR serialization)

## Security Notes

- **No custom crypto.** All algorithms are from audited libraries.
- **Nonces are random.** Every AEAD encryption generates a fresh 24-byte nonce (XChaCha20 provides 192-bit nonce space).
- **Ratcheting provides forward secrecy.** Compromising a key reveals only future messages (DH ratchet) or current + future (symmetric chain).
- **Skipped key limit.** Max 256 skipped messages to prevent denial-of-service via reordering attacks.
- **No authentication on AEAD keys alone.** Use Ed25519 signatures on protocol messages to verify sender identity.

## License

MIT

## Links

- **Main Package:** [@networkselfmd/node](../node) — P2P runtime with Hyperswarm
- **CLI:** [@networkselfmd/cli](../cli) — Terminal interface
- **Web:** [@networkselfmd/web](../web) — TTYA server and visitor chat
- **MCP:** [@networkselfmd/mcp](../mcp) — Claude Code integration
