import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
    getGroupMembers: (id: string) => {
      if (id === '010203') {
        return [
          { fingerprint: 'member1fp', displayName: 'Alice', role: 'admin' },
          { fingerprint: 'member2fp', displayName: undefined, role: 'member' },
        ];
      }
      return [];
    },
    getMessages: ({ groupId }: { groupId: string; limit: number }) => {
      if (groupId === '010203') {
        return [
          {
            id: 'msg1',
            senderPublicKey: new Uint8Array(32).fill(1),
            content: 'hello builders',
            timestamp: now,
          },
        ];
      }
      return [];
    },
  };
}

describe('Dashboard API routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ agent: mockAgent() as any });
  });

  afterAll(async () => { await app.close(); });

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

  // --- Identity endpoints ---

  it('GET /api/identity returns fingerprint and displayName', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/identity' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.fingerprint).toBe('abc123');
    expect(body.displayName).toBe('TestAgent');
  });

  // --- State detail endpoint ---

  it('GET /api/states/:id returns detail for an own group', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/states/010203' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.name).toBe('builders');
    expect(body.members).toHaveLength(2);
    expect(body.members[0].role).toBe('admin');
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].content).toBe('hello builders');
  });

  it('GET /api/states/:id returns 404 for unknown id', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/states/ffffff' });
    expect(res.statusCode).toBe(404);
  });

  // --- 501 stub endpoints ---

  it('GET /api/wire/events returns 501', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/wire/events' });
    expect(res.statusCode).toBe(501);
    expect(res.json().error.code).toBe('wire-trace-unavailable');
  });

  it('GET /api/security/keys returns 501', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/security/keys' });
    expect(res.statusCode).toBe(501);
    expect(res.json().error.code).toBe('security-keys-unavailable');
  });
});

describe('Dashboard state identity', () => {
  it('keeps same-name states separate and counts each unique ID', async () => {
    const agent = mockAgent();
    agent.listDiscoveredGroups = () => [{
      groupId: new Uint8Array([4, 5, 6]),
      name: 'builders',
      selfMd: 'A different community.',
      memberCount: 99,
    }];
    const app = await buildApp({ agent: agent as any });
    try {
      const states = (await app.inject('/api/states')).json();
      expect(states).toHaveLength(2);
      expect(states.find((state: any) => state.id === '010203')).toMatchObject({ memberCount: 3, selfMd: 'We build things.' });
      expect(states.find((state: any) => state.id === '040506')).toMatchObject({ memberCount: 99, selfMd: 'A different community.' });
      expect((await app.inject('/api/status')).json().stateCount).toBe(2);
    } finally { await app.close(); }
  });

  it('prefers joined state metadata over a stale announcement for the same ID', async () => {
    const agent = mockAgent();
    agent.listDiscoveredGroups = () => [{
      groupId: new Uint8Array([1, 2, 3]),
      name: 'old builders name',
      selfMd: 'Old rules.',
      memberCount: 99,
    }];
    const app = await buildApp({ agent: agent as any });
    try {
      const states = (await app.inject('/api/states')).json();
      expect(states).toHaveLength(1);
      expect(states[0]).toMatchObject({ id: '010203', name: 'builders', memberCount: 3, selfMd: 'We build things.' });
    } finally { await app.close(); }
  });

  it('returns the joined ID even when another state has the same name', async () => {
    const agent = mockAgent();
    const ownGroups = agent.listGroups;
    agent.listGroups = () => ownGroups().map((group) => ({ ...group, name: 'builders' }));
    agent.listDiscoveredGroups = () => [{
      groupId: new Uint8Array([4, 5, 6]), name: 'builders', selfMd: 'Other rules.', memberCount: 5,
    }];
    const app = await buildApp({ agent: agent as any });
    try {
      const joined = await app.inject({ method: 'POST', url: '/api/discovery/states/040506/join' });
      expect(joined.statusCode).toBe(200);
      expect(joined.json().state.id).toBe('040506');
    } finally { await app.close(); }
  });
});

describe('Dashboard API authentication', () => {
  const credentials = Buffer.from(
    'operator:a-strong-dashboard-password',
    'utf8',
  ).toString('base64');

  it('leaves only the health probe public', async () => {
    const app = await buildApp({
      agent: mockAgent() as any,
      auth: { username: 'operator', password: 'a-strong-dashboard-password' },
    });

    const health = await app.inject({ method: 'GET', url: '/healthz' });
    expect(health.statusCode).toBe(200);

    for (const authorization of [undefined, 'Basic invalid']) {
      const response = await app.inject({
        method: 'GET',
        url: '/api/status',
        headers: authorization ? { authorization } : undefined,
      });
      expect(response.statusCode).toBe(401);
      expect(response.headers['www-authenticate']).toContain('Basic');
      expect(response.json().error.code).toBe('unauthorized');
    }

    const authorized = await app.inject({
      method: 'GET',
      url: '/api/status',
      headers: { authorization: `Basic ${credentials}` },
    });
    expect(authorized.statusCode).toBe(200);
    await app.close();
  });

  it('requires valid credentials before mutation origin checks', async () => {
    const app = await buildApp({
      agent: mockAgent() as any,
      auth: { username: 'operator', password: 'a-strong-dashboard-password' },
    });
    const unauthorized = await app.inject({
      method: 'POST',
      url: '/api/discovery/states/040506/join',
      headers: { origin: 'http://127.0.0.1:3001' },
    });
    expect(unauthorized.statusCode).toBe(401);

    const authorized = await app.inject({
      method: 'POST',
      url: '/api/discovery/states/040506/join',
      headers: {
        origin: 'http://127.0.0.1:3001',
        authorization: `Basic ${credentials}`,
      },
    });
    expect(authorized.statusCode).toBe(200);
    await app.close();
  });
});
