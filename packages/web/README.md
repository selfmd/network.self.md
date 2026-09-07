# @networkselfmd/web

TTYA is deferred and is not part of the supported product offering. No hosted browser-chat service is advertised, and TTYA tools are not exposed by the MCP server. Existing implementation details below are retained as an archival reference, not an onboarding guide.

## Archival implementation reference

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

| Layer            | Protection                                            |
| ---------------- | ----------------------------------------------------- |
| Browser → Server | TLS (HTTPS/WSS)                                       |
| Server → Agent   | Hyperswarm Noise protocol (authenticated + encrypted) |
| Agent receives   | Everything decrypted, you see plaintext               |

**Key point:** The TTYA server is a transparent relay. It's not encrypted end-to-end between visitor and agent — messages are plaintext at the server. If you need stronger privacy, use E2E encryption at the application level.

## Configuration

```typescript
interface TTYAServerConfig {
  // Network
  port: number; // default: 3000
  host: string; // default: "0.0.0.0"

  // Approval flow
  autoApprove: boolean; // default: false
  maxPendingVisitors: number; // default: 10

  // Connection limits
  maxConnections: number; // default: 100

  // Message flow
  rateLimit: {
    messages: number; // default: 1 (msg per window)
    perSeconds: number; // default: 3 (second window)
  };
  messageMaxBytes: number; // default: 4096 (4 KB)
  sessionTimeout: number; // default: 3600000 (1 hour)

  // Agent identity
  agentFingerprint: string; // your agent's public key fingerprint
  agentEdPublicKey: Uint8Array; // your agent's Ed25519 public key
  ttyaAuthSecret: Uint8Array; // same >=32 random bytes as Agent
}
```

### Default rate limits

| Limit                | Value                   | Purpose                     |
| -------------------- | ----------------------- | --------------------------- |
| Messages per visitor | 1 message per 3 seconds | Prevent spam                |
| Pending queue size   | 10 visitors max         | Prevent approval flood      |
| Active connections   | 100 max                 | Prevent resource exhaustion |
| Message size         | 4 KB max                | Prevent large payloads      |
| Session timeout      | 1 hour                  | Clean up idle connections   |

## Approval flow

When a visitor sends their first message, the approval queue is triggered:

```
TTYARequest arrives at your agent
    │
    ├─→ ApprovalQueue.addVisitor(visitorId, message, ipHash)
    │   (added to pending list)
    │
    ├─→ Your agent code receives the message
    │   (Prototype terminal display: "Visitor anon-7f3a: Hi! Can we discuss...")
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
  TTYAServer, // Main server class
  TTYABridge, // Hyperswarm bridge
  ApprovalQueue, // Visitor queue
  type TTYAServerConfig,
  type TTYARequest,
  type TTYAResponse,
  type WSClientMessage,
  type WSServerMessage,
  DEFAULT_CONFIG,
} from "@networkselfmd/web";
```

### TTYAServer

```typescript
class TTYAServer {
  constructor(
    config: Partial<TTYAServerConfig> & {
      agentFingerprint: string;
      agentEdPublicKey: Uint8Array;
      ttyaAuthSecret: Uint8Array;
    },
  );

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
  touch(visitorId): void; // update last message timestamp
  cleanup(): void; // remove expired sessions
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
