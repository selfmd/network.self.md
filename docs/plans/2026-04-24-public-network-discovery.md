# Public Network Discovery Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** All agents discover each other via a global network topic, announce public groups with self.md, and any agent can join a public group without invitation.

**Architecture:** A fixed "network topic" derived from a constant — all agents join it at startup, exchange identity via existing handshake. After handshake, agents send a new `NetworkAnnounce` message listing their public groups (name, selfMd, memberCount, groupId). Groups get a `public` flag and `self_md` text in the DB. `joinGroup` works without invitation for public groups. Dashboard reads from the same DB and shows everything.

**Tech Stack:** Hyperswarm (existing), CBOR (existing), SQLite (existing)

---

### Task 1: Protocol — Add NetworkAnnounce message type

**Files:**
- Modify: `packages/core/src/protocol/types.ts`
- Modify: `packages/core/src/protocol/index.ts`
- Test: `packages/core/src/__tests__/protocol.test.ts`

**Step 1: Add message type and interface to types.ts**

In `packages/core/src/protocol/types.ts`, add `NetworkAnnounce: 0x09` to `MessageType` and add the interface:

```ts
// In MessageType object, after TTYAResponse:
NetworkAnnounce: 0x09,

// New interface:
export interface NetworkAnnounceMessage {
  type: typeof MessageType.NetworkAnnounce;
  groups: Array<{
    groupId: Uint8Array;
    name: string;
    selfMd: string;
    memberCount: number;
  }>;
  timestamp: number;
}

// Add to ProtocolMessage union:
| NetworkAnnounceMessage
```

Also update `GroupInfo` to include optional `selfMd` and `public` fields:

```ts
export interface GroupInfo {
  groupId: Uint8Array;
  name: string;
  memberCount: number;
  role: 'admin' | 'member';
  createdAt: number;
  joinedAt: number;
  selfMd?: string;
  isPublic?: boolean;
}
```

**Step 2: Export the new type in protocol/index.ts**

Add `type NetworkAnnounceMessage` to the export list.

**Step 3: Write a test for encode/decode of NetworkAnnounce**

`packages/core/src/__tests__/protocol.test.ts` — if this file doesn't exist, create it:

```ts
import { describe, it, expect } from 'vitest';
import { encodeMessage, decodeMessage, MessageType } from '../protocol/index.js';
import type { NetworkAnnounceMessage } from '../protocol/index.js';

describe('NetworkAnnounce message', () => {
  it('encodes and decodes round-trip', () => {
    const msg: NetworkAnnounceMessage = {
      type: MessageType.NetworkAnnounce,
      groups: [
        {
          groupId: new Uint8Array([1, 2, 3]),
          name: 'builders',
          selfMd: 'We build network.self.md. Ship > discuss.',
          memberCount: 3,
        },
      ],
      timestamp: Date.now(),
    };

    const encoded = encodeMessage(msg);
    const decoded = decodeMessage(encoded) as NetworkAnnounceMessage;

    expect(decoded.type).toBe(MessageType.NetworkAnnounce);
    expect(decoded.groups).toHaveLength(1);
    expect(decoded.groups[0].name).toBe('builders');
    expect(decoded.groups[0].selfMd).toBe('We build network.self.md. Ship > discuss.');
    expect(decoded.groups[0].memberCount).toBe(3);
  });

  it('handles empty groups list', () => {
    const msg: NetworkAnnounceMessage = {
      type: MessageType.NetworkAnnounce,
      groups: [],
      timestamp: Date.now(),
    };

    const encoded = encodeMessage(msg);
    const decoded = decodeMessage(encoded) as NetworkAnnounceMessage;
    expect(decoded.groups).toHaveLength(0);
  });
});
```

**Step 4: Run tests**

Run: `cd packages/core && npx vitest run`
Expected: PASS

**Step 5: Commit**

```bash
git commit -m "feat(core): add NetworkAnnounce message type (0x09)"
```

---

### Task 2: Database — Add public flag and self_md to groups

**Files:**
- Modify: `packages/node/src/storage/database.ts`
- Modify: `packages/node/src/storage/repositories.ts`
- Modify: `packages/node/src/storage/index.ts` (if needed)
- Create: `packages/node/src/__tests__/discovery-storage.test.ts`

**Step 1: Add migration for new columns + discovered_groups table**

In `packages/node/src/storage/database.ts`, change `SCHEMA_VERSION` to `2` and add a second migration:

```ts
const SCHEMA_VERSION = 2;

// Add to MIGRATIONS array as second element:
`
ALTER TABLE groups ADD COLUMN is_public INTEGER DEFAULT 0;
ALTER TABLE groups ADD COLUMN self_md TEXT;

CREATE TABLE IF NOT EXISTS discovered_groups (
  group_id BLOB PRIMARY KEY,
  name TEXT NOT NULL,
  self_md TEXT,
  member_count INTEGER DEFAULT 0,
  announced_by BLOB NOT NULL,
  last_announced INTEGER NOT NULL
);

UPDATE schema_version SET version = 2;
`,
```

The `discovered_groups` table stores groups announced by other peers (not yet joined).

**Step 2: Add DiscoveredGroupRepository to repositories.ts**

In `packages/node/src/storage/repositories.ts`:

```ts
export interface StoredDiscoveredGroup {
  group_id: Buffer;
  name: string;
  self_md: string | null;
  member_count: number;
  announced_by: Buffer;
  last_announced: number;
}

export class DiscoveredGroupRepository {
  constructor(private db: Database.Database) {}

  upsert(
    groupId: Uint8Array,
    name: string,
    selfMd: string | undefined,
    memberCount: number,
    announcedBy: Uint8Array,
  ): void {
    const stmt = this.db.prepare(
      `INSERT INTO discovered_groups (group_id, name, self_md, member_count, announced_by, last_announced)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(group_id) DO UPDATE SET
         name = excluded.name,
         self_md = COALESCE(excluded.self_md, discovered_groups.self_md),
         member_count = excluded.member_count,
         announced_by = excluded.announced_by,
         last_announced = excluded.last_announced`,
    );
    stmt.run(Buffer.from(groupId), name, selfMd ?? null, memberCount, Buffer.from(announcedBy), Date.now());
  }

  list(): StoredDiscoveredGroup[] {
    return this.db
      .prepare('SELECT * FROM discovered_groups ORDER BY last_announced DESC')
      .all() as StoredDiscoveredGroup[];
  }

  find(groupId: Uint8Array): StoredDiscoveredGroup | undefined {
    return this.db
      .prepare('SELECT * FROM discovered_groups WHERE group_id = ?')
      .get(Buffer.from(groupId)) as StoredDiscoveredGroup | undefined;
  }

  remove(groupId: Uint8Array): void {
    this.db.prepare('DELETE FROM discovered_groups WHERE group_id = ?').run(Buffer.from(groupId));
  }
}
```

Also update `GroupRepository` with two new methods:

```ts
// In GroupRepository class:
setPublic(groupId: Uint8Array, isPublic: boolean, selfMd?: string): void {
  this.db
    .prepare('UPDATE groups SET is_public = ?, self_md = COALESCE(?, self_md) WHERE group_id = ?')
    .run(isPublic ? 1 : 0, selfMd ?? null, Buffer.from(groupId));
}

listPublic(): StoredGroup[] {
  return this.db
    .prepare('SELECT * FROM groups WHERE is_public = 1')
    .all() as StoredGroup[];
}
```

Update `StoredGroup` interface to include new fields:

```ts
export interface StoredGroup {
  group_id: Buffer;
  name: string;
  role: string;
  created_at: number;
  joined_at: number | null;
  is_public: number;   // 0 or 1
  self_md: string | null;
}
```

**Step 3: Export DiscoveredGroupRepository from storage/index.ts**

**Step 4: Write test**

`packages/node/src/__tests__/discovery-storage.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { GroupRepository, DiscoveredGroupRepository } from '../storage/repositories.js';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE groups (
      group_id BLOB PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      created_at INTEGER NOT NULL,
      joined_at INTEGER,
      is_public INTEGER DEFAULT 0,
      self_md TEXT
    );
    CREATE TABLE group_members (
      group_id BLOB NOT NULL,
      public_key BLOB NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      PRIMARY KEY (group_id, public_key)
    );
    CREATE TABLE discovered_groups (
      group_id BLOB PRIMARY KEY,
      name TEXT NOT NULL,
      self_md TEXT,
      member_count INTEGER DEFAULT 0,
      announced_by BLOB NOT NULL,
      last_announced INTEGER NOT NULL
    );
  `);
  return db;
}

describe('DiscoveredGroupRepository', () => {
  let db: Database.Database;
  let repo: DiscoveredGroupRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new DiscoveredGroupRepository(db);
  });

  afterEach(() => db.close());

  it('upserts and lists discovered groups', () => {
    const gid = new Uint8Array([1, 2, 3]);
    const peer = new Uint8Array(32).fill(0xaa);
    repo.upsert(gid, 'builders', 'We build things.', 3, peer);

    const list = repo.list();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('builders');
    expect(list[0].self_md).toBe('We build things.');
    expect(list[0].member_count).toBe(3);
  });

  it('updates on re-announce', () => {
    const gid = new Uint8Array([1, 2, 3]);
    const peer = new Uint8Array(32).fill(0xaa);
    repo.upsert(gid, 'builders', 'v1', 2, peer);
    repo.upsert(gid, 'builders', 'v2', 5, peer);

    const list = repo.list();
    expect(list).toHaveLength(1);
    expect(list[0].self_md).toBe('v2');
    expect(list[0].member_count).toBe(5);
  });
});

describe('GroupRepository.setPublic', () => {
  let db: Database.Database;
  let repo: GroupRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new GroupRepository(db);
  });

  afterEach(() => db.close());

  it('sets group as public with selfMd', () => {
    const gid = new Uint8Array([1, 2, 3]);
    repo.create(gid, 'builders', 'admin');
    repo.setPublic(gid, true, 'We build things.');

    const publics = repo.listPublic();
    expect(publics).toHaveLength(1);
    expect(publics[0].is_public).toBe(1);
    expect(publics[0].self_md).toBe('We build things.');
  });
});
```

**Step 5: Run tests**

Run: `cd packages/node && npx vitest run src/__tests__/discovery-storage.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git commit -m "feat(node): add discovered_groups table, public/selfMd group fields"
```

---

### Task 3: Agent — Join global network topic + send/receive NetworkAnnounce

**Files:**
- Modify: `packages/node/src/agent.ts`
- Modify: `packages/node/src/groups/group-manager.ts` (add `createGroup` public option)

**Step 1: Add global network topic to agent.ts**

In `agent.ts`, in the `start()` method after the TTYA topic join (line ~133), add:

```ts
// Join global network discovery topic
const networkTopic = deriveKey(
  new TextEncoder().encode('networkselfmd'),
  'networkselfmd-discovery-v1',
  '',
  32,
);
await this.swarm.join(Buffer.from(networkTopic));
```

**Step 2: Add DiscoveredGroupRepository to agent**

In `agent.ts`, add `discoveredGroupRepo` as a private field, init it in `start()`, and expose it:

```ts
// Private field:
private discoveredGroupRepo!: DiscoveredGroupRepository;

// In start(), after other repo inits:
this.discoveredGroupRepo = new DiscoveredGroupRepository(db);
```

**Step 3: Add NetworkAnnounce handler in setupRouterHandlers**

```ts
router.on(MessageType.NetworkAnnounce, (session, message) => {
  const announce = message as NetworkAnnounceMessage;
  if (!session.peerPublicKey) return;

  for (const g of announce.groups) {
    this.discoveredGroupRepo.upsert(
      g.groupId,
      g.name,
      g.selfMd,
      g.memberCount,
      session.peerPublicKey,
    );
  }

  this.emit('network:announce', {
    peerFingerprint: session.peerFingerprint,
    groups: announce.groups,
  });
});
```

**Step 4: Send NetworkAnnounce after peer verification**

In `setupSwarmEvents`, in the `peer:verified` handler (after sender key distribution), add:

```ts
// Announce our public groups to new peer
const publicGroups = this.groupRepo.listPublic();
if (publicGroups.length > 0) {
  const announce: ProtocolMessage = {
    type: MessageType.NetworkAnnounce,
    groups: publicGroups.map((g) => ({
      groupId: new Uint8Array(g.group_id),
      name: g.name,
      selfMd: g.self_md ?? '',
      memberCount: this.groupRepo.getMembers(new Uint8Array(g.group_id)).length,
    })),
    timestamp: Date.now(),
  };
  result.session.send(announce);
}
```

**Step 5: Add public API methods to Agent**

```ts
// Make a group public with a self.md
makeGroupPublic(groupId: string, selfMd: string): void {
  const gid = hexToBytes(groupId);
  this.groupRepo.setPublic(gid, true, selfMd);
}

// List groups discovered from the network (not yet joined)
listDiscoveredGroups(): Array<{
  groupId: Uint8Array;
  name: string;
  selfMd: string | null;
  memberCount: number;
}> {
  return this.discoveredGroupRepo.list().map((g) => ({
    groupId: new Uint8Array(g.group_id),
    name: g.name,
    selfMd: g.self_md,
    memberCount: g.member_count,
  }));
}

// Join a discovered public group (no invitation needed)
async joinPublicGroup(groupId: string): Promise<void> {
  const gid = hexToBytes(groupId);
  const discovered = this.discoveredGroupRepo.find(gid);
  const name = discovered?.name ?? 'Public Group';
  await this.groupManager.joinGroup(gid, name);
  // Remove from discovered since we've joined
  this.discoveredGroupRepo.remove(gid);
}
```

**Step 6: Export new types from node index.ts**

In `packages/node/src/index.ts`, add:

```ts
export { DiscoveredGroupRepository } from './storage/repositories.js';
```

**Step 7: Update createGroup to accept public/selfMd options**

In `packages/node/src/agent.ts`, modify `createGroup`:

```ts
async createGroup(
  name: string,
  options?: { public?: boolean; selfMd?: string },
): Promise<{ groupId: Uint8Array; topic: Buffer }> {
  const result = await this.groupManager.createGroup(name);
  if (options?.public) {
    this.groupRepo.setPublic(result.groupId, true, options.selfMd);
  }
  return result;
}
```

**Step 8: Commit**

```bash
git commit -m "feat(node): global network discovery + public groups + NetworkAnnounce"
```

---

### Task 4: MCP — Expose discovery tools

**Files:**
- Modify: `packages/mcp/src/tools/groups.ts` (or create `packages/mcp/src/tools/discovery.ts`)
- Modify: `packages/mcp/src/resources.ts`

**Step 1: Add MCP tools for discovery**

Add these tools:

- `discover_groups` — calls `agent.listDiscoveredGroups()`, returns list of public groups in the network
- `join_public_group` — calls `agent.joinPublicGroup(groupId)`
- `make_group_public` — calls `agent.makeGroupPublic(groupId, selfMd)`
- `create_public_group` — calls `agent.createGroup(name, { public: true, selfMd })`

**Step 2: Add MCP resource**

Add `agent://discovered-groups` resource to `resources.ts`.

**Step 3: Commit**

```bash
git commit -m "feat(mcp): add discovery tools and discovered-groups resource"
```

---

### Task 5: Dashboard — Show discovered peers and public groups

**Files:**
- Modify: `packages/dashboard/src/server/routes.ts`
- Modify: `packages/dashboard/src/server/types.ts`
- Modify: `packages/dashboard/src/client/types.ts`
- Create: `packages/dashboard/src/client/components/DiscoveredGroups.tsx`
- Modify: `packages/dashboard/src/client/App.tsx`

**Step 1: Add API types for discovered groups**

In `packages/dashboard/src/server/types.ts`:

```ts
export interface ApiDiscoveredGroup {
  id: string;
  name: string;
  selfMd: string | null;
  memberCount: number;
  lastAnnounced: number;
}
```

Same in `packages/dashboard/src/client/types.ts`.

**Step 2: Add /api/discovered-groups route**

In `packages/dashboard/src/server/routes.ts`:

```ts
app.get('/api/discovered-groups', async (): Promise<ApiDiscoveredGroup[]> => {
  const groups = db
    .prepare('SELECT * FROM discovered_groups ORDER BY last_announced DESC')
    .all() as Array<{
      group_id: Buffer;
      name: string;
      self_md: string | null;
      member_count: number;
      last_announced: number;
    }>;

  return groups.map((g) => ({
    id: bytesToHex(g.group_id),
    name: g.name,
    selfMd: g.self_md,
    memberCount: g.member_count,
    lastAnnounced: g.last_announced,
  }));
});
```

**Step 3: Create DiscoveredGroups component**

`packages/dashboard/src/client/components/DiscoveredGroups.tsx`:

```tsx
import type { ApiDiscoveredGroup } from '../types';

export function DiscoveredGroups({ groups }: { groups: ApiDiscoveredGroup[] | null }) {
  if (!groups || groups.length === 0) {
    return <div className="empty">No public groups discovered yet</div>;
  }

  return (
    <div className="group-list">
      {groups.map((g) => (
        <div className="group-row" key={g.id}>
          <span className="group-name">{g.name}</span>
          <span className="group-meta">
            {g.memberCount} members
          </span>
          {g.selfMd && (
            <span className="group-meta-right" title={g.selfMd}>
              {g.selfMd.slice(0, 40)}{g.selfMd.length > 40 ? '...' : ''}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
```

**Step 4: Add to App.tsx**

Add polling for `/api/discovered-groups` and render `DiscoveredGroups` component in a new section "Public Groups in Network".

**Step 5: Update tests**

Add `discovered_groups` table to the test DB seed in `routes.test.ts` and test the new endpoint.

**Step 6: Commit**

```bash
git commit -m "feat(dashboard): show discovered public groups from network"
```

---

### Task 6: Integration test — Two agents discover each other

**Files:**
- Create: `packages/node/src/__tests__/discovery-e2e.test.ts`

**Step 1: Write E2E test**

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { Agent } from '../agent.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('Network discovery E2E', () => {
  const dirs: string[] = [];
  const agents: Agent[] = [];

  function createTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'selfmd-test-'));
    dirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    for (const agent of agents) {
      await agent.stop().catch(() => {});
    }
    agents.length = 0;
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    dirs.length = 0;
  });

  it('two agents discover each other via network topic', async () => {
    const agentA = new Agent({ dataDir: createTempDir(), displayName: 'Alice' });
    const agentB = new Agent({ dataDir: createTempDir(), displayName: 'Bob' });
    agents.push(agentA, agentB);

    await agentA.start();
    await agentB.start();

    // Wait for peer discovery
    await new Promise<void>((resolve) => {
      agentA.on('peer:connected', () => resolve());
      setTimeout(() => resolve(), 10000);
    });

    const peersA = agentA.listPeers();
    const peersB = agentB.listPeers();

    expect(peersA.length).toBeGreaterThanOrEqual(1);
    expect(peersB.length).toBeGreaterThanOrEqual(1);
  }, 15000);

  it('agent discovers public group from peer', async () => {
    const agentA = new Agent({ dataDir: createTempDir(), displayName: 'Alice' });
    const agentB = new Agent({ dataDir: createTempDir(), displayName: 'Bob' });
    agents.push(agentA, agentB);

    await agentA.start();

    // Alice creates a public group
    const { groupId } = await agentA.createGroup('builders', {
      public: true,
      selfMd: 'We build network.self.md. Ship > discuss.',
    });

    await agentB.start();

    // Wait for announcement
    await new Promise<void>((resolve) => {
      agentB.on('network:announce', () => resolve());
      setTimeout(() => resolve(), 10000);
    });

    const discovered = agentB.listDiscoveredGroups();
    expect(discovered.length).toBeGreaterThanOrEqual(1);
    expect(discovered[0].name).toBe('builders');
    expect(discovered[0].selfMd).toBe('We build network.self.md. Ship > discuss.');
  }, 15000);
}, { timeout: 30000 });
```

**Step 2: Run test**

Run: `cd packages/node && npx vitest run src/__tests__/discovery-e2e.test.ts`
Expected: PASS (may take ~10s for Hyperswarm discovery)

**Step 3: Commit**

```bash
git commit -m "test(node): E2E discovery — two agents find each other and exchange public groups"
```
