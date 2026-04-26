import { describe, it, expect, beforeAll } from 'vitest';
import { buildApp } from '../routes.js';
import type { FastifyInstance } from 'fastify';

function mockAgent() {
  const now = Date.now();
  let joinedPublic = false;
  return {
    identity: {
      fingerprint: 'abc123',
      displayName: 'TestAgent',
      edPublicKey: new Uint8Array(32),
    },
    isRunning: true,
    listPeers: () => [
      {
        publicKey: new Uint8Array(32).fill(1),
        fingerprint: 'peer1fp',
        displayName: 'Peer One',
        online: true,
        lastSeen: now,
        trusted: true,
      },
      {
        publicKey: new Uint8Array(32).fill(2),
        fingerprint: 'peer2fp',
        displayName: undefined,
        online: false,
        lastSeen: now - 7200000,
        trusted: false,
      },
    ],
    listGroups: () => [
      {
        groupId: new Uint8Array([1, 2, 3]),
        name: 'builders',
        memberCount: 3,
        role: 'admin' as const,
        createdAt: now - 86400000,
        joinedAt: now - 86400000,
        selfMd: 'We build things.',
        isPublic: true,
      },
      ...(joinedPublic ? [{
        groupId: new Uint8Array([4, 5, 6]),
        name: 'research',
        memberCount: 5,
        role: 'member' as const,
        createdAt: now,
        joinedAt: now,
        selfMd: 'AI research.',
        isPublic: true,
      }] : []),
    ],
    listDiscoveredGroups: () => joinedPublic ? [] : [
      {
        groupId: new Uint8Array([4, 5, 6]),
        name: 'research',
        selfMd: 'AI research.',
        memberCount: 5,
      },
    ],
    joinPublicGroup: async () => { joinedPublic = true; },
    getGroupMembers: () => [],
    getMessages: () => [],
  };
}

describe('Dashboard API routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ agent: mockAgent() as any });
  });

  it('GET /healthz returns process health', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  it('GET /api/status returns counts and capability flags', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/status' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.agentFingerprint).toBe('abc123');
    expect(body.agentDisplayName).toBe('TestAgent');
    expect(body.peersOnline).toBe(1);
    expect(body.peersTotal).toBe(2);
    expect(body.stateCount).toBe(2);
    expect(body.capabilities.discovery).toBe(true);
    expect(body.capabilities.wireTrace).toBe(false);
  });

  it('GET /api/peers returns peer list without publicKey', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/peers' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveLength(2);
    expect(body[0].fingerprint).toBe('peer1fp');
    expect(body[0].online).toBe(true);
    expect(body[0].publicKey).toBeUndefined();
  });

  it('GET /api/states merges own and discovered', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/states' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveLength(2);

    const builders = body.find((s: any) => s.name === 'builders');
    expect(builders).toBeDefined();
    expect(builders.selfMd).toBe('We build things.');
    expect(builders.isPublic).toBe(true);

    const research = body.find((s: any) => s.name === 'research');
    expect(research).toBeDefined();
    expect(research.selfMd).toBe('AI research.');
    expect(research.memberCount).toBe(5);
  });

  it('GET /api/discovery/states returns public states only', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/discovery/states' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveLength(1);
    expect(body[0].name).toBe('research');
    expect(body[0].isPublic).toBe(true);
  });

  it('POST /api/discovery/states/:id/join rejects malformed ids', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/discovery/states/not-hex/join' });
    expect(res.statusCode).toBe(400);
    expect(res.json().reason).toBe('invalid');
  });

  it('POST /api/discovery/states/:id/join blocks non-local browser origins', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/discovery/states/040506/join',
      headers: { origin: 'https://evil.example' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('forbidden-origin');
  });

  it('POST /api/discovery/states/:id/join joins a public state', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/discovery/states/040506/join',
      headers: { origin: 'http://127.0.0.1:3001' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.state.name).toBe('research');
  });

  it('does not expose message content in list endpoints', async () => {
    const statesRes = await app.inject({ method: 'GET', url: '/api/states' });
    expect(statesRes.payload).not.toContain('secret');
  });
});
