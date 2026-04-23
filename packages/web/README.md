# @networkselfmd/web

**Zero-knowledge web relay for peer-to-peer agent conversations.**

Share your AI agent with anyone through a browser link. Visitors chat in real-time while you control who gets access. The web server is a stateless relay — it sees messages in transit but stores nothing.

## What it does

`@networkselfmd/web` is the **TTYA (Talk To Your Agent)** server. It:

- Serves a minimal, no-signup chat UI for visitors
- Manages visitor approval via an in-memory queue
- Bridges HTTP/WebSocket traffic to your agent node via Hyperswarm P2P
- Enforces rate limits and message size constraints
- Maintains zero persistent storage of message content

Perfect for sharing your agent with team members, clients, or the public while keeping full control over who gets access.

## Quick start

### As a library

```typescript
import { TTYAServer } from '@networkselfmd/web';

// Start the server
const server = new TTYAServer({
  port: 3000,
  agentFingerprint: 'your-agent-fingerprint',
  agentEdPublicKey: yourAgentPublicKey, // Uint8Array
});

const url = await server.start();
console.log(`Chat link: ${url}`);

// Approve/reject visitors through the queue
const pending = server.approvalQueue.getPending();
pending.forEach((session) => {
  console.log(`Visitor ${session.visitorId}: "${session.firstMessage}"`);
  // server.approvalQueue.approve(session.visitorId);
  // server.approvalQueue.reject(session.visitorId);
});

// Graceful shutdown
await server.stop();
```

### Via CLI

```bash
# Start the TTYA server
networkselfmd ttya start --port 3000

# Auto-approve all visitors (for public agents)
networkselfmd ttya start --port 3000 --auto-approve

# Show pending visitor requests
networkselfmd ttya pending

# Approve a specific visitor
networkselfmd ttya approve <visitor-id>

# Reject a visitor
networkselfmd ttya reject <visitor-id>

# Block an IP
networkselfmd ttya block <ip-hash>
```

### Via MCP (Claude Code)

Add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "networkselfmd": {
      "command": "npx",
      "args": ["@networkselfmd/mcp"],
      "env": { "L2S_DATA_DIR": "~/.networkselfmd" }
    }
  }
}
```

Then in Claude Code:

```
> Start TTYA on port 3000
> Show pending visitors
> Approve visitor abc123
```

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                    Visitor's Browser                         │
│  (Minimal chat UI, no signup, HTTPS/WSS connection)          │
└──────────────────────────┬───────────────────────────────────┘
                          HTTPS/WSS
                             │
┌──────────────────────────┴───────────────────────────────────┐
│              TTYA Server (Fastify + WebSocket)               │
│  • Routes: GET /talk/:fingerprint, WebSocket /ws/:fp         │
│  • Approval queue (in-memory)                                │
│  • Rate limiting (per-visitor)                               │
│  • Message size enforcement                                  │
│  • IP hashing for abuse detection                            │
│  • No persistent storage                                     │
└──────────────────────────┬───────────────────────────────────┘
                          Hyperswarm
                        (Noise-encrypted)
                             │
┌──────────────────────────┴───────────────────────────────────┐
│                Agent Node (Your Device)                      │
│  • Handles approval/rejection decisions                      │
│  • Processes messages                                        │
│  • Sends responses back to visitors                          │
└──────────────────────────────────────────────────────────────┘
```

## How visitors chat with your agent

1. **You start TTYA:**
   ```
   TTYA server starts on port 3000
   ✓ Connected to Hyperswarm
   ✓ Joined TTYA topic with agent fingerprint
   → Chat link: https://ttya.self.md/abc123xyz...
   ```

2. **Visitor opens the link:**
   - Minimal HTML page loads (no JavaScript frameworks)
   - No signup required
   - Input field shows "Type a message..."
   - Status bar shows "Waiting for approval"

3. **Visitor types a message:**
   - `"Hi! Can we discuss the project proposal?"`
   - Message is sent to TTYA server via WebSocket
   - Server creates a visitor session, sends TTYARequest to your agent

4. **You see the approval request:**
   - CLI/MCP shows: `Visitor: anon-7f3a | Message: "Hi! Can we discuss..."`
   - You see hashed IP, timestamp, and first message content
   - Options: Approve, Reject, Block IP

5. **If approved:**
   - Visitor gets `type: status, status: approved`
   - Real-time conversation begins
   - All subsequent messages forwarded in memory
   - No conversation history is written to disk

6. **If rejected:**
   - Visitor sees `type: status, status: rejected`
   - WebSocket closes
   - Session is cleaned up

## Security model

### What the TTYA server sees

- **In transit:** Visitor messages (plaintext over TLS-encrypted WebSocket)
- **In transit:** Agent responses (plaintext over TLS + Hyperswarm Noise)
- **For abuse detection:** Hashed IP address (SHA-256, not reversible)
- **Metadata:** User-Agent, timestamp, visitor ID (random per session)

### What the TTYA server does NOT store

- Message content
- Visitor identity
- Conversation history
- Private keys
- Credentials

### What visitors see

- Agent's responses
- Their own message history (browser memory only, lost on page close)
- Agent fingerprint (in the URL)

### What visitors do NOT see

- Your private keys
- Other visitors' conversations
- Your group memberships
- Network topology
- Your identity (unless you choose to reveal it)

### Encryption layers

| Layer | Protection |
|-------|-----------|
| Browser → Server | TLS (HTTPS/WSS) |
| Server → Agent | Hyperswarm Noise protocol (authenticated + encrypted) |
| Agent receives | Everything decrypted, you see plaintext |

**Key point:** The TTYA server is a transparent relay. It's not encrypted end-to-end between visitor and agent — messages are plaintext at the server. If you need stronger privacy, use E2E encryption at the application level.

## Configuration

```typescript
interface TTYAServerConfig {
  // Network
  port: number;                     // default: 3000
  host: string;                     // default: "0.0.0.0"

  // Approval flow
  autoApprove: boolean;              // default: false
  maxPendingVisitors: number;        // default: 10

  // Connection limits
  maxConnections: number;            // default: 100

  // Message flow
  rateLimit: {
    messages: number;                // default: 1 (msg per window)
    perSeconds: number;              // default: 3 (second window)
  };
  messageMaxBytes: number;           // default: 4096 (4 KB)
  sessionTimeout: number;            // default: 3600000 (1 hour)

  // Agent identity
  agentFingerprint: string;          // your agent's public key fingerprint
  agentEdPublicKey: Uint8Array;      // your agent's Ed25519 public key
}
```

### Default rate limits

| Limit | Value | Purpose |
|-------|-------|---------|
| Messages per visitor | 1 message per 3 seconds | Prevent spam |
| Pending queue size | 10 visitors max | Prevent approval flood |
| Active connections | 100 max | Prevent resource exhaustion |
| Message size | 4 KB max | Prevent large payloads |
| Session timeout | 1 hour | Clean up idle connections |

## Approval flow

When a visitor sends their first message, the approval queue is triggered:

```
TTYARequest arrives at your agent
    │
    ├─→ ApprovalQueue.addVisitor(visitorId, message, ipHash)
    │   (added to pending list)
    │
    ├─→ Your agent code receives the message
    │   (CLI/MCP shows: "Visitor anon-7f3a: Hi! Can we discuss...")
    │
    └─→ You decide:
        ├─→ approve(visitorId)      → Visitor can chat freely
        ├─→ reject(visitorId)       → Connection closes, visitor notified
        └─→ block(ipHash)           → IP is blocked from future requests
```

### Auto-approve mode

For public agents that can handle any conversation:

```typescript
const server = new TTYAServer({
  autoApprove: true, // All visitors approved immediately
  // ... other config
});
```

Use when:
- Your agent has robust content filtering
- You're running a public demo
- The agent is designed for unrestricted access

## Exported API

```typescript
import {
  TTYAServer,           // Main server class
  TTYABridge,           // Hyperswarm bridge
  ApprovalQueue,        // Visitor queue
  type TTYAServerConfig,
  type TTYARequest,
  type TTYAResponse,
  type WSClientMessage,
  type WSServerMessage,
  DEFAULT_CONFIG,
} from '@networkselfmd/web';
```

### TTYAServer

```typescript
class TTYAServer {
  constructor(config: Partial<TTYAServerConfig> & {
    agentFingerprint: string;
    agentEdPublicKey: Uint8Array;
  });

  // Start the HTTP/WS server and connect to Hyperswarm
  async start(): Promise<string>;

  // Stop the server and disconnect
  async stop(): Promise<void>;

  // Access the approval queue
  get approvalQueue(): ApprovalQueue;

  // Check if bridge has an active connection to the agent
  get isBridgeConnected(): boolean;
}
```

### ApprovalQueue

```typescript
class ApprovalQueue {
  // Manage visitors
  addVisitor(visitorId, firstMessage, ipHash, ws): VisitorSession | null;
  approve(visitorId): string; // returns session token
  reject(visitorId): void;
  block(ipHash): void;
  remove(visitorId): void;

  // Query state
  isApproved(visitorId): boolean;
  isBlocked(ipHash): boolean;
  getSession(visitorId): VisitorSession | undefined;
  getPending(): VisitorSession[];

  // Lifecycle
  touch(visitorId): void;     // update last message timestamp
  cleanup(): void;             // remove expired sessions
  get size(): number;
}
```

## Visitor UI

The chat page is intentionally minimal and dependency-free:

- **No npm/build step** — pure HTML + vanilla JavaScript
- **Dark theme** — distraction-free interface
- **Responsive** — works on mobile and desktop
- **Accessible** — proper semantic HTML, keyboard navigation
- **Fast load** — ~5 KB inline (no external CSS/JS)

Served from `GET /talk/:fingerprint`, the page includes:

- Status bar (pending/approved/rejected)
- Message list (agent + visitor messages)
- Text input with "Send" button
- Auto-scroll on new messages

## WebSocket protocol

### Client → Server (visitor's browser to TTYA server)

```typescript
{
  type: 'message',
  content: 'Hello, I have a question'
}
```

### Server → Client

```typescript
// Status updates
{ type: 'status', status: 'pending' | 'approved' | 'rejected' }

// Agent replies
{ type: 'message', content: 'Hi! What's your question?', sender: 'agent' }

// Errors
{ type: 'error', message: 'Rate limited. Please wait a moment.' }
```

## Hyperswarm bridge

The TTYA server connects to your agent node via Hyperswarm using a derived topic:

```
ttyaTopic = hkdf(sha256, agentEdPublicKey, "networkselfmd-ttya-v1", "", 32)
```

The server joins as a **client** (looking for the agent server). The agent node runs as a **server** on the same topic.

### Message framing

Requests and responses are sent as length-prefixed JSON frames:

```
[4 bytes: uint32 BE length] [JSON payload]
```

Future versions will use CBOR matching the network.self.md protocol spec.

## Roadmap

- [ ] **E2E encryption** — Noise protocol from browser to agent (eliminate server as trusted party)
- [ ] **Visitor identity** — Optional Ed25519 keypair for returning visitors
- [ ] **Rich content** — File uploads, images, structured data types
- [ ] **Agent-initiated** — Agent proactively sends messages to approved visitors
- [ ] **Multi-agent** — Visitor chats with multiple agents in one interface
- [ ] **Analytics** — Anonymized metrics (message count, approval rate, etc.)

## Development

```bash
# Build
pnpm build

# Development mode (watch)
pnpm dev

# Tests
pnpm test
```

### Project structure

```
packages/web/
├── src/
│   ├── index.ts              # Main exports
│   ├── server.ts             # TTYAServer (HTTP/WS + routing)
│   ├── bridge.ts             # TTYABridge (Hyperswarm networking)
│   ├── approval.ts           # ApprovalQueue (visitor state machine)
│   ├── types.ts              # Message types and config interfaces
│   └── static-content.ts     # Embedded visitor chat UI
├── package.json
└── tsconfig.json
```

## License

MIT
