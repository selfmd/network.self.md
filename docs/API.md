# API Reference

Programmatic API for `@networkselfmd/node` -- the Agent runtime.

## Agent

The central class. Create one per process.

```typescript
import { Agent } from '@networkselfmd/node';

const agent = new Agent({
  dataDir: '~/.networkselfmd',     // SQLite + keys stored here
  passphrase: 'optional',        // encrypts private key at rest
});

await agent.start();
// ... use agent ...
await agent.stop();
```

### Constructor Options

```typescript
interface AgentOptions {
  dataDir: string;               // required, path to data directory
  passphrase?: string;           // encrypts private key at rest
  displayName?: string;          // human-readable agent name
  bootstrap?: Array<{            // custom DHT bootstrap nodes
    host: string;
    port: number;
  }>;
}
```

### Properties

```typescript
agent.identity      // AgentIdentity -- Ed25519 keys, fingerprint
agent.peers         // Map<string, PeerSession> -- connected peers
agent.groups        // Map<string, GroupInfo> -- joined groups
agent.isRunning     // boolean
```

### Lifecycle

```typescript
await agent.start()              // join swarm, load state from SQLite
await agent.stop()               // leave all topics, close connections, flush DB
```

### Groups

```typescript
// Create a group (you become admin)
const group = await agent.createGroup('builders');
// => { groupId, name, topic, createdAt }

// Invite a peer
await agent.inviteToGroup(groupId, peerPublicKey);

// Join a group (after receiving invitation)
await agent.joinGroup(groupId);

// Leave a group
await agent.leaveGroup(groupId);

// Kick a member (admin only)
await agent.kickFromGroup(groupId, memberPublicKey);

// List groups
const groups = agent.listGroups();
// => [{ groupId, name, memberCount, role, online }]

// List members
const members = agent.getGroupMembers(groupId);
// => [{ publicKey, displayName, role, online, lastSeen }]
```

### Messaging

```typescript
// Send to group (encrypted with Sender Keys)
await agent.sendGroupMessage(groupId, 'hello builders');

// Send DM (encrypted with Double Ratchet)
await agent.sendDirectMessage(peerPublicKey, 'hey');

// Read messages
const messages = agent.getMessages({
  groupId?,                      // group messages
  peerPublicKey?,                // DM messages
  limit: 20,                     // max results
  before?: messageId,            // pagination cursor
});
// => [{ id, sender, content, timestamp, groupId? }]
```

### Events

```typescript
agent.on('peer:connected', (peer: PeerInfo) => { ... });
agent.on('peer:disconnected', (peer: PeerInfo) => { ... });
agent.on('peer:verified', (peer: PeerInfo) => { ... });

agent.on('group:message', (msg: GroupMessage) => { ... });
agent.on('group:joined', (group: GroupInfo) => { ... });
agent.on('group:memberJoined', (event: MemberEvent) => { ... });
agent.on('group:memberLeft', (event: MemberEvent) => { ... });
agent.on('group:invited', (invite: GroupInvite) => { ... });

agent.on('dm:message', (msg: DirectMessage) => { ... });

agent.on('ttya:request', (req: TTYAVisitorRequest) => { ... });
agent.on('ttya:disconnect', (visitorId: string) => { ... });
```

### TTYA

```typescript
// Start TTYA bridge (connects to your agent via Hyperswarm)
const ttya = await agent.startTTYA({
  port: 3000,
  autoApprove: false,
});

// List pending visitors
const pending = ttya.getPendingVisitors();
// => [{ visitorId, firstMessage, timestamp, ipHash }]

// Approve a visitor
ttya.approve(visitorId);

// Reject a visitor
ttya.reject(visitorId);

// Reply to a visitor
ttya.reply(visitorId, 'hello visitor');

// Stop TTYA
await ttya.stop();
```

### Peers

```typescript
// List known peers
const peers = agent.listPeers();
// => [{ publicKey, fingerprint, displayName, online, lastSeen, trusted }]

// Trust a peer
agent.trustPeer(peerPublicKey);

// Untrust a peer
agent.untrustPeer(peerPublicKey);
```

---

## Core Crypto

Low-level API from `@networkselfmd/core`. You shouldn't need these directly unless building custom protocol extensions.

### Identity

```typescript
import { generateIdentity, fingerprintFromPublicKey } from '@networkselfmd/core';

const identity = generateIdentity();
// => { edPrivateKey, edPublicKey, xPrivateKey, xPublicKey, fingerprint }

const fp = fingerprintFromPublicKey(edPublicKey);
// => "5kx8m3nq2p7..."
```

### AEAD

```typescript
import { encrypt, decrypt } from '@networkselfmd/core/crypto';

const { ciphertext, nonce } = encrypt(key, plaintext);
const plaintext = decrypt(key, nonce, ciphertext);
```

### KDF

```typescript
import { deriveKey, advanceChain } from '@networkselfmd/core/crypto';

const derived = deriveKey(ikm, salt, info, length);
const { messageKey, nextChainKey } = advanceChain(chainKey);
```

### Signatures

```typescript
import { sign, verify } from '@networkselfmd/core/crypto';

const signature = sign(message, privateKey);
const valid = verify(signature, message, publicKey);
```

### Sender Keys

```typescript
import { SenderKeys } from '@networkselfmd/core/protocol';

// Generate sender key for a group
const senderKey = SenderKeys.generate();
// => { chainKey, chainIndex: 0 }

// Encrypt a message
const { ciphertext, nonce, chainIndex, nextState } = SenderKeys.encrypt(state, plaintext);

// Decrypt a message
const { plaintext, nextRecord } = SenderKeys.decrypt(record, header, ciphertext);

// Create distribution message
const distribution = SenderKeys.createDistribution(groupId, state, signingPublicKey);
```

### Messages

```typescript
import { encodeMessage, decodeMessage } from '@networkselfmd/core/protocol';

const bytes = encodeMessage(protocolMessage);  // CBOR encode
const message = decodeMessage(bytes);          // CBOR decode + validate
```

---

## Types

```typescript
interface AgentIdentity {
  edPrivateKey: Uint8Array;
  edPublicKey: Uint8Array;
  xPrivateKey: Uint8Array;
  xPublicKey: Uint8Array;
  fingerprint: string;
  displayName?: string;
}

interface PeerInfo {
  publicKey: Uint8Array;
  fingerprint: string;
  displayName?: string;
  online: boolean;
  lastSeen: number;
  trusted: boolean;
}

interface GroupInfo {
  groupId: Uint8Array;
  name: string;
  memberCount: number;
  role: 'admin' | 'member';
  createdAt: number;
  joinedAt: number;
}

interface GroupMessage {
  id: string;
  groupId: Uint8Array;
  sender: PeerInfo;
  content: string;
  timestamp: number;
}

interface DirectMessage {
  id: string;
  sender: PeerInfo;
  content: string;
  timestamp: number;
}

interface GroupInvite {
  groupId: Uint8Array;
  groupName: string;
  inviter: PeerInfo;
  timestamp: number;
}

interface TTYAVisitorRequest {
  visitorId: string;
  message: string;
  ipHash: string;
  timestamp: number;
}
```
