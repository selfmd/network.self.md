import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DoubleRatchet, DELIVERY_TTL_MS, computeSharedSecret, encrypt, generateIdentity, signAuthenticatedMessage } from '@networkselfmd/core';
import type { AgentIdentity, DirectEncryptedMessage } from '@networkselfmd/core';
import { Agent } from '../agent.js';
import { AgentDatabase, IdentityRepository, MessageRepository, ProtocolReplayRepository, RatchetStateRepository } from '../storage/index.js';
import { DM_BOOTSTRAP_WINDOW_MS } from '../network/direct-ratchet.js';

const directories: string[] = [];
const databases: AgentDatabase[] = [];
afterEach(() => {
  vi.useRealTimers();
  databases.splice(0).forEach(db => { try { db.close(); } catch {} });
  directories.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true }));
});

function runtime(identity: AgentIdentity, peer: AgentIdentity, existingDir?: string, protectedIdentity = false) {
  const dir = existingDir ?? mkdtempSync(join(tmpdir(), 'nsmd-dm-collision-'));
  if (!existingDir) directories.push(dir);
  const database = new AgentDatabase(dir);
  database.migrate();
  databases.push(database);
  const db = database.getDb();
  const identities = new IdentityRepository(db);
  if (protectedIdentity) {
    const wrapped = encrypt(new Uint8Array(32).fill(7), identity.edPrivateKey);
    identities.createEncrypted(identity.edPublicKey, identity.displayName, new Uint8Array(16), wrapped.nonce, wrapped.ciphertext);
  } else {
    identities.createPlaintext(identity.edPrivateKey, identity.edPublicKey, identity.displayName);
  }
  const ratchets = new RatchetStateRepository(db);
  const outgoing: DirectEncryptedMessage[] = [];
  const errors = vi.fn();
  const agent = new Agent({ dataDir: dir });
  Object.assign(agent, {
    identity: { ...identity }, isRunning: true, database, identityRepo: identities,
    ratchetStateRepo: ratchets, protocolReplayRepo: new ProtocolReplayRepository(db),
    messageRepo: new MessageRepository(db),
    swarm: { getSession: () => ({ peerXPublicKey: peer.xPublicKey, send: (message: DirectEncryptedMessage) => outgoing.push(message) }) },
  });
  agent.removeAllListeners('error');
  agent.on('error', errors);
  const session = { state: 'ready', peerFingerprint: peer.fingerprint, peerPublicKey: peer.edPublicKey, peerXPublicKey: peer.xPublicKey };
  return {
    agent, database, ratchets, outgoing, errors, dir, identities,
    // Exercise the raw authenticated ratchet path independently of the new
    // delivery queue; reliable outbox behavior has its own integration suite.
    send: async (text: string, lifetime = DM_BOOTSTRAP_WINDOW_MS) => {
      outgoing.push((agent as any).encryptQueuedDirectMessage({ content: text, expires_at: Date.now() + lifetime }, session));
      new MessageRepository(db).insert({ id: randomUUID(), peerPublicKey: peer.edPublicKey,
        senderPublicKey: identity.edPublicKey, content: text, timestamp: Date.now(), type: 'direct' });
    },
    receive: (message: DirectEncryptedMessage) => (agent as any).handleDirectMessage(session, message),
    messages: () => agent.getMessages({ peerPublicKey: Buffer.from(peer.edPublicKey).toString('hex') }),
    state: () => db.prepare('SELECT state_json FROM dm_ratchet_states WHERE peer_fingerprint = ?').get(peer.fingerprint),
  };
}

function pair() {
  const [low, high] = [generateIdentity(), generateIdentity()].sort((a, b) => a.fingerprint < b.fingerprint ? -1 : 1);
  return { low, high, a: runtime(low, high), b: runtime(high, low) };
}

function resign(message: DirectEncryptedMessage, identity: AgentIdentity) {
  const { signature: _, ...unsigned } = message;
  return signAuthenticatedMessage<DirectEncryptedMessage>({ ...unsigned, timestamp: Date.now() }, identity.edPrivateKey);
}

describe('simultaneous direct-message initialization', () => {
  it('keeps reliable first-send eligibility across a two-day disconnect and restart', async () => {
    vi.useFakeTimers();
    const { low, high, a, b } = pair();
    await Promise.all([a.send('a initial', DELIVERY_TTL_MS), b.send('b initial', DELIVERY_TTL_MS)]);
    const expiresAt = Date.now() + DELIVERY_TTL_MS;
    expect(a.ratchets.loadSession(high.fingerprint)!.initialReceiver!.expiresAt).toBe(expiresAt);
    a.database.close();
    b.database.close();
    vi.setSystemTime(Date.now() + 2 * 24 * 60 * 60 * 1000);
    const resumedA = runtime(low, high, a.dir);
    const resumedB = runtime(high, low, b.dir);
    expect(resumedA.ratchets.loadSession(high.fingerprint)!.initialReceiver!.expiresAt).toBe(expiresAt);
    // The reliable transport refreshes signatures, preserving ciphertext.
    resumedA.receive(resign(b.outgoing[0], high));
    resumedB.receive(resign(a.outgoing[0], low));
    await resumedB.send('canonical reply', DELIVERY_TTL_MS);
    resumedA.receive(resumedB.outgoing[0]);
    await resumedA.send('after convergence', DELIVERY_TTL_MS);
    resumedB.receive(resumedA.outgoing[0]);
    expect(resumedA.errors).not.toHaveBeenCalled();
    expect(resumedB.errors).not.toHaveBeenCalled();
    for (const endpoint of [resumedA, resumedB]) {
      expect(endpoint.messages().map(message => message.content).sort())
        .toEqual(['a initial', 'after convergence', 'b initial', 'canonical reply']);
    }
  });

  it('persists only bootstrap eligibility with protected identities and survives restart before either first delivery', async () => {
    const [low, high] = [generateIdentity(), generateIdentity()].sort((a, b) => a.fingerprint < b.fingerprint ? -1 : 1);
    const a = runtime(low, high, undefined, true);
    const b = runtime(high, low, undefined, true);
    await Promise.all([a.send('a0'), b.send('b0')]);
    for (const [endpoint, identity, peer] of [[a, low, high], [b, high, low]] as const) {
      const saved = JSON.stringify(endpoint.state());
      expect(endpoint.identities.load()!.ed_private_key).toBeNull();
      expect(saved).not.toContain(Buffer.from(identity.xPrivateKey).toString('hex'));
      expect(saved).not.toContain(Buffer.from(computeSharedSecret(identity.xPrivateKey, peer.xPublicKey)).toString('hex'));
      expect(endpoint.ratchets.loadSession(peer.fingerprint)!.initialReceiver!.state).toBeUndefined();
      endpoint.database.close();
    }
    const a2 = runtime(low, high, a.dir);
    const b2 = runtime(high, low, b.dir);
    a2.receive(b.outgoing[0]);
    b2.receive(a.outgoing[0]);
    expect(a2.errors).not.toHaveBeenCalled();
    expect(b2.errors).not.toHaveBeenCalled();
    expect(a2.messages().map(m => m.content).sort()).toEqual(['a0', 'b0']);
    a2.agent.setDisplayName('Protected name');
    expect(a2.identities.load()!.display_name).toBe('Protected name');
    expect(a2.identities.load()!.ed_private_key).toBeNull();
  });

  it('bounds aggregate skipped losing keys and rejects a different losing ratchet key', async () => {
    const { low, high, a, b } = pair();
    await a.send('a0');
    for (let i = 0; i < 512; i++) await b.send(`b${i}`);
    a.receive(b.outgoing[255]);
    expect(a.errors).not.toHaveBeenCalled();
    expect(a.ratchets.loadSession(high.fingerprint)!.initialReceiver!.state!.skippedKeys.size).toBe(255);
    const before = a.state();
    a.receive(b.outgoing[511]);
    expect(a.errors).toHaveBeenCalledTimes(1);
    expect(a.state()).toEqual(before);
    const otherBranch = runtime(high, low);
    await otherBranch.send('different initial key');
    a.receive(otherBranch.outgoing[0]);
    expect(a.errors).toHaveBeenCalledTimes(2);
    expect(a.state()).toEqual(before);
    a.receive(b.outgoing[0]);
    expect(a.messages().some(m => m.content === 'b0')).toBe(true);
  });

  it('delivers both initial chains out of order, persists them across restart and converges for later messages', async () => {
    const { low, high, a, b } = pair();
    await Promise.all([a.send('a0'), b.send('b0'), a.send('a1'), b.send('b1')]);
    a.receive(b.outgoing[1]);
    b.receive(a.outgoing[1]);
    expect(a.errors).not.toHaveBeenCalled();
    expect(b.errors).not.toHaveBeenCalled();
    a.database.close();
    b.database.close();
    const a2 = runtime(low, high, a.dir);
    const b2 = runtime(high, low, b.dir);
    a2.receive(b.outgoing[0]);
    b2.receive(a.outgoing[0]);
    await Promise.all([a2.send('a2'), b2.send('b2')]);
    a2.receive(b2.outgoing[0]);
    b2.receive(a2.outgoing[0]);
    await a2.send('a3');
    b2.receive(a2.outgoing[1]);
    await b2.send('b3');
    a2.receive(b2.outgoing[1]);
    expect(a2.errors).not.toHaveBeenCalled();
    expect(b2.errors).not.toHaveBeenCalled();
    for (const endpoint of [a2, b2]) {
      expect(endpoint.messages().map(m => m.content).sort()).toEqual(['a0', 'a1', 'a2', 'a3', 'b0', 'b1', 'b2', 'b3']);
    }
    const losing = a2.ratchets.loadSession(high.fingerprint)!.initialReceiver!.state!;
    expect(losing.skippedKeys.size).toBe(0);
    expect(losing.sendChainKey).toBeNull();
    expect(losing.sendRatchetPrivate).toEqual(new Uint8Array(32));
    expect(b2.ratchets.loadSession(low.fingerprint)!.initialReceiver).toBeUndefined();
  });

  it('accepts a delayed losing first message after the canonical reply arrives', async () => {
    const { a, b } = pair();
    await Promise.all([a.send('winner initial'), b.send('delayed losing initial')]);
    b.receive(a.outgoing[0]);
    await b.send('canonical reply');
    a.receive(b.outgoing[1]);
    a.receive(b.outgoing[0]);
    expect(a.errors).not.toHaveBeenCalled();
    expect(a.messages().map(m => m.content).sort()).toEqual(['canonical reply', 'delayed losing initial', 'winner initial']);
  });

  it('does not mutate either state for tampering, replay or an excessive first-message gap', async () => {
    const { high, a, b } = pair();
    await Promise.all([a.send('a0'), b.send('b0')]);
    const original = a.state();
    const corrupted = { ...b.outgoing[0], ciphertext: new Uint8Array(b.outgoing[0].ciphertext) };
    corrupted.ciphertext[0] ^= 1;
    a.receive(corrupted);
    a.receive(resign(corrupted, high));
    a.receive(resign({ ...b.outgoing[0], messageNumber: 257 }, high));
    expect(a.state()).toEqual(original);
    expect(a.errors).toHaveBeenCalledTimes(3);
    a.receive(b.outgoing[0]);
    const accepted = a.state();
    a.receive(b.outgoing[0]);
    expect(a.state()).toEqual(accepted);
    expect(a.messages().filter(m => m.content === 'b0')).toHaveLength(1);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + DM_BOOTSTRAP_WINDOW_MS + 1);
    a.receive(resign(b.outgoing[0], high));
    expect(a.state()).toEqual(accepted);
    expect(a.messages().filter(m => m.content === 'b0')).toHaveLength(1);
  });

  it('never reopens bootstrap on an established higher-initiated session', async () => {
    const { low, high, a, b } = pair();
    await b.send('high first');
    a.receive(b.outgoing[0]);
    await a.send('low replies');
    b.receive(a.outgoing[0]);
    expect(b.ratchets.loadSession(low.fingerprint)!.initialReceiver).toBeUndefined();
    const before = b.state();
    // Another authenticated initial session must not replace this established one.
    const resetPeer = runtime(low, high);
    await resetPeer.send('new bootstrap');
    b.receive(resetPeer.outgoing[0]);
    expect(b.errors).toHaveBeenCalledTimes(1);
    expect(b.state()).toEqual(before);
    await a.send('original session still works');
    b.receive(a.outgoing[1]);
    expect(b.messages().some(m => m.content === 'original session still works')).toBe(true);
  });

  it('keeps legacy sessions closed and renews only explicitly pending first-send eligibility', async () => {
    const { low, high, a, b } = pair();
    const legacy = DoubleRatchet.initSender(computeSharedSecret(low.xPrivateKey, high.xPublicKey), high.xPublicKey);
    a.ratchets.save(high.fingerprint, legacy);
    await a.send('legacy send');
    expect(a.ratchets.loadSession(high.fingerprint)!.initialReceiver).toBeUndefined();
    b.receive(a.outgoing[0]);
    await b.send('legacy reply');
    a.receive(b.outgoing[0]);
    expect(a.errors).not.toHaveBeenCalled();
    const fresh = runtime(generateIdentity(), high);
    await fresh.send('pending');
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + DM_BOOTSTRAP_WINDOW_MS + 1);
    await fresh.send('after expiry');
    expect(fresh.ratchets.loadSession(high.fingerprint)).toMatchObject({
      bootstrapPending: true,
      initialReceiver: { state: undefined, expiresAt: Date.now() + DM_BOOTSTRAP_WINDOW_MS },
    });
  });

  it('persists display-name changes without replacing identity keys and rejects invalid UTF-8 lengths', () => {
    const { a } = pair();
    const identity = a.agent.identity;
    const stored = a.identities.load()!;
    a.agent.setDisplayName('Андрей');
    expect(a.agent.identity).toBe(identity);
    expect(a.identities.load()).toEqual({ ...stored, display_name: 'Андрей' });
    for (const name of ['', 'я'.repeat(65)]) {
      expect(() => a.agent.setDisplayName(name)).toThrow(/1–128/);
    }
    expect(a.identities.load()!.display_name).toBe('Андрей');
  });
});
