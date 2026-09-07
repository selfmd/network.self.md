# TTYA — deferred

TTYA is deferred and is not part of the supported product offering. No hosted browser-chat service is advertised, and TTYA tools are not exposed by the MCP server. Existing implementation details below are retained as an archival reference, not an onboarding guide.

## Archival implementation reference

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
ttyaTopic = hkdf(sha256, agentEdPublicKey, "networkselfmd-ttya-v1", "", 32);
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

| Limit                         | Value                        | Purpose |
| ----------------------------- | ---------------------------- | ------- |
| 1 msg / 3 sec per visitor     | Prevent spam                 |         |
| 10 pending visitors max       | Prevent approval queue flood |         |
| 100 WebSocket connections max | Prevent resource exhaustion  |         |
| 4 KB message size max         | Prevent large payloads       |         |

## Configuration

### Authentication key

TTYA requires one pre-shared key (PSK) for the agent manager and web bridge.
It must be at least 32 cryptographically random bytes; short secrets are
rejected, but operators remain responsible for using a CSPRNG rather than a
human-memorable value. Constructors defensively copy the key so later caller
mutation cannot change an active transport.

The CLI loads a canonical hex/base64 `NETWORKSELFMD_TTYA_PSK` when set.
Otherwise it atomically creates and reuses the raw 32-byte
`$L2S_DATA_DIR/ttya.psk` file with owner-only permissions. `--psk-file` selects
a different raw key file. The same loaded byte string is passed to `Agent`
(`ttyaAuthSecret`) and `TTYAServer` (`ttyaAuthSecret`); never configure the two
sides independently in one deployment.

For a separate web deployment, copy the raw PSK through the platform's secret
manager and provide identical bytes to the agent and server. Do not put it in
source control, command-line arguments, logs, or the share URL.

### Rotation and protocol upgrade

To rotate, stop both sides, generate a new 32-byte-or-longer random key, replace
the secret on the agent and bridge, and restart both. Rotation intentionally
drops active sessions and queued in-memory requests; mixed old/new keys fail
closed. Retire the old key only after confirming the new bridge reports an
authenticated connection.

Protocol v3 is intentionally incompatible with the earlier unbound v2
challenge-response. Upgrade the agent and web bridge together. A rolling
mixed-version deployment does not downgrade or fall back to the generic peer
transport; it remains disconnected until both sides run v3.

```typescript
interface TTYAConfig {
  port: number; // default: 3000
  host: string; // default: "0.0.0.0"
  autoApprove: boolean; // default: false
  maxPendingVisitors: number; // default: 10
  maxConnections: number; // default: 100
  rateLimit: {
    messages: number; // default: 1
    perSeconds: number; // default: 3
  };
  messageMaxBytes: number; // default: 4096
  sessionTimeout: number; // default: 3600000 (1 hour)
  ttyaAuthSecret: Uint8Array; // required, same >=32 random bytes on both sides
}
```
