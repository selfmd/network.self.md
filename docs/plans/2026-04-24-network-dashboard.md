# Network Dashboard Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** New `packages/dashboard` package — a React (Vite) SPA that shows network status: online agents, groups, recent activity metadata. Polling-based data refresh.

**Architecture:** Fastify server with JSON API routes + Vite-built React SPA served as static files. The server instantiates `Agent` from `@networkselfmd/node`, exposes 4 read-only API endpoints, and serves the React build. No WebSocket — frontend polls `/api/*` every 5 seconds.

**Tech Stack:** React 18 + Vite, Fastify, `@networkselfmd/node`, TypeScript

---

### Task 1: Scaffold Package

**Files:**
- Create: `packages/dashboard/package.json`
- Create: `packages/dashboard/tsconfig.json` (server)
- Create: `packages/dashboard/tsconfig.client.json` (React/Vite)
- Create: `packages/dashboard/vite.config.ts`
- Create: `packages/dashboard/src/server/index.ts` (empty entry)
- Create: `packages/dashboard/src/client/main.tsx` (empty entry)
- Create: `packages/dashboard/index.html` (Vite entry)

**Step 1: Create package.json**

```json
{
  "name": "@networkselfmd/dashboard",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "scripts": {
    "dev": "concurrently \"vite\" \"tsx watch src/server/index.ts\"",
    "build": "vite build && tsc -p tsconfig.json",
    "preview": "tsx src/server/index.ts",
    "test": "vitest run"
  },
  "dependencies": {
    "@networkselfmd/node": "workspace:*",
    "fastify": "^5.2.0",
    "@fastify/static": "^8.1.0",
    "@fastify/cors": "^10.0.0",
    "react": "^18.3.0",
    "react-dom": "^18.3.0"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "vitest": "^3.1.0",
    "@types/node": "^22.0.0",
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.0",
    "vite": "^6.3.0",
    "tsx": "^4.19.0",
    "concurrently": "^9.1.0"
  }
}
```

**Step 2: Create tsconfig.json (server)**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "strict": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "outDir": "dist/server",
    "rootDir": "src/server"
  },
  "include": ["src/server"]
}
```

**Step 3: Create tsconfig.client.json (React)**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true
  },
  "include": ["src/client"]
}
```

**Step 4: Create vite.config.ts**

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  root: '.',
  build: {
    outDir: 'dist/client',
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
});
```

**Step 5: Create index.html**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>SelfMD Network</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/client/main.tsx"></script>
  </body>
</html>
```

**Step 6: Create placeholder server entry**

`packages/dashboard/src/server/index.ts`:
```ts
console.log('dashboard server placeholder');
```

**Step 7: Create placeholder client entry**

`packages/dashboard/src/client/main.tsx`:
```tsx
import { createRoot } from 'react-dom/client';

function App() {
  return <div>dashboard</div>;
}

createRoot(document.getElementById('root')!).render(<App />);
```

**Step 8: Install dependencies**

Run: `cd /Users/sh/code/network.self.md && pnpm install`
Expected: lockfile updated, no errors

**Step 9: Verify Vite starts**

Run: `cd packages/dashboard && npx vite --port 5173 &` then open http://localhost:5173
Expected: page shows "dashboard"

**Step 10: Commit**

```bash
git add packages/dashboard/
git commit -m "feat(dashboard): scaffold package with Vite + Fastify"
```

---

### Task 2: API Server — 4 Endpoints

**Files:**
- Create: `packages/dashboard/src/server/index.ts`
- Create: `packages/dashboard/src/server/routes.ts`
- Create: `packages/dashboard/src/server/types.ts`
- Test: `packages/dashboard/src/server/__tests__/routes.test.ts`

**Step 1: Define API response types**

`packages/dashboard/src/server/types.ts`:
```ts
export interface ApiStatus {
  agentFingerprint: string;
  agentDisplayName?: string;
  peersOnline: number;
  peersTotal: number;
  groupCount: number;
  uptime: number;
}

export interface ApiPeer {
  fingerprint: string;
  displayName?: string;
  online: boolean;
  lastSeen: number;
  trusted: boolean;
}

export interface ApiGroup {
  id: string;
  name: string;
  memberCount: number;
  role: 'admin' | 'member';
  lastActivity: number;
}

export interface ApiActivity {
  timestamp: number;
  type: 'message' | 'peer_connected' | 'peer_disconnected' | 'group_joined' | 'heartbeat';
  actor?: string;       // fingerprint
  actorName?: string;   // displayName
  target?: string;      // group name or peer fingerprint
}
```

**Step 2: Write failing test for routes**

`packages/dashboard/src/server/__tests__/routes.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildApp } from '../routes.js';

function mockAgent() {
  const startedAt = Date.now() - 60000;
  return {
    identity: {
      fingerprint: 'abc123',
      displayName: 'TestAgent',
      edPublicKey: new Uint8Array(32),
    },
    isRunning: true,
    listPeers: vi.fn().mockReturnValue([
      {
        fingerprint: 'peer1',
        displayName: 'Hermes',
        online: true,
        lastSeen: Date.now(),
        trusted: true,
        publicKey: new Uint8Array(32),
      },
      {
        fingerprint: 'peer2',
        displayName: null,
        online: false,
        lastSeen: Date.now() - 7200000,
        trusted: false,
        publicKey: new Uint8Array(32),
      },
    ]),
    listGroups: vi.fn().mockReturnValue([
      {
        groupId: new Uint8Array([1, 2, 3]),
        name: 'Main',
        memberCount: 2,
        role: 'admin' as const,
        createdAt: Date.now() - 86400000,
        joinedAt: Date.now() - 86400000,
      },
    ]),
    getMessages: vi.fn().mockReturnValue([
      {
        id: 'msg1',
        groupId: new Uint8Array([1, 2, 3]),
        senderPublicKey: new Uint8Array(32),
        content: 'secret content',
        timestamp: Date.now() - 300000,
        type: 'group',
      },
    ]),
    _startedAt: startedAt,
  };
}

describe('API routes', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let agent: ReturnType<typeof mockAgent>;

  beforeEach(async () => {
    agent = mockAgent();
    app = await buildApp(agent as any);
  });

  it('GET /api/status returns network status', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/status' });
    const body = res.json();
    expect(res.statusCode).toBe(200);
    expect(body.agentFingerprint).toBe('abc123');
    expect(body.peersOnline).toBe(1);
    expect(body.peersTotal).toBe(2);
    expect(body.groupCount).toBe(1);
  });

  it('GET /api/peers returns peer list', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/peers' });
    const body = res.json();
    expect(res.statusCode).toBe(200);
    expect(body).toHaveLength(2);
    expect(body[0].fingerprint).toBe('peer1');
    expect(body[0].online).toBe(true);
  });

  it('GET /api/groups returns group list', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/groups' });
    const body = res.json();
    expect(res.statusCode).toBe(200);
    expect(body).toHaveLength(1);
    expect(body[0].name).toBe('Main');
    expect(body[0].id).toBeDefined();
  });

  it('GET /api/activity returns metadata without message content', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/activity' });
    const body = res.json();
    expect(res.statusCode).toBe(200);
    expect(body[0].type).toBe('message');
    expect(body[0]).not.toHaveProperty('content');
  });
});
```

**Step 3: Run test to verify it fails**

Run: `cd packages/dashboard && npx vitest run src/server/__tests__/routes.test.ts`
Expected: FAIL — `Cannot find module '../routes.js'`

**Step 4: Implement routes**

`packages/dashboard/src/server/routes.ts`:
```ts
import Fastify from 'fastify';
import cors from '@fastify/cors';
import type { Agent } from '@networkselfmd/node';
import type { ApiStatus, ApiPeer, ApiGroup, ApiActivity } from './types.js';

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function buildApp(agent: Agent & { _startedAt?: number }) {
  const app = Fastify();
  await app.register(cors);

  app.get('/api/status', async (): Promise<ApiStatus> => {
    const peers = agent.listPeers();
    return {
      agentFingerprint: agent.identity.fingerprint,
      agentDisplayName: agent.identity.displayName,
      peersOnline: peers.filter((p) => p.online).length,
      peersTotal: peers.length,
      groupCount: agent.listGroups().length,
      uptime: Date.now() - (agent._startedAt ?? Date.now()),
    };
  });

  app.get('/api/peers', async (): Promise<ApiPeer[]> => {
    return agent.listPeers().map((p) => ({
      fingerprint: p.fingerprint,
      displayName: p.displayName,
      online: p.online,
      lastSeen: p.lastSeen,
      trusted: p.trusted,
    }));
  });

  app.get('/api/groups', async (): Promise<ApiGroup[]> => {
    const groups = agent.listGroups();
    return groups.map((g) => {
      const messages = agent.getMessages({
        groupId: bytesToHex(g.groupId),
        limit: 1,
      });
      return {
        id: bytesToHex(g.groupId),
        name: g.name,
        memberCount: g.memberCount,
        role: g.role,
        lastActivity: messages[0]?.timestamp ?? g.createdAt,
      };
    });
  });

  app.get('/api/activity', async (): Promise<ApiActivity[]> => {
    const messages = agent.getMessages({ limit: 50 });
    const peers = agent.listPeers();
    const peerMap = new Map(peers.map((p) => [p.fingerprint, p]));

    return messages.map((m) => {
      const senderFp = m.senderPublicKey
        ? peers.find((p) => bytesToHex(p.publicKey) === bytesToHex(m.senderPublicKey!))?.fingerprint
        : undefined;
      const senderPeer = senderFp ? peerMap.get(senderFp) : undefined;

      const groupId = m.groupId ? bytesToHex(m.groupId) : undefined;
      const group = groupId
        ? agent.listGroups().find((g) => bytesToHex(g.groupId) === groupId)
        : undefined;

      return {
        timestamp: m.timestamp,
        type: 'message' as const,
        actor: senderFp,
        actorName: senderPeer?.displayName,
        target: group?.name ?? (m.type === 'direct' ? 'DM' : undefined),
      };
    });
  });

  return app;
}
```

**Step 5: Run tests**

Run: `cd packages/dashboard && npx vitest run src/server/__tests__/routes.test.ts`
Expected: PASS (4 tests)

**Step 6: Implement server entry with Agent**

`packages/dashboard/src/server/index.ts`:
```ts
import { Agent } from '@networkselfmd/node';
import fastifyStatic from '@fastify/static';
import { buildApp } from './routes.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const dataDir = process.env.L2S_DATA_DIR ?? resolve(
  process.env.HOME ?? '.',
  '.networkselfmd',
);

const agent = new Agent({
  dataDir,
  displayName: process.env.AGENT_NAME,
});

(agent as any)._startedAt = Date.now();

async function main() {
  await agent.start();
  console.log(`Agent: ${agent.identity.fingerprint}`);

  const app = await buildApp(agent);

  // Serve React build if it exists
  const clientDir = resolve(__dirname, '../client');
  if (existsSync(clientDir)) {
    await app.register(fastifyStatic, {
      root: clientDir,
      wildcard: false,
    });

    // SPA fallback
    app.setNotFoundHandler(async (_req, reply) => {
      return reply.sendFile('index.html');
    });
  }

  const port = parseInt(process.env.PORT ?? '3001', 10);
  await app.listen({ port, host: '0.0.0.0' });
  console.log(`Dashboard: http://localhost:${port}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

**Step 7: Commit**

```bash
git add packages/dashboard/src/server/
git commit -m "feat(dashboard): API server with /status, /peers, /groups, /activity"
```

---

### Task 3: React Dashboard UI — Layout + Status Bar

**Files:**
- Create: `packages/dashboard/src/client/main.tsx`
- Create: `packages/dashboard/src/client/App.tsx`
- Create: `packages/dashboard/src/client/hooks/usePolling.ts`
- Create: `packages/dashboard/src/client/components/StatusBar.tsx`
- Create: `packages/dashboard/src/client/style.css`
- Create: `packages/dashboard/src/client/types.ts`

**Step 1: Create shared client types**

`packages/dashboard/src/client/types.ts`:
```ts
export interface ApiStatus {
  agentFingerprint: string;
  agentDisplayName?: string;
  peersOnline: number;
  peersTotal: number;
  groupCount: number;
  uptime: number;
}

export interface ApiPeer {
  fingerprint: string;
  displayName?: string;
  online: boolean;
  lastSeen: number;
  trusted: boolean;
}

export interface ApiGroup {
  id: string;
  name: string;
  memberCount: number;
  role: 'admin' | 'member';
  lastActivity: number;
}

export interface ApiActivity {
  timestamp: number;
  type: 'message' | 'peer_connected' | 'peer_disconnected' | 'group_joined' | 'heartbeat';
  actor?: string;
  actorName?: string;
  target?: string;
}
```

**Step 2: Create polling hook**

`packages/dashboard/src/client/hooks/usePolling.ts`:
```ts
import { useState, useEffect, useCallback } from 'react';

export function usePolling<T>(url: string, intervalMs: number = 5000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${res.status}`);
      setData(await res.json());
      setError(null);
    } catch (err: any) {
      setError(err.message);
    }
  }, [url]);

  useEffect(() => {
    fetchData();
    const id = setInterval(fetchData, intervalMs);
    return () => clearInterval(id);
  }, [fetchData, intervalMs]);

  return { data, error };
}
```

**Step 3: Create styles**

`packages/dashboard/src/client/style.css`:
```css
* { margin: 0; padding: 0; box-sizing: border-box; }

body {
  font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', monospace;
  background: #0a0a0a;
  color: #e0e0e0;
  min-height: 100vh;
}

.dashboard {
  max-width: 720px;
  margin: 0 auto;
  padding: 24px 16px;
}

.header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 32px;
  padding-bottom: 16px;
  border-bottom: 1px solid #222;
}

.header h1 {
  font-size: 18px;
  font-weight: 600;
  color: #fff;
}

.header .fingerprint {
  font-size: 12px;
  color: #666;
}

.status-bar {
  display: flex;
  gap: 24px;
  margin-bottom: 32px;
  padding: 16px;
  background: #111;
  border-radius: 8px;
  border: 1px solid #1a1a1a;
}

.stat {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.stat-value {
  font-size: 24px;
  font-weight: 700;
  color: #fff;
}

.stat-label {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: #666;
}

.section {
  margin-bottom: 28px;
}

.section-title {
  font-size: 13px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: #888;
  margin-bottom: 12px;
}

.peer-list, .group-list, .activity-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.peer-row, .group-row, .activity-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  background: #111;
  border-radius: 6px;
  font-size: 13px;
}

.peer-row:hover, .group-row:hover, .activity-row:hover {
  background: #161616;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.dot.online { background: #22c55e; }
.dot.offline { background: #333; }

.peer-name {
  font-weight: 500;
  color: #fff;
}

.peer-fp {
  color: #555;
  font-size: 11px;
}

.peer-meta {
  margin-left: auto;
  color: #444;
  font-size: 11px;
}

.group-name {
  font-weight: 500;
  color: #fff;
}

.group-meta {
  color: #555;
  font-size: 12px;
}

.group-meta-right {
  margin-left: auto;
  color: #444;
  font-size: 11px;
}

.activity-time {
  color: #444;
  font-size: 11px;
  min-width: 48px;
}

.activity-actor {
  font-weight: 500;
  color: #ccc;
}

.activity-detail {
  color: #555;
}

.error-banner {
  padding: 12px;
  background: #1a0000;
  border: 1px solid #330000;
  border-radius: 6px;
  color: #ff4444;
  font-size: 13px;
  margin-bottom: 16px;
}

.empty {
  padding: 24px;
  text-align: center;
  color: #333;
  font-size: 13px;
}
```

**Step 4: Create StatusBar component**

`packages/dashboard/src/client/components/StatusBar.tsx`:
```tsx
import type { ApiStatus } from '../types';

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function StatusBar({ status }: { status: ApiStatus | null }) {
  if (!status) return null;

  return (
    <div className="status-bar">
      <div className="stat">
        <span className="stat-value">{status.peersOnline}</span>
        <span className="stat-label">Online</span>
      </div>
      <div className="stat">
        <span className="stat-value">{status.peersTotal}</span>
        <span className="stat-label">Peers</span>
      </div>
      <div className="stat">
        <span className="stat-value">{status.groupCount}</span>
        <span className="stat-label">Groups</span>
      </div>
      <div className="stat">
        <span className="stat-value">{formatUptime(status.uptime)}</span>
        <span className="stat-label">Uptime</span>
      </div>
    </div>
  );
}
```

**Step 5: Commit**

```bash
git add packages/dashboard/src/client/
git commit -m "feat(dashboard): layout, status bar, polling hook, styles"
```

---

### Task 4: React Dashboard UI — Peers, Groups, Activity

**Files:**
- Create: `packages/dashboard/src/client/components/PeerList.tsx`
- Create: `packages/dashboard/src/client/components/GroupList.tsx`
- Create: `packages/dashboard/src/client/components/ActivityFeed.tsx`
- Create: `packages/dashboard/src/client/App.tsx`
- Modify: `packages/dashboard/src/client/main.tsx`

**Step 1: Create PeerList**

`packages/dashboard/src/client/components/PeerList.tsx`:
```tsx
import type { ApiPeer } from '../types';

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function PeerList({ peers }: { peers: ApiPeer[] | null }) {
  if (!peers || peers.length === 0) {
    return <div className="empty">No peers discovered yet</div>;
  }

  const sorted = [...peers].sort((a, b) => {
    if (a.online !== b.online) return a.online ? -1 : 1;
    return b.lastSeen - a.lastSeen;
  });

  return (
    <div className="peer-list">
      {sorted.map((p) => (
        <div className="peer-row" key={p.fingerprint}>
          <span className={`dot ${p.online ? 'online' : 'offline'}`} />
          <span className="peer-name">{p.displayName ?? 'unnamed'}</span>
          <span className="peer-fp">({p.fingerprint.slice(0, 8)}...)</span>
          <span className="peer-meta">
            {p.online ? 'connected' : timeAgo(p.lastSeen)}
          </span>
        </div>
      ))}
    </div>
  );
}
```

**Step 2: Create GroupList**

`packages/dashboard/src/client/components/GroupList.tsx`:
```tsx
import type { ApiGroup } from '../types';

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function GroupList({ groups }: { groups: ApiGroup[] | null }) {
  if (!groups || groups.length === 0) {
    return <div className="empty">No groups yet</div>;
  }

  return (
    <div className="group-list">
      {groups.map((g) => (
        <div className="group-row" key={g.id}>
          <span className="group-name">{g.name}</span>
          <span className="group-meta">
            {g.memberCount} members &middot; {g.role}
          </span>
          <span className="group-meta-right">
            {timeAgo(g.lastActivity)}
          </span>
        </div>
      ))}
    </div>
  );
}
```

**Step 3: Create ActivityFeed**

`packages/dashboard/src/client/components/ActivityFeed.tsx`:
```tsx
import type { ApiActivity } from '../types';

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function ActivityFeed({ activity }: { activity: ApiActivity[] | null }) {
  if (!activity || activity.length === 0) {
    return <div className="empty">No activity yet</div>;
  }

  return (
    <div className="activity-list">
      {activity.slice(0, 20).map((a, i) => (
        <div className="activity-row" key={`${a.timestamp}-${i}`}>
          <span className="activity-time">{formatTime(a.timestamp)}</span>
          <span className="activity-actor">{a.actorName ?? a.actor?.slice(0, 8) ?? '?'}</span>
          <span className="activity-detail">
            {a.type === 'message' && a.target ? `\u2192 ${a.target}: message` : a.type}
          </span>
        </div>
      ))}
    </div>
  );
}
```

**Step 4: Create App**

`packages/dashboard/src/client/App.tsx`:
```tsx
import { usePolling } from './hooks/usePolling';
import { StatusBar } from './components/StatusBar';
import { PeerList } from './components/PeerList';
import { GroupList } from './components/GroupList';
import { ActivityFeed } from './components/ActivityFeed';
import type { ApiStatus, ApiPeer, ApiGroup, ApiActivity } from './types';

export function App() {
  const { data: status, error } = usePolling<ApiStatus>('/api/status');
  const { data: peers } = usePolling<ApiPeer[]>('/api/peers');
  const { data: groups } = usePolling<ApiGroup[]>('/api/groups');
  const { data: activity } = usePolling<ApiActivity[]>('/api/activity');

  return (
    <div className="dashboard">
      <div className="header">
        <h1>SelfMD Network</h1>
        {status && (
          <span className="fingerprint">
            {status.agentDisplayName ?? status.agentFingerprint.slice(0, 12)}
          </span>
        )}
      </div>

      {error && <div className="error-banner">API error: {error}</div>}

      <StatusBar status={status} />

      <div className="section">
        <div className="section-title">Agents</div>
        <PeerList peers={peers} />
      </div>

      <div className="section">
        <div className="section-title">Groups</div>
        <GroupList groups={groups} />
      </div>

      <div className="section">
        <div className="section-title">Recent Activity</div>
        <ActivityFeed activity={activity} />
      </div>
    </div>
  );
}
```

**Step 5: Update main.tsx**

`packages/dashboard/src/client/main.tsx`:
```tsx
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './style.css';

createRoot(document.getElementById('root')!).render(<App />);
```

**Step 6: Start dev and verify UI renders**

Run: `cd packages/dashboard && npx vite --port 5173`
Open: http://localhost:5173
Expected: Dark dashboard with "API error" banner (server not running), layout renders

**Step 7: Commit**

```bash
git add packages/dashboard/src/client/
git commit -m "feat(dashboard): peers, groups, activity components"
```

---

### Task 5: Integration — Full Dev Flow

**Files:**
- Modify: `packages/dashboard/package.json` (verify scripts)

**Step 1: Build and test everything**

Run: `cd /Users/sh/code/network.self.md && pnpm build`
Expected: All packages compile

**Step 2: Run dashboard tests**

Run: `cd packages/dashboard && npx vitest run`
Expected: All route tests pass

**Step 3: Run full dev stack**

Terminal 1: `cd packages/dashboard && npx tsx src/server/index.ts`
Terminal 2: `cd packages/dashboard && npx vite --port 5173`
Open: http://localhost:5173
Expected: Dashboard loads, polls API, shows agent status + empty peer/group lists (no peers connected locally)

**Step 4: Final commit**

```bash
git add -A packages/dashboard/
git commit -m "feat(dashboard): complete network dashboard v1"
```
