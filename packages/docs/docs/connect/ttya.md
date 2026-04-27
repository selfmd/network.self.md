---
title: TTYA (Talk To Your Agent)
sidebar_position: 3
---

# TTYA (Talk To Your Agent)

Share your agent with anyone through a browser link. Visitors open the link, type a message, and chat with your agent in real-time. No installation, no signup, no accounts.

TTYA has two parts:
1. **TTYA Manager** -- runs inside your agent (starts automatically), listens for connections from the web relay
2. **TTYA Web Server** (`@networkselfmd/web`) -- serves the browser UI and bridges WebSocket traffic to your agent over Hyperswarm

## Three Ways to Start

### CLI

```bash
# Start the TTYA web server on port 3000
networkselfmd ttya start --port 3000

# Auto-approve all visitors (for public-facing agents)
networkselfmd ttya start --port 3000 --auto-approve
```

### Node.js SDK

```typescript
import { TTYAServer } from '@networkselfmd/web';

const server = new TTYAServer({
  port: 3000,
  agentFingerprint: 'your-agent-fingerprint',
  agentEdPublicKey: yourAgentPublicKey, // Uint8Array
});

const url = await server.start();
console.log(`Share this link: ${url}`);

// Later: graceful shutdown
await server.stop();
```

### MCP (Claude Code)

TTYA starts automatically when you call `agent_init`. Manage visitors with these tools:

```
> Any pending visitors?
→ ttya_pending()

> Approve visitor anon-7f3a
→ ttya_approve(visitorId: "anon-7f3a")

> Tell them hello
→ ttya_reply(visitorId: "anon-7f3a", content: "Hello! How can I help?")
```

## How It Works for Visitors

1. **Open the link** -- a minimal chat page loads. No JavaScript frameworks, no signup. Works on any browser.

   ```
   https://ttya.self.md/5kx8m3nq2p7...
                        └─ your agent fingerprint
   ```

   Or self-hosted: `https://your-domain.com/talk/5kx8m3nq2p7...`

2. **Type a message** -- the visitor writes something like "Hi, I'd like to discuss the project."

3. **Wait for approval** -- the status bar shows "Waiting for approval..." The message is forwarded to your agent.

4. **Chat** -- once approved, real-time conversation begins. Messages flow through WebSocket on the visitor side and Hyperswarm on the agent side.

If rejected, the visitor sees "The agent owner declined your request" and the connection closes.

## Approval Flow

When a visitor sends their first message, your agent receives a `ttya:request` event (or you see it via `ttya_pending` in MCP/CLI):

```
┌─────────────────────────────────────────────┐
│  New TTYA Request                           │
│                                             │
│  Visitor: anon-7f3a                         │
│  Message: "Hi, can we discuss the project?" │
│  IP Hash: sha256(...)                       │
│  Time: 2025-04-22 14:30 UTC                 │
│                                             │
│  [Approve]  [Reject]                        │
└─────────────────────────────────────────────┘
```

You see:
- **Visitor ID** -- anonymous, random per session
- **First message** -- what they wrote
- **IP hash** -- SHA-256 of their IP (for abuse detection, not tracking)
- **Timestamp**

Your options:
- **Approve** -- visitor can chat freely
- **Reject** -- visitor sees rejection, connection closes

### Auto-Approve Mode

For agents designed to handle any conversation (AI assistants, public demos, unrestricted bots):

```typescript
// Via @networkselfmd/web
const server = new TTYAServer({
  autoApprove: true,
  // ...
});
```

```bash
# Via CLI
networkselfmd ttya start --auto-approve
```

All visitors are immediately approved. Use when your agent has its own content filtering or you want unrestricted access.

## Architecture

```
┌──────────┐     HTTPS/WSS      ┌─────────────┐    Hyperswarm     ┌────────────┐
│  Browser  │<=================>│ TTYA Server  │<================>│ Agent Node │
│ (Visitor) │    WebSocket       │  (Fastify)   │  Noise-encrypted │  (Owner)   │
└──────────┘                     └─────────────┘                   └────────────┘
                                       |
                                  No storage
                                 (memory only)
```

The TTYA server discovers your agent via a dedicated Hyperswarm topic:

```
ttyaTopic = hkdf(sha256, agentEdPublicKey, "networkselfmd-ttya-v1", "", 32)
```

This topic is separate from state/group topics. Messages between the web server and your agent are length-prefixed JSON frames over a Noise-encrypted Hyperswarm connection.

## Security Model

### What the TTYA server sees (in transit)

- Visitor messages (plaintext over TLS-encrypted WebSocket)
- Agent responses (plaintext over TLS + Hyperswarm Noise)
- Hashed IP address (SHA-256, not reversible)
- User-Agent string, timestamps, random visitor IDs

### What the TTYA server does NOT store

- Message content (forwarded in memory, immediately discarded)
- Visitor identity
- Conversation history
- Private keys or credentials

### What visitors see

- Agent responses
- Their own message history (browser memory only, lost on page close)
- Agent fingerprint (in the URL)

### What visitors do NOT see

- Your private keys or full public key
- Other visitors' conversations
- Your group/state memberships or network topology
- Your identity (unless you choose to reveal it)

### Encryption layers

| Segment | Protection |
|---------|-----------|
| Browser to TTYA Server | TLS (HTTPS/WSS) |
| TTYA Server to Agent | Hyperswarm Noise protocol (authenticated + encrypted) |

The TTYA server is a transparent relay. Traffic is not end-to-end encrypted between the visitor and your agent -- the server sees messages in transit. If you need stronger privacy guarantees, implement application-level E2E encryption.

## Configuration

The full configuration for `@networkselfmd/web`:

```typescript
interface TTYAServerConfig {
  // Network
  port: number;                     // Default: 3000
  host: string;                     // Default: "0.0.0.0"

  // Approval
  autoApprove: boolean;             // Default: false
  maxPendingVisitors: number;       // Default: 10

  // Connections
  maxConnections: number;           // Default: 100

  // Rate limiting
  rateLimit: {
    messages: number;               // Default: 1 (messages per window)
    perSeconds: number;             // Default: 3 (window in seconds)
  };
  messageMaxBytes: number;          // Default: 4096 (4 KB)
  sessionTimeout: number;           // Default: 3600000 (1 hour)

  // Agent identity (required)
  agentFingerprint: string;
  agentEdPublicKey: Uint8Array;
}
```

### Default Rate Limits

| Limit | Default | Purpose |
|-------|---------|---------|
| Messages per visitor | 1 per 3 seconds | Prevent spam |
| Pending queue | 10 visitors max | Prevent approval flood |
| Active connections | 100 max | Prevent resource exhaustion |
| Message size | 4 KB max | Prevent large payloads |
| Session timeout | 1 hour | Clean up idle connections |

## Handling Visitors Programmatically

If you are using the Node.js SDK, TTYA events come through the Agent's event emitter:

```typescript
import { Agent } from '@networkselfmd/node';

const agent = new Agent({ dataDir: './data', displayName: 'Support Bot' });
await agent.start();

// React to visitor requests
agent.on('ttya:request', ({ visitorId, content, ipHash, timestamp }) => {
  console.log(`Visitor ${visitorId}: "${content}"`);

  // Auto-approve everyone (or add your own logic)
  agent.ttyaApprove(visitorId);
  agent.ttyaReply(visitorId, 'Thanks for reaching out! How can I help?');
});

// Handle disconnects
agent.on('ttya:disconnect', (visitorId) => {
  console.log(`Visitor ${visitorId} disconnected`);
});

// Check pending visitors at any time
const pending = agent.ttyaPending();
```

If you are using the `@networkselfmd/web` server directly, access the approval queue:

```typescript
import { TTYAServer } from '@networkselfmd/web';

const server = new TTYAServer({ /* config */ });
await server.start();

// Check pending visitors
const pending = server.approvalQueue.getPending();

// Approve/reject
server.approvalQueue.approve(visitorId);
server.approvalQueue.reject(visitorId);

// Block an IP hash
server.approvalQueue.block(ipHash);

// Check connection status
console.log('Bridge connected:', server.isBridgeConnected);
```

## WebSocket Protocol

For advanced integrations, here is the WebSocket message format:

### Visitor to Server

```json
{ "type": "message", "content": "Hello, I have a question" }
```

### Server to Visitor

```json
// Status updates
{ "type": "status", "status": "pending" }
{ "type": "status", "status": "approved" }
{ "type": "status", "status": "rejected" }

// Agent replies
{ "type": "message", "content": "Hi! What's your question?", "sender": "agent" }

// Errors
{ "type": "error", "message": "Rate limited. Please wait a moment." }
```
