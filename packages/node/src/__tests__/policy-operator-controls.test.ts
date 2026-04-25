import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PrivateInboundMessageEvent } from '@networkselfmd/core';

// Mock the network layer so Agent.start() works without DHT/sockets.
vi.mock('hyperswarm', () => ({
  default: class MockHyperswarm {
    on() {}
    join() { return { flushed: () => Promise.resolve() }; }
    leave() { return Promise.resolve(); }
    destroy() { return Promise.resolve(); }
  },
}));
vi.mock('hyperdht', () => ({ default: class MockHyperDHT {} }));

import { Agent } from '../agent.js';
import { PolicyConfigValidationError } from '../policy/validate-config.js';
import { makeIdentity } from './test-utils/group-harness.js';

interface Harness {
  agent: Agent;
  dataDir: string;
  cleanup: () => Promise<void>;
}

async function startAgent(opts?: { policyConfig?: unknown }): Promise<Harness> {
  const dataDir = mkdtempSync(join(tmpdir(), 'nsmd-policy-ops-'));
  const agent = new Agent({
    dataDir,
    displayName: 'Alice',
    policyConfig: (opts?.policyConfig as never) ?? undefined,
  });
  await agent.start();
  return {
    agent,
    dataDir,
    cleanup: async () => {
      await agent.stop();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

describe('Agent policy operator controls — precedence', () => {
  let h: Harness;
  afterEach(async () => h?.cleanup());

  it('uses AgentOptions.policyConfig when nothing is persisted; does NOT auto-persist', async () => {
    h = await startAgent({
      policyConfig: { interests: ['from-options'] },
    });
    expect(h.agent.getPolicyConfig()).toEqual({ interests: ['from-options'] });
    // Restart: same dataDir, NO policyConfig passed. The first run did
    // not persist, so we expect the default `{}` (NOT 'from-options').
    await h.agent.stop();
    const a2 = new Agent({ dataDir: h.dataDir });
    await a2.start();
    expect(a2.getPolicyConfig()).toEqual({});
    await a2.stop();
  });

  it('persisted config wins on restart even if AgentOptions provides a different one', async () => {
    h = await startAgent({ policyConfig: { interests: ['ignored-on-restart'] } });
    h.agent.setPolicyConfig({ interests: ['persisted'] });
    await h.agent.stop();

    const a2 = new Agent({
      dataDir: h.dataDir,
      // This should be IGNORED because a row exists.
      policyConfig: { interests: ['ignored-on-restart'] },
    });
    await a2.start();
    expect(a2.getPolicyConfig()).toEqual({ interests: ['persisted'] });
    await a2.stop();
  });

  it('defaults to {} when neither persisted nor AgentOptions config is present', async () => {
    h = await startAgent();
    expect(h.agent.getPolicyConfig()).toEqual({});
  });
});

describe('Agent.setPolicyConfig — validation + persistence + live update', () => {
  let h: Harness;
  beforeEach(async () => { h = await startAgent(); });
  afterEach(async () => h.cleanup());

  it('validates input; throws PolicyConfigValidationError on bad shape; does not persist or update on failure', () => {
    expect(() => h.agent.setPolicyConfig({ requireMention: 'no' as unknown as boolean })).toThrow(
      PolicyConfigValidationError,
    );
    expect(h.agent.getPolicyConfig()).toEqual({});
  });

  it('saves to SQLite and updates the live policy on success', async () => {
    h.agent.setPolicyConfig({ trustedFingerprints: ['abcd1234'], interests: ['coffee'] });
    expect(h.agent.getPolicyConfig()).toEqual({
      trustedFingerprints: ['abcd1234'],
      interests: ['coffee'],
    });
    // Restart and confirm persistence.
    await h.agent.stop();
    const a2 = new Agent({ dataDir: h.dataDir });
    await a2.start();
    expect(a2.getPolicyConfig()).toEqual({
      trustedFingerprints: ['abcd1234'],
      interests: ['coffee'],
    });
    await a2.stop();
  });

  it('strips unknown extra fields in input (defence-in-depth at the boundary)', () => {
    h.agent.setPolicyConfig({
      interests: ['x'],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      attackerKey: 'PWNED' as any,
    });
    const cfg = h.agent.getPolicyConfig();
    expect(cfg.interests).toEqual(['x']);
    expect(cfg).not.toHaveProperty('attackerKey');
  });

  it('config update affects AgentPolicy.decide on the very next event (no restart needed)', () => {
    const bob = makeIdentity('Bob');
    h.agent.setPolicyConfig({ requireMention: false });
    const ev: PrivateInboundMessageEvent = {
      kind: 'group',
      messageId: 'm1',
      groupId: new Uint8Array([0xaa]),
      senderPublicKey: bob.edPublicKey,
      senderFingerprint: bob.fingerprint,
      plaintext: new TextEncoder().encode('hi'),
      timestamp: 1,
      receivedAt: 2,
    };
    const decisionA = h.agent.policy.decide(ev);
    expect(decisionA.addressedToMe).toBe(true); // requireMention:false → all addressed

    h.agent.setPolicyConfig({ requireMention: true });
    const decisionB = h.agent.policy.decide(ev);
    expect(decisionB.addressedToMe).toBe(false); // strict mode, no @-mention
  });
});

describe('Agent.updatePolicyConfig — partial merge', () => {
  let h: Harness;
  beforeEach(async () => { h = await startAgent(); });
  afterEach(async () => h.cleanup());

  it('merges partial updates without clearing other fields', () => {
    h.agent.setPolicyConfig({ trustedFingerprints: ['fp1abc'], interests: ['coffee'] });
    h.agent.updatePolicyConfig({ requireMention: true });
    expect(h.agent.getPolicyConfig()).toEqual({
      trustedFingerprints: ['fp1abc'],
      interests: ['coffee'],
      requireMention: true,
    });
  });

  it('rejects non-object partial input', () => {
    expect(() => h.agent.updatePolicyConfig(42)).toThrow(PolicyConfigValidationError);
    expect(() => h.agent.updatePolicyConfig(null)).toThrow(PolicyConfigValidationError);
    expect(() => h.agent.updatePolicyConfig([1])).toThrow(PolicyConfigValidationError);
  });

  it('rejects malformed merged result', () => {
    h.agent.setPolicyConfig({ interests: ['x'] });
    expect(() => h.agent.updatePolicyConfig({ requireMention: 'sometimes' })).toThrow(
      PolicyConfigValidationError,
    );
    // Original config preserved on failure.
    expect(h.agent.getPolicyConfig()).toEqual({ interests: ['x'] });
  });
});

describe('Agent.getPolicyConfig — defensive copy', () => {
  let h: Harness;
  beforeEach(async () => { h = await startAgent(); });
  afterEach(async () => h.cleanup());

  it('returned arrays are independent of the live config', () => {
    h.agent.setPolicyConfig({ interests: ['a', 'b'] });
    const a = h.agent.getPolicyConfig();
    a.interests?.push('hijack');
    expect(h.agent.getPolicyConfig().interests).toEqual(['a', 'b']);
  });
});

describe('Agent.resetPolicyConfig', () => {
  let h: Harness;
  beforeEach(async () => { h = await startAgent({ policyConfig: { interests: ['default'] } }); });
  afterEach(async () => h.cleanup());

  it('clears persisted config and reverts to AgentOptions.policyConfig', async () => {
    h.agent.setPolicyConfig({ interests: ['persisted'] });
    expect(h.agent.getPolicyConfig()).toEqual({ interests: ['persisted'] });
    h.agent.resetPolicyConfig();
    expect(h.agent.getPolicyConfig()).toEqual({ interests: ['default'] });
    // Restart: nothing persisted, falls back to AgentOptions again.
    await h.agent.stop();
    const a2 = new Agent({
      dataDir: h.dataDir,
      policyConfig: { interests: ['default'] },
    });
    await a2.start();
    expect(a2.getPolicyConfig()).toEqual({ interests: ['default'] });
    await a2.stop();
  });
});

describe('Privacy invariant — operator config never carries plaintext', () => {
  let h: Harness;
  beforeEach(async () => { h = await startAgent(); });
  afterEach(async () => h.cleanup());

  it('the persisted row contains zero columns that could hold message content', async () => {
    h.agent.setPolicyConfig({ interests: ['canary-keyword'] });
    // Read the raw row directly to confirm shape.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (h.agent as any).database.getDb();
    const cols = db
      .prepare("PRAGMA table_info(policy_config)")
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    for (const n of names) {
      expect(n).not.toMatch(/plaintext|content|body|private|secret|password/i);
    }
    // The interest keyword IS owner-supplied config and IS persisted —
    // that's the whole point. Verify it's the operator-supplied string,
    // not an exfiltration of message bytes.
    const row = db.prepare('SELECT interests FROM policy_config WHERE id=1').get() as { interests: string };
    expect(JSON.parse(row.interests)).toEqual(['canary-keyword']);
  });
});
