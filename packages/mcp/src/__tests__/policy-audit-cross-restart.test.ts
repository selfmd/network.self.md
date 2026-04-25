import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PolicyAuditEntry, PrivateInboundMessageEvent } from '@networkselfmd/node';

vi.mock('hyperswarm', () => ({
  default: class {
    on() {}
    join() { return { flushed: () => Promise.resolve() }; }
    leave() { return Promise.resolve(); }
    destroy() { return Promise.resolve(); }
  },
}));
vi.mock('hyperdht', () => ({ default: class {} }));

import { Agent } from '@networkselfmd/node';
import { toPolicyAuditDTO } from '../tools/policy.js';

// Adversarial test: a polluted PolicyAuditEntry survives an Agent
// restart on the same dataDir, and the MCP DTO projection STILL drops
// the canary fields. Exercises the full stack: gate → in-memory log →
// persist callback → SQLite policy_audit → reload in a fresh Agent →
// repo.recent() → toPolicyAuditDTO → JSON.stringify.
//
// This is the cross-restart privacy guarantee that PR #6 promises:
// operators can read recent decisions across restart, but never
// content.

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'mcp-cross-restart-'));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function buildEvent(pub: Uint8Array, fp: string, gid: Uint8Array, plaintext: string, mid: string): PrivateInboundMessageEvent {
  return {
    kind: 'group',
    messageId: mid,
    groupId: gid,
    senderPublicKey: pub,
    senderFingerprint: fp,
    plaintext: new TextEncoder().encode(plaintext),
    timestamp: 1,
    receivedAt: 2,
  };
}

describe('Durable audit cross-restart MCP DTO projection', () => {
  it('plaintext canary written via gate is invisible through MCP DTO after restart', { timeout: 20000 }, async () => {
    const canary = 'XRESTART-MCP-PLAINTEXT-CANARY-7q';

    // ---- run 1: persist a real event with a plaintext canary ----
    const a1 = new Agent({
      dataDir,
      displayName: 'Alice',
      policyConfig: { requireMention: false, mentionPrefixLen: 8 },
    });
    await a1.start();

    // Seed a group + a member (Bob) so the gate accepts the event.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const groupRepo = (a1 as any).groupRepo;
    const groupId = new Uint8Array(32).fill(0xab);
    groupRepo.create(groupId, 'xrestart', 'admin');
    groupRepo.addMember(groupId, a1.identity.edPublicKey, 'admin');

    // Build a fake "Bob" identity by reading from the agent's own
    // fingerprint-from-key helper (already exercised in earlier tests).
    const bobPub = new Uint8Array(32).fill(0x42);
    const bobFp = 'b'.repeat(20);
    groupRepo.addMember(groupId, bobPub, 'member');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (a1 as any).groupManager.emit(
      'inbound:message',
      buildEvent(bobPub, bobFp, groupId, `head ${canary} tail`, 'm-canary'),
    );
    expect(a1.policyAuditRepo.count()).toBe(1);
    await a1.stop();

    // ---- run 2: fresh Agent on the same dataDir ----
    const a2 = new Agent({
      dataDir,
      displayName: 'Alice',
      policyConfig: { requireMention: false, mentionPrefixLen: 8 },
    });
    await a2.start();

    // Read through the durable repo, then project through the MCP DTO
    // exactly as the MCP tool does, and serialize.
    const dtos = a2.policyAuditRepo.recent({ limit: 10 }).map(toPolicyAuditDTO);
    expect(dtos).toHaveLength(1);
    expect(dtos[0].messageId).toBe('m-canary');
    expect(dtos[0].byteLength).toBe(`head ${canary} tail`.length);

    const serialized = JSON.stringify({ entries: dtos });
    expect(serialized).not.toContain(canary);
    expect(serialized).not.toContain('head ');
    expect(serialized).not.toContain(' tail');

    // Pollution canaries on a PolicyAuditEntry mocked at the DTO layer
    // are also dropped — we re-verify by reading the raw row, then
    // round-tripping it as if it had attacker fields.
    const entries = a2.policyAuditRepo.recent({ limit: 1 });
    const pollutedEntry = {
      ...entries[0],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      plaintext: 'POLLUTED-PLAINTEXT' as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      privateKey: 'POLLUTED-KEY' as any,
    } as PolicyAuditEntry;
    const pollutedDto = toPolicyAuditDTO(pollutedEntry);
    expect(JSON.stringify(pollutedDto)).not.toContain('POLLUTED-PLAINTEXT');
    expect(JSON.stringify(pollutedDto)).not.toContain('POLLUTED-KEY');

    await a2.stop();
  });

  it('polluted entry returns from repo without the pollution fields', { timeout: 20000 }, async () => {
    const a = new Agent({
      dataDir,
      displayName: 'Alice',
      policyConfig: { requireMention: false },
    });
    await a.start();

    // Insert a polluted entry directly via the repo. This skips the
    // gate; the assertion is that the repo's projection plus
    // toPolicyAuditDTO still drop the bad fields.
    a.policyAuditRepo.insert({
      auditId: 'pollute-1',
      receivedAt: 1,
      eventKind: 'group',
      messageId: 'mp',
      groupIdHex: 'aa',
      senderFingerprint: 'fp',
      byteLength: 8,
      action: 'ask',
      reason: 'addressed-unknown-sender',
      addressedToMe: true,
      senderTrusted: false,
      matchedInterests: [],
      gateRejected: false,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      plaintext: 'INSERT-POLLUTE-PLAINTEXT' as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      decryptedBody: 'INSERT-POLLUTE-BODY' as any,
    } as PolicyAuditEntry);

    const dtos = a.policyAuditRepo.recent({ limit: 5 }).map(toPolicyAuditDTO);
    const json = JSON.stringify(dtos);
    expect(json).not.toContain('INSERT-POLLUTE-PLAINTEXT');
    expect(json).not.toContain('INSERT-POLLUTE-BODY');
    expect(dtos[0]).not.toHaveProperty('plaintext');
    expect(dtos[0]).not.toHaveProperty('decryptedBody');
    await a.stop();
  });
});
