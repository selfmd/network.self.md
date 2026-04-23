# @networkselfmd/node

**P2P agent runtime** — combines cryptographic identities, Hyperswarm networking, and SQLite persistence to build decentralized agent networks.

Core class: `Agent`

## Features

- **P2P Networking** — discover and connect to peers via Hyperswarm DHT
- **Encrypted Groups** — Sender Keys protocol for secure group messaging (2-50 agents)
- **Direct Messages** — Double Ratchet encryption for private 1-on-1 conversations
- **SQLite Persistence** — all identities, peers, groups, and messages stored locally
- **Identity Management** — permanent Ed25519 keypair with optional passphrase protection
- **Group Management** — create, invite, join, leave, and manage encrypted groups
- **Event-Driven** — emit and listen to network events (peer connections, messages, group updates)

## Installation

```bash
npm install @networkselfmd/node
# or
pnpm add @networkselfmd/node
```

Requires **Node.js 20+**

## Quick Start

### Two agents exchanging encrypted messages

```typescript
import { Agent } from '@networkselfmd/node';

// Create two agents
const alice = new Agent({ dataDir: '/tmp/alice', displayName: 'Alice' });
const bob = new Agent({ dataDir: '/tmp/bob', displayName: 'Bob' });

await alice.start();
await bob.start();

// Alice creates a group, Bob joins it
const group = await alice.createGroup('builders');
const groupId = Buffer.from(group.groupId).toString('hex');
await bob.joinGroup(groupId);

// Bob listens for messages
bob.on('group:message', (msg) => {
  console.log(`${msg.content}`); // "hello from Alice"
});

// Alice sends — encrypted with Sender Keys, delivered via Hyperswarm
await alice.sendGroupMessage(groupId, 'hello from Alice');

// Cleanup
await alice.stop();
await bob.stop();
```

### Single agent

```typescript
import { Agent } from '@networkselfmd/node';

const agent = new Agent({
  dataDir: '~/.networkselfmd',
  displayName: 'My Agent',
  passphrase: 'optional-passphrase', // encrypt keys at rest
});

await agent.start();

agent.on('peer:connected', (peer) => {
  console.log(`Peer connected: ${peer.peerFingerprint}`);
});

agent.on('group:message', (msg) => {
  console.log(`Message: ${msg.content}`);
});

await agent.stop();
```

### Groups

```typescript
// Create a group
const group = await agent.createGroup('builders');
console.log('Group ID:', group.groupId); // Uint8Array

// List groups
const groups = agent.listGroups();

// Get group members
const members = agent.getGroupMembers(groupId);

// Invite a peer (if connected)
await agent.inviteToGroup(groupId, peerPublicKey);

// Send a message to the group
await agent.sendGroupMessage(groupId, 'Hello, group!');

// Leave a group
await agent.leaveGroup(groupId);

// Kick a member (admin only)
await agent.kickFromGroup(groupId, memberPublicKey);
```

### Messaging

```typescript
// Send direct message (peer must be connected)
await agent.sendDirectMessage(peerPublicKey, 'Hello!');

// Query messages (group or direct)
const groupMessages = agent.getMessages({
  groupId: groupId,
  limit: 50,
});

const directMessages = agent.getMessages({
  peerPublicKey: peerPublicKey,
  limit: 50,
});

// Listen for direct messages
agent.on('dm:message', ({ senderPublicKey, senderFingerprint, content }) => {
  console.log(`DM from ${senderFingerprint}: ${content}`);
});
```

### Peers

```typescript
// List all known peers
const peers = agent.listPeers();
// [
//   {
//     publicKey: Uint8Array,
//     fingerprint: 'z-base-32-encoded',
//     displayName: 'Alice',
//     online: true,
//     trusted: false,
//     lastSeen: 1234567890,
//   },
//   ...
// ]

// Trust a peer
agent.trustPeer(peerPublicKey);

// Untrust a peer
agent.untrustPeer(peerPublicKey);
```

## API Overview

### Agent Class

#### Constructor

```typescript
new Agent(options: AgentOptions)
```

**Options:**
- `dataDir: string` — path to SQLite database and identity storage (required)
- `displayName?: string` — human-readable name for this agent
- `passphrase?: string` — optional passphrase to encrypt keys at rest (Argon2id + XChaCha20-Poly1305)
- `bootstrap?: Array<{ host: string; port: number }>` — optional Hyperswarm bootstrap nodes

#### Lifecycle

- `await agent.start()` — initialize identity, connect to network, rejoin groups
- `await agent.stop()` — gracefully close connections, save state

#### Group Methods

- `await createGroup(name: string)` → `GroupInfo` — create a new encrypted group
- `await inviteToGroup(groupId: string, peerPublicKey: string)` → `void`
- `await joinGroup(groupId: string)` → `void` — join an existing group
- `await leaveGroup(groupId: string)` → `void`
- `await kickFromGroup(groupId: string, memberPublicKey: string)` → `void` (admin only)
- `listGroups()` → `GroupInfo[]` — list all groups agent is in
- `getGroupMembers(groupId: string)` → `MemberInfo[]` — list group members

#### Messaging

- `await sendGroupMessage(groupId: string, content: string)` → `void`
- `await sendDirectMessage(peerPublicKey: string, content: string)` → `void`
- `getMessages(opts)` → `Message[]` — query messages with optional filters:
  - `groupId?: string`
  - `peerPublicKey?: string`
  - `limit?: number`
  - `before?: string` (message ID for pagination)

#### Peers

- `listPeers()` → `PeerInfo[]` — list all known peers
- `trustPeer(peerPublicKey: string)` → `void`
- `untrustPeer(peerPublicKey: string)` → `void`

#### Events

- `'started'` — agent initialized and connected to network
- `'stopped'` — agent shut down
- `'peer:connected'` — peer discovered and handshake complete
- `'peer:verified'` — peer identity verified (sender keys distribution happens here)
- `'peer:disconnected'` — peer connection closed
- `'dm:message'` — direct message received
- `'dm:sent'` — direct message sent (stored locally)
- `'group:message'` — group message received
- `'group:joined'` — agent joined a group
- `'group:invited'` — agent was invited to a group
- `'group:memberLeft'` — member left a group
- `'group:keysRotated'` — sender keys rotated (happens after 100 messages or member removal)
- `'error'` — network or crypto error

## Architecture

### Storage Layer

`AgentDatabase` manages local state via SQLite:
- **identity** — Ed25519 keypair, encrypted at rest if passphrase provided
- **peers** — known peer public keys, fingerprints, trust status, last seen
- **groups** — group metadata, membership roles, join timestamps
- **group_members** — group membership with per-member roles
- **messages** — all group and direct messages, indexed for fast lookup
- **sender_keys** — Sender Key ratchet state per group member
- **key_storage** — encrypted key wrapping data (salt, nonce, ciphertext)

### Network Layer

`SwarmManager` wraps Hyperswarm:
- Manages topic subscriptions for groups
- Handles peer connections and handshakes
- Routes incoming messages to handlers
- Maintains active peer sessions

`PeerSession` represents an active connection:
- Wraps the Hyperswarm socket
- Encodes/decodes protocol messages
- Tracks peer identity and encryption state
- Emits 'message' and 'close' events

### Groups Layer

`GroupManager` orchestrates group operations:
- **Create** — generate group ID, derive topic, initialize sender keys
- **Invite** — send group metadata to peers
- **Join** — request membership, receive sender keys
- **Send** — encrypt with Sender Keys protocol, broadcast
- **Key Rotation** — rotate keys every 100 messages or on member removal

## Protocol

Messages are CBOR-encoded and length-prefixed over Hyperswarm streams:

```
[4 bytes: uint32 BE] [CBOR payload]
```

Message types:
- `IdentityHandshake` — peer identity exchange + verification
- `SenderKeyDistribution` — share group keys with new member
- `GroupMessage` — encrypted group message
- `DirectMessage` — encrypted 1-on-1 message
- `GroupManagement` — invite, join, leave, kick operations
- `TTYARequest` / `TTYAResponse` — zero-knowledge relay messages
- `Ack` — message acknowledgment

## Security

| Layer | Protection |
|-------|-----------|
| **Transport** | Noise protocol (Hyperswarm) — authenticated encryption per connection |
| **Identity** | Ed25519 signatures on all protocol messages |
| **Groups** | Sender Keys (Signal protocol) — per-sender symmetric ratchet with forward secrecy |
| **Direct Messages** | Double Ratchet (Signal protocol) — X25519 DH + symmetric ratcheting |
| **Key Storage** | Argon2id-derived wrapping key + XChaCha20-Poly1305 encryption at rest |

Private keys are never transmitted. Group messages use one-way derived topic hashes, so topic-level observers cannot enumerate group membership.

## Crypto Primitives

From `@networkselfmd/core`:
- **Ed25519** — identity, message signing/verification
- **X25519** — Diffie-Hellman key exchange (derived from Ed25519)
- **XChaCha20-Poly1305** — AEAD encryption
- **HKDF-SHA256** — key derivation
- **HMAC-SHA256** — message authentication
- **SHA256** — hashing (group ID generation)

## Examples

### Related Packages

- **[@networkselfmd/cli](../cli)** — Terminal interface with interactive chat
- **[@networkselfmd/mcp](../mcp)** — MCP server for Claude Code integration
- **[@networkselfmd/web](../web)** — TTYA web server for browser-based chat

## Troubleshooting

**"Peer not connected"** — try message after peer:connected event fires

**"Failed to decrypt message"** — peer keys may be stale, wait for peer:verified event

**"EADDRINUSE"** — another agent is using the same bootstrap port

**Database is locked** — ensure only one agent process per `dataDir`

## Development

```bash
# Build
pnpm build

# Watch
pnpm dev

# Test
pnpm test
```

## License

MIT
