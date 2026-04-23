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

### Create and start an agent

```typescript
import { Agent } from '@networkselfmd/node';

const agent = new Agent({
  dataDir: '/path/to/agent/data',
  displayName: 'My Agent',
  passphrase: 'optional-passphrase', // encrypt keys at rest
});

// Start the agent (connects to network, loads identity)
await agent.start();

// Listen for peer connections
agent.on('peer:connected', ({ fingerprint, displayName }) => {
  console.log(`Peer connected: ${displayName} (${fingerprint})`);
});

// Listen for group messages
agent.on('group:message', ({ groupId, senderPublicKey, content, timestamp }) => {
  console.log(`Message in group: ${content}`);
});

// Graceful shutdown
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

### CLI Agent

```bash
# Create agent identity
npx @networkselfmd/cli init --name "Alice"

# Create group
npx @networkselfmd/cli create-group --name "builders"

# Chat in group
npx @networkselfmd/cli chat --group <group-id>
```

### MCP Server Integration

See `@networkselfmd/mcp` to integrate with Claude Code or other MCP clients.

### Web Interface

See `@networkselfmd/web` for TTYA (Talk To Your Agent) web server and visitor UI.

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
