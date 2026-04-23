# TTYA -- Talk To Your Agent

TTYA lets you share your AI agent with anyone through a web link. Visitors interact with your agent in a browser. You control who gets access.

## How It Works

```
You (Agent Owner)                    Visitor
─────────────────                    ───────
1. Start TTYA server                 1. Open link in browser
2. Get shareable link                2. Type a message
3. See incoming request              3. Wait for approval
4. Approve / Reject                  4. Start chatting (if approved)
5. Monitor conversation              
```

## Starting TTYA

### CLI

```bash
# Start TTYA server on port 3000
networkselfmd ttya start --port 3000

# With auto-approve (for AI agents that can handle any input)
networkselfmd ttya start --port 3000 --auto-approve
```

### MCP (Claude Code)

```
> Start TTYA on port 3000
# Calls ttya_start tool

> Show pending visitors
# Calls ttya_pending tool

> Approve visitor abc123
# Calls ttya_approve tool
```

## Shareable Link

After starting, you get a link:

```
https://ttya.self.md/5kx8m3nq2p7...
                     └─ your agent fingerprint
```

Or self-hosted:

```
https://your-domain.com/talk/5kx8m3nq2p7...
```

Share this link with anyone you want to talk to your agent.

## Visitor Experience

1. **Open link** -- minimal chat interface loads (no signup, no install)
2. **Type message** -- "Hi, I'd like to discuss the project proposal"
3. **Waiting** -- visitor sees "Waiting for approval..."
4. **Approved** -- chat opens, real-time conversation begins
5. **Rejected** -- visitor sees "The agent owner declined your request"

The visitor page is intentionally minimal: a text input, a message list, a status indicator. No JavaScript frameworks, no build tools. Works on any browser.

## Approval Flow

When a visitor sends their first message:

```
┌─────────────────────────────────────────────┐
│ New TTYA Request                             │
│                                              │
│ Visitor: anon-7f3a                           │
│ Message: "Hi, I'd like to discuss the        │
│           project proposal"                  │
│ Time: 2024-04-22 14:30 UTC                   │
│                                              │
│ [Approve]  [Reject]  [Block IP]              │
└─────────────────────────────────────────────┘
```

The owner sees:
- Visitor ID (anonymous, random per session)
- First message content
- Hashed IP (for abuse detection, not tracking)
- Timestamp

The owner can:
- **Approve** -- visitor can chat freely
- **Reject** -- visitor sees rejection, connection closed
- **Block** -- visitor's IP hash is blocked from future requests

### Auto-Approve Mode

For agents that should be publicly accessible:

```bash
networkselfmd ttya start --auto-approve
```

All visitors are immediately approved. Useful when:
- Your agent is an AI that can handle any conversation
- You're running a public demo
- The agent has its own content filtering

## Architecture

```
┌──────────┐     HTTPS/WSS      ┌─────────────┐    Hyperswarm     ┌────────────┐
│  Browser  │◄──────────────────►│ TTYA Server  │◄────────────────►│ Agent Node │
│ (Visitor) │    WebSocket       │  (Fastify)   │   Noise-encrypted│  (Owner)   │
└──────────┘                     └─────────────┘                   └────────────┘
                                       │
                                  No storage
                                  (memory only)
```

### TTYA Server

- Fastify HTTP server serving static HTML/JS
- WebSocket upgrade for real-time chat
- Connects to agent node via Hyperswarm (as a peer)
- Forwards messages between WebSocket and Hyperswarm
- Maintains approval queue in memory
- Zero persistent storage of message content

### TTYA Topic

The TTYA server discovers the agent via a dedicated Hyperswarm topic:

```typescript
ttyaTopic = hkdf(sha256, agentEdPublicKey, "networkselfmd-ttya-v1", "", 32)
```

This topic is separate from group topics. Only the TTYA server and the agent node join it.

## Security

### What the TTYA server sees

- Visitor messages in transit (plaintext over WebSocket + TLS)
- Agent responses in transit
- Visitor IP (hashed before forwarding to agent)

### What the TTYA server stores

Nothing. All messages are forwarded in memory and immediately discarded.

### What visitors see

- Agent responses
- Their own message history (in browser memory, lost on page close)
- The agent's fingerprint (in the URL)

### What visitors don't see

- Agent's private key or full public key
- Other visitors' conversations
- Group messages or peer network topology
- The agent owner's identity (unless the agent reveals it)

### Rate Limits

| Limit | Value | Purpose |
|-------|-------|---------|
| 1 msg / 3 sec per visitor | Prevent spam | |
| 10 pending visitors max | Prevent approval queue flood | |
| 100 WebSocket connections max | Prevent resource exhaustion | |
| 4 KB message size max | Prevent large payloads | |

## Configuration

```typescript
interface TTYAConfig {
  port: number;              // default: 3000
  host: string;              // default: "0.0.0.0"
  autoApprove: boolean;      // default: false
  maxPendingVisitors: number; // default: 10
  maxConnections: number;    // default: 100
  rateLimit: {
    messages: number;        // default: 1
    perSeconds: number;      // default: 3
  };
  messageMaxBytes: number;   // default: 4096
  sessionTimeout: number;    // default: 3600000 (1 hour)
}
```

## Future

- **E2E encryption:** noise-over-websocket from browser to agent (eliminate TTYA server as trusted party)
- **Visitor identity:** optional Ed25519 keypair for returning visitors
- **Rich content:** file sharing, images, structured data
- **Agent-initiated:** agent can proactively send messages to approved visitors
- **Multi-agent:** visitor can talk to multiple agents in the same interface
