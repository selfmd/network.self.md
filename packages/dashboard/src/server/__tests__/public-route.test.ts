import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerClientAssets } from '../static.js';
import { buildApp } from "../routes.js";
import type { Agent } from "@networkselfmd/node";
const agent = {
  listGroups: () => [
    {
      groupId: new Uint8Array([0xaa]),
      name: "Builders",
      isPublic: true,
      memberCount: 2,
      selfMd: "Ask first.",
      joinedAt: 0,
    },
    {
      groupId: new Uint8Array([0xbb]),
      name: "PRIVATE NAME",
      isPublic: false,
      memberCount: 1,
      selfMd: "SECRET",
      joinedAt: 0,
    },
  ],
  listDiscoveredGroups: () => [],
  listPeers: () => [
    {
      fingerprint: "PRIVATE FINGERPRINT",
      displayName: "PRIVATE LABEL",
      online: true,
      lastSeen: 0,
      trusted: false,
    },
  ],
} as unknown as Agent;
describe("public observation HTTP route", () => {
  it("publishes nothing without operator authorization and never caches observations", async () => {
    const app = await buildApp({ agent });
    try {
      const response = await app.inject("/api/public/network");
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json()).toMatchObject({
        states: [],
        peers: [],
        links: [],
      });
      expect(response.body).not.toContain("PRIVATE");
    } finally {
      await app.close();
    }
  });
  it("publishes only exact approved records and context separately", async () => {
    const app = await buildApp({
      agent,
      publication: {
        stateIds: ["aa", "bb"],
        peers: { "PRIVATE FINGERPRINT": { label: "approved agent" } },
      },
    });
    try {
      const response = await app.inject("/api/public/network");
      expect(response.json().states).toEqual([
        {
          id: "aa",
          name: "Builders",
          isPublic: true,
          memberCount: 2,
          selfMd: null,
        },
      ]);
      expect(response.json().peers[0].name).toBe("approved agent");
      expect(response.body).not.toContain("PRIVATE");
      expect(response.body).not.toContain("SECRET");
      expect(response.body).not.toContain("Ask first");
    } finally {
      await app.close();
    }
  });
  it("does not weaken existing server authentication for the public feed", async () => {
    const app = await buildApp({
      agent,
      auth: { username: "owner", password: "a-long-local-password" },
    });
    try {
      expect((await app.inject("/api/public/network")).statusCode).toBe(401);
      const headers = {
        authorization: `Basic ${Buffer.from("owner:a-long-local-password").toString("base64")}`,
      };
      expect(
        (await app.inject({ url: "/api/public/network", headers })).statusCode,
      ).toBe(200);
    } finally {
      await app.close();
    }
  });
});

describe('opt-in anonymous public site', () => {
  const auth = { username: 'operator', password: 'a-long-local-password' };
  it('requires operator auth and an explicit publication policy', async () => {
    await expect(buildApp({ agent, publicSite: true })).rejects.toThrow(/authentication/);
    await expect(buildApp({ agent, auth, publicSite: true })).rejects.toThrow(/publication/);
    await expect(buildApp({ agent, auth, publicSite: true, publication: { stateIds: 'all' } as any })).rejects.toThrow(/stateIds/);
  });
  it('serves allowlisted data and static assets anonymously while every operator API remains private', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dashboard-public-assets-'));
    mkdirSync(join(root, 'assets'));
    writeFileSync(join(root, 'index.html'), '<!doctype html><title>Public site</title>');
    writeFileSync(join(root, 'assets', 'app.js'), '/* public bundle */');
    const app = await buildApp({ agent, auth, publicSite: true, publication: { stateIds: ['aa', 'bb'] } });
    try {
      await registerClientAssets(app, root);
      for (const url of ['/', '/index.html', '/assets/app.js', '/api/public/network', '/api/public/network?view=all']) {
        const response = await app.inject(url);
        expect(response.statusCode, url).toBe(200);
        expect(response.headers['www-authenticate']).toBeUndefined();
        expect(response.body).not.toContain('SECRET');
        expect(response.body).not.toContain('PRIVATE');
        expect(response.body).not.toContain('Ask first');
      }
      const feed = (await app.inject('/api/public/network')).json();
      expect(feed.states.map((s: { id: string }) => s.id)).toEqual(['aa']);
      expect(feed.peers).toEqual([]);
      for (const url of ['/api/status', '/api/identity', '/api/states', '/api/states/bb', '/api/peers', '/api/discovery/states', '/api/wire/events', '/api/security/keys', '/api/public/network/private', '/api/public/network%2f..%2fstatus', '/%61pi/status']) {
        expect((await app.inject(url)).statusCode, url).toBe(401);
      }
      expect((await app.inject({ method: 'POST', url: '/api/discovery/states/aa/join', headers: { origin: 'http://localhost' } })).statusCode).toBe(401);
      expect((await app.inject({ method: 'POST', url: '/api/public/network' })).statusCode).toBe(401);
    } finally {
      await app.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
