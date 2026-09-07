import { once } from 'node:events';
import type Fastify from 'fastify';
import type { TTYARequest, TTYAResponse, TTYAServerConfig } from '../types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const bridgeState = vi.hoisted(() => ({
  requests: [] as TTYARequest[],
  responseHandler: null as ((response: TTYAResponse) => void) | null,
}));

vi.mock('../bridge.js', () => ({
  TTYABridge: class {
    async connect() {}
    async disconnect() {}
    onAgentResponse(handler: (response: TTYAResponse) => void) {
      bridgeState.responseHandler = handler;
    }
    sendToAgent(request: TTYARequest) {
      bridgeState.requests.push(request);
    }
  },
}));

import { TTYAServer } from '../server.js';

const servers: TTYAServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
});

async function startServer(config: Partial<TTYAServerConfig> = {}) {
  bridgeState.requests = [];
  const server = new TTYAServer({
    agentFingerprint: 'test-agent',
    agentEdPublicKey: new Uint8Array(32).fill(1),
    ttyaAuthSecret: new Uint8Array(32).fill(2),
    host: '127.0.0.1',
    port: 0,
    ...config,
  });
  servers.push(server);
  await server.start();
  const app = (server as unknown as { app: ReturnType<typeof Fastify> }).app;
  return { server, app };
}

describe('TTYA visitor server', () => {
  it('closes oversized WebSocket frames before parsing application JSON', async () => {
    const { app } = await startServer();
    const socket = await app.injectWS('/ws/test-agent');
    try {
      const closed = once(socket, 'close');
      socket.send(JSON.stringify({ type: 'message', content: 'a'.repeat(65_536) }));
      expect((await closed)[0]).toBe(1009);
      expect(bridgeState.requests).toHaveLength(0);
    } finally {
      socket.terminate();
    }
  });
  it('enforces the relay protocol content limit even when configured above it', async () => {
    const { app } = await startServer({ messageMaxBytes: 8192 });
    const socket = await app.injectWS('/ws/test-agent');
    try {
      const received = once(socket, 'message');
      socket.send(JSON.stringify({ type: 'message', content: 'a'.repeat(4097) }));
      expect(JSON.parse((await received)[0].toString())).toEqual({ type: 'error', message: 'Message too large' });
      expect(bridgeState.requests).toHaveLength(0);
    } finally {
      socket.terminate();
    }
  });
  it('requires approval before follow-up messages and delivers replies and rejection', async () => {
    const { server, app } = await startServer({ rateLimit: { messages: 1, perSeconds: 0 } });
    const socket = await app.injectWS('/ws/test-agent');
    async function send(content: string) {
      const message = once(socket, 'message');
      socket.send(JSON.stringify({ type: 'message', content }));
      return JSON.parse((await message)[0].toString());
    }
    try {
      expect(await send('Please help')).toEqual({ type: 'status', status: 'pending' });
      const visitorId = bridgeState.requests[0].visitorId;
      expect(await send('Not yet approved')).toEqual({ type: 'error', message: 'Waiting for approval' });
      expect(bridgeState.requests).toHaveLength(1);
      const approved = once(socket, 'message');
      bridgeState.responseHandler!({ type: 0x08, visitorId, action: 'approve' });
      expect(JSON.parse((await approved)[0].toString())).toEqual({ type: 'status', status: 'approved' });
      expect(server.approvalQueue.isApproved(visitorId)).toBe(true);
      socket.send(JSON.stringify({ type: 'message', content: 'Approved follow-up' }));
      await vi.waitFor(() => expect(bridgeState.requests).toHaveLength(2));
      expect(bridgeState.requests[1].content).toBe('Approved follow-up');
      const reply = once(socket, 'message');
      bridgeState.responseHandler!({ type: 0x08, visitorId, action: 'reply', content: 'Here is help' });
      expect(JSON.parse((await reply)[0].toString())).toEqual({ type: 'message', content: 'Here is help', sender: 'agent' });
      const rejected = once(socket, 'message');
      const closed = once(socket, 'close');
      bridgeState.responseHandler!({ type: 0x08, visitorId, action: 'reject' });
      expect(JSON.parse((await rejected)[0].toString())).toEqual({ type: 'status', status: 'rejected' });
      await closed;
      // injectWS does not finish the server side of the close handshake.
      server.approvalQueue.getSession(visitorId)?.websocket.terminate();
      await vi.waitFor(() => expect(server.approvalQueue.size).toBe(0));
      expect(bridgeState.requests.at(-1)).toMatchObject({ visitorId, action: 'disconnect' });
    } finally {
      socket.terminate();
    }
  });

  it('omits oversized optional browser metadata before forwarding to the agent', async () => {
    const { app } = await startServer();
    const socket = await app.injectWS('/ws/test-agent', { headers: { 'user-agent': 'a'.repeat(1025) } });
    try {
      const received = once(socket, 'message');
      socket.send(JSON.stringify({ type: 'message', content: 'Hello' }));
      await received;
      expect(bridgeState.requests[0].metadata.userAgent).toBeUndefined();
      expect(bridgeState.requests[0].content).toBe('Hello');
    } finally {
      socket.terminate();
    }
  });

  it('authorizes the embedded chat script and stylesheet with fresh CSP nonces', async () => {
    const { app } = await startServer();
    const response = await app.inject('/talk/test-agent');
    expect(response.statusCode).toBe(200);
    const policy = String(response.headers['content-security-policy']);
    const scriptNonce = response.body.match(/<script nonce="([^"]+)"/);
    const styleNonce = response.body.match(/<style nonce="([^"]+)"/);
    expect(scriptNonce).not.toBeNull();
    expect(styleNonce).not.toBeNull();
    expect(policy).toContain(`'nonce-${scriptNonce![1]}'`);
    expect(policy).toContain(`'nonce-${styleNonce![1]}'`);
    expect(policy.match(/script-src ([^;]+)/)?.[1]).not.toContain("'unsafe-inline'");
    expect(policy).not.toContain('upgrade-insecure-requests');
    expect(policy.match(/style-src ([^;]+)/)?.[1]).toContain('https://fonts.googleapis.com');
    const next = await app.inject('/talk/test-agent');
    expect(next.body.match(/<script nonce="([^"]+)"/)?.[1]).not.toBe(scriptNonce![1]);
  });

  it.each(['null', '[]', '42', '"hello"', '{}'])('rejects malformed JSON shape %s and keeps the socket usable', async (payload) => {
    const { server, app } = await startServer();
    const socket = await app.injectWS('/ws/test-agent');
    try {
      const rejected = once(socket, 'message');
      socket.send(payload);
      const [error] = await rejected;
      expect(JSON.parse(error.toString())).toEqual({ type: 'error', message: 'Invalid message type' });
      const accepted = once(socket, 'message');
      socket.send(JSON.stringify({ type: 'message', content: 'Hello agent' }));
      const [status] = await accepted;
      expect(JSON.parse(status.toString())).toEqual({ type: 'status', status: 'pending' });
      expect(server.approvalQueue.size).toBe(1);
    } finally {
      socket.terminate();
    }
  });
});
