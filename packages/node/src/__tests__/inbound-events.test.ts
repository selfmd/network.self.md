import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import {
  signMessage,
  MessageType,
  SenderKeys,
} from '@networkselfmd/core';
import type {
  AgentIdentity,
  GroupEncryptedMessage,
  PrivateInboundMessageEvent,
  PublicActivityEvent,
} from '@networkselfmd/core';
import {
  AgentDatabase,
  GroupRepository,
  MessageRepository,
  SenderKeyRepository,
  PeerRepository,
} from '../storage/index.js';
import { GroupManager } from '../groups/group-manager.js';
import { InboundEventQueue } from '../events/inbound-queue.js';
import { makeIdentity, makeMockSession, makeMockSwarm } from './test-utils/group-harness.js';

// Helper: build a valid, signed, encrypted group message from Alice to Bob.
function encryptAndSignFromAlice(params: {
  alice: AgentIdentity;
  groupId: Uint8Array;
  plaintext: Uint8Array;
  senderKeyRepo: SenderKeyRepository;
}): { message: GroupEncryptedMessage; chainIndex: number } {
  const { alice, groupId, plaintext, senderKeyRepo } = params;
  const aliceState = SenderKeys.generate();
  // Store Alice's state on Bob's side so he can decrypt.
  senderKeyRepo.store(groupId, alice.edPublicKey, aliceState.chainKey, aliceState.chainIndex);
  const enc = SenderKeys.encrypt(aliceState, plaintext);
  const message = signMessage<GroupEncryptedMessage>(
    {
      type: MessageType.GroupMessage,
      groupId,
      senderFingerprint: alice.fingerprint,
      senderPublicKey: alice.edPublicKey,
      chainIndex: enc.chainIndex,
      ciphertext: enc.ciphertext,
      nonce: enc.nonce,
      timestamp: Date.now(),
    },
    alice.edPrivateKey,
  );
  return { message, chainIndex: enc.chainIndex };
}

describe('Inbound event bridge', () => {
  let dataDir: string;
  let database: AgentDatabase;
  let groupRepo: GroupRepository;
  let messageRepo: MessageRepository;
  let senderKeyRepo: SenderKeyRepository;
  let peerRepo: PeerRepository;
  let alice: AgentIdentity;
  let bob: AgentIdentity;
  let mallory: AgentIdentity;
  let groupId: Uint8Array;
  let manager: GroupManager;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'nsmd-inbound-test-'));
    database = new AgentDatabase(dataDir);
    database.migrate();
    const db = database.getDb();
    groupRepo = new GroupRepository(db);
    messageRepo = new MessageRepository(db);
    senderKeyRepo = new SenderKeyRepository(db);
    peerRepo = new PeerRepository(db);

    alice = makeIdentity('Alice');
    bob = makeIdentity('Bob');
    mallory = makeIdentity('Mallory');
    groupId = new Uint8Array(32).fill(0x7a);

    // Bob's local view: he's a member, Alice is the admin.
    groupRepo.create(groupId, 'test', 'member');
    groupRepo.addMember(groupId, bob.edPublicKey, 'member');
    groupRepo.addMember(groupId, alice.edPublicKey, 'admin');

    manager = new GroupManager({
      identity: bob,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      swarm: makeMockSwarm() as any,
      groups: groupRepo,
      messages: messageRepo,
      senderKeys: senderKeyRepo,
      peers: peerRepo,
    });
  });

  afterEach(() => {
    database.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  function captureInbound(): PrivateInboundMessageEvent[] {
    const evs: PrivateInboundMessageEvent[] = [];
    manager.on('inbound:message', (e: PrivateInboundMessageEvent) => evs.push(e));
    return evs;
  }

  function captureActivity(): PublicActivityEvent[] {
    const evs: PublicActivityEvent[] = [];
    manager.on('activity:message', (e: PublicActivityEvent) => evs.push(e));
    return evs;
  }

  it('emits inbound:message on a valid group message with expected fields', async () => {
    const inbound = captureInbound();
    const plaintext = new TextEncoder().encode('hello world');
    const { message } = encryptAndSignFromAlice({ alice, groupId, plaintext, senderKeyRepo });

    await manager.handleGroupMessage(makeMockSession(alice), message);

    expect(inbound).toHaveLength(1);
    const ev = inbound[0];
    expect(ev.kind).toBe('group');
    expect(typeof ev.messageId).toBe('string');
    expect(ev.messageId.length).toBeGreaterThan(0);
    expect(ev.groupId).toEqual(groupId);
    expect(ev.senderPublicKey).toEqual(alice.edPublicKey);
    expect(ev.senderFingerprint).toBe(alice.fingerprint);
    expect(ev.plaintext).toEqual(plaintext);
    expect(ev.timestamp).toBe(message.timestamp);
    expect(ev.receivedAt).toBeGreaterThan(0);
    // Event's messageId must match what was persisted.
    const rows = messageRepo.query({ groupId });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(ev.messageId);
  });

  it('emits activity:message on a valid group message, metadata-only', async () => {
    const activity = captureActivity();
    const plaintext = new TextEncoder().encode('hello');
    const { message } = encryptAndSignFromAlice({ alice, groupId, plaintext, senderKeyRepo });

    await manager.handleGroupMessage(makeMockSession(alice), message);

    expect(activity).toHaveLength(1);
    const ev = activity[0];
    expect(ev.kind).toBe('group');
    expect(ev.groupIdHex).toBe(Buffer.from(groupId).toString('hex'));
    expect(ev.senderFingerprint).toBe(alice.fingerprint);
    expect(ev.byteLength).toBe(message.ciphertext.byteLength);
    // Must NOT carry plaintext or ciphertext byte fields.
    expect(ev).not.toHaveProperty('plaintext');
    expect(ev).not.toHaveProperty('ciphertext');
    expect(ev).not.toHaveProperty('senderPublicKey');
    expect(ev).not.toHaveProperty('plaintextBase64');
    expect(ev).not.toHaveProperty('plaintextUtf8');
  });

  it('preserves legacy group:message event for existing listeners', async () => {
    const legacy: unknown[] = [];
    manager.on('group:message', (e) => legacy.push(e));
    const plaintext = new TextEncoder().encode('legacy-path');
    const { message } = encryptAndSignFromAlice({ alice, groupId, plaintext, senderKeyRepo });

    await manager.handleGroupMessage(makeMockSession(alice), message);

    expect(legacy).toHaveLength(1);
    const e = legacy[0] as { content?: string; senderPublicKey?: Uint8Array };
    expect(e.content).toBe('legacy-path');
    expect(e.senderPublicKey).toEqual(alice.edPublicKey);
  });

  it('emits no inbound/activity event for an invalid signature (tampered ciphertext)', async () => {
    const inbound = captureInbound();
    const activity = captureActivity();
    const errs: Error[] = [];
    manager.on('error', (e: Error) => errs.push(e));

    const plaintext = new TextEncoder().encode('tampered');
    const { message } = encryptAndSignFromAlice({ alice, groupId, plaintext, senderKeyRepo });
    // Tamper AFTER signing: flip a byte in ciphertext.
    message.ciphertext = new Uint8Array(message.ciphertext);
    message.ciphertext[0] ^= 0xff;

    await manager.handleGroupMessage(makeMockSession(alice), message);

    expect(inbound).toHaveLength(0);
    expect(activity).toHaveLength(0);
    expect(errs.length).toBeGreaterThanOrEqual(1);
    expect(errs[0].message).toMatch(/invalid signature/i);
  });

  it('emits no event for an unknown (non-member) sender', async () => {
    const inbound = captureInbound();
    const activity = captureActivity();
    const errs: Error[] = [];
    manager.on('error', (e: Error) => errs.push(e));

    // Mallory is NOT a member of this group (not added in beforeEach for this groupId).
    // Re-initialize group with only alice + bob to make sure mallory is unknown.
    const solo = new Uint8Array(32).fill(0x55);
    groupRepo.create(solo, 'solo', 'member');
    groupRepo.addMember(solo, bob.edPublicKey, 'member');
    groupRepo.addMember(solo, alice.edPublicKey, 'admin');

    // Mallory signs a message claiming to be in group `solo`. No sender key
    // is registered for Mallory on Bob's side, so even if the sig verifies,
    // decryption has no key — but the earlier sender-key / membership checks
    // should also fail. Either way: no event.
    const malloryState = SenderKeys.generate();
    const enc = SenderKeys.encrypt(malloryState, new TextEncoder().encode('hi'));
    const forged = signMessage<GroupEncryptedMessage>(
      {
        type: MessageType.GroupMessage,
        groupId: solo,
        senderFingerprint: mallory.fingerprint,
        senderPublicKey: mallory.edPublicKey,
        chainIndex: enc.chainIndex,
        ciphertext: enc.ciphertext,
        nonce: enc.nonce,
        timestamp: Date.now(),
      },
      mallory.edPrivateKey,
    );

    await manager.handleGroupMessage(makeMockSession(mallory), forged);

    expect(inbound).toHaveLength(0);
    expect(activity).toHaveLength(0);
  });

  it('emits no event on failed decryption (valid signature, wrong chain state)', async () => {
    const inbound = captureInbound();
    const activity = captureActivity();
    const errs: Error[] = [];
    manager.on('error', (e: Error) => errs.push(e));

    // Alice encrypts and signs with a freshly-generated state — this is a
    // validly-signed message. But we store on Bob's side a DIFFERENT sender
    // key for Alice (different chain key), so decryption under Bob's stored
    // state fails while the signature still verifies cleanly. This is the
    // "valid sig, undecryptable" branch, distinct from the tamper test.
    const aliceState = SenderKeys.generate();
    const enc = SenderKeys.encrypt(aliceState, new TextEncoder().encode('nope'));
    const message = signMessage<GroupEncryptedMessage>(
      {
        type: MessageType.GroupMessage,
        groupId,
        senderFingerprint: alice.fingerprint,
        senderPublicKey: alice.edPublicKey,
        chainIndex: enc.chainIndex,
        ciphertext: enc.ciphertext,
        nonce: enc.nonce,
        timestamp: Date.now(),
      },
      alice.edPrivateKey,
    );
    // Bob's stored sender-key state for Alice: unrelated random chain key.
    senderKeyRepo.store(groupId, alice.edPublicKey, randomBytes(32), 0);

    await manager.handleGroupMessage(makeMockSession(alice), message);

    expect(inbound).toHaveLength(0);
    expect(activity).toHaveLength(0);
    // Some error surfaced (exact shape is SenderKeys-internal).
    expect(errs.length).toBeGreaterThanOrEqual(1);
  });

  it('does not leak plaintext into the public logger (canary)', async () => {
    const originalLog = console.log;
    const originalInfo = console.info;
    const originalWarn = console.warn;
    const captured: string[] = [];
    const record = (...args: unknown[]) => {
      captured.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    };
    console.log = record;
    console.info = record;
    console.warn = record;

    try {
      const canary = 'secret-canary-xyz';
      const plaintext = new TextEncoder().encode(canary);
      const { message } = encryptAndSignFromAlice({ alice, groupId, plaintext, senderKeyRepo });

      await manager.handleGroupMessage(makeMockSession(alice), message);

      for (const line of captured) {
        expect(line).not.toContain(canary);
      }
    } finally {
      console.log = originalLog;
      console.info = originalInfo;
      console.warn = originalWarn;
    }
  });

  it('provides enough context for an agent handler to decide act | ask | ignore', async () => {
    const inbound = captureInbound();
    const plaintext = new TextEncoder().encode('decide-me');
    const { message } = encryptAndSignFromAlice({ alice, groupId, plaintext, senderKeyRepo });

    await manager.handleGroupMessage(makeMockSession(alice), message);

    const ev = inbound[0];
    // Shape assertion: all fields the decision policy will need must be here.
    expect(ev).toMatchObject({
      kind: expect.stringMatching(/^(group|dm)$/),
      messageId: expect.any(String),
      senderFingerprint: expect.any(String),
      timestamp: expect.any(Number),
      receivedAt: expect.any(Number),
    });
    expect(ev.plaintext).toBeInstanceOf(Uint8Array);
    expect(ev.senderPublicKey).toBeInstanceOf(Uint8Array);
  });
});

describe('InboundEventQueue', () => {
  function makeEvent(id: string): PrivateInboundMessageEvent {
    return {
      kind: 'group',
      messageId: id,
      groupId: new Uint8Array([0xaa]),
      senderPublicKey: new Uint8Array(32),
      senderFingerprint: 'fp',
      plaintext: new TextEncoder().encode(id),
      timestamp: 1,
      receivedAt: 2,
    };
  }

  it('push/drain returns events in FIFO order and empties the queue', () => {
    const q = new InboundEventQueue();
    q.push(makeEvent('a'));
    q.push(makeEvent('b'));
    q.push(makeEvent('c'));
    expect(q.size()).toBe(3);
    const out = q.drain();
    expect(out.map((e) => e.messageId)).toEqual(['a', 'b', 'c']);
    expect(q.size()).toBe(0);
  });

  it('peek is non-destructive', () => {
    const q = new InboundEventQueue();
    q.push(makeEvent('a'));
    q.push(makeEvent('b'));
    expect(q.peek().map((e) => e.messageId)).toEqual(['a', 'b']);
    expect(q.size()).toBe(2);
  });

  it('drops oldest on overflow (max+1)', () => {
    const q = new InboundEventQueue({ max: 3 });
    q.push(makeEvent('a'));
    q.push(makeEvent('b'));
    q.push(makeEvent('c'));
    q.push(makeEvent('d'));
    expect(q.size()).toBe(3);
    expect(q.drain().map((e) => e.messageId)).toEqual(['b', 'c', 'd']);
  });

  it('on() fires for each push and returned function unsubscribes', () => {
    const q = new InboundEventQueue();
    const seen: string[] = [];
    const off = q.on((e) => seen.push(e.messageId));
    q.push(makeEvent('a'));
    q.push(makeEvent('b'));
    off();
    q.push(makeEvent('c'));
    expect(seen).toEqual(['a', 'b']);
  });

  it('drain with limit returns partial and leaves the rest', () => {
    const q = new InboundEventQueue();
    q.push(makeEvent('a'));
    q.push(makeEvent('b'));
    q.push(makeEvent('c'));
    expect(q.drain(2).map((e) => e.messageId)).toEqual(['a', 'b']);
    expect(q.drain().map((e) => e.messageId)).toEqual(['c']);
  });
});

describe('MCP DTO — toInboundEventDTO', () => {
  // The DTO helper lives in @networkselfmd/mcp, but that package isn't a
  // direct dep of @networkselfmd/node. We replicate the shape contract here
  // against an inlined equivalent to avoid a circular workspace dep in
  // tests. The MCP package's own tests cover the helper.
  const toDTO = (ev: PrivateInboundMessageEvent) => {
    const dto: Record<string, unknown> = {
      kind: ev.kind,
      messageId: ev.messageId,
      groupIdHex: ev.groupId ? Buffer.from(ev.groupId).toString('hex') : undefined,
      senderPublicKeyHex: Buffer.from(ev.senderPublicKey).toString('hex'),
      senderFingerprint: ev.senderFingerprint,
      plaintextBase64: Buffer.from(ev.plaintext).toString('base64'),
      timestamp: ev.timestamp,
      receivedAt: ev.receivedAt,
    };
    try {
      dto.plaintextUtf8 = new TextDecoder('utf-8', { fatal: true }).decode(ev.plaintext);
    } catch {
      // non-UTF-8 payload
    }
    return dto;
  };

  const base: PrivateInboundMessageEvent = {
    kind: 'group',
    messageId: 'm1',
    groupId: new Uint8Array([0xde, 0xad]),
    senderPublicKey: new Uint8Array([0xbe, 0xef, 0x01]),
    senderFingerprint: 'fp1',
    plaintext: new TextEncoder().encode('hi'),
    timestamp: 10,
    receivedAt: 20,
  };

  it('hex-encodes groupId and senderPublicKey; always sets plaintextBase64', () => {
    const dto = toDTO(base);
    expect(dto.groupIdHex).toBe('dead');
    expect(dto.senderPublicKeyHex).toBe('beef01');
    expect(dto.plaintextBase64).toBe(Buffer.from('hi').toString('base64'));
  });

  it('sets plaintextUtf8 only for valid UTF-8', () => {
    const utf8 = toDTO(base);
    expect(utf8.plaintextUtf8).toBe('hi');

    const bad: PrivateInboundMessageEvent = {
      ...base,
      plaintext: new Uint8Array([0xc3, 0x28]), // invalid UTF-8 byte sequence
    };
    const badDto = toDTO(bad);
    expect(badDto.plaintextUtf8).toBeUndefined();
    expect(badDto.plaintextBase64).toBe(Buffer.from([0xc3, 0x28]).toString('base64'));
  });

  it('JSON.stringify of the DTO produces no numeric-keyed byte objects', () => {
    const dto = toDTO(base);
    const serialized = JSON.stringify(dto);
    // Numeric-keyed byte-object leak would look like: "0":222,"1":173 etc.
    expect(serialized).not.toMatch(/"0":\s*\d+,\s*"1":\s*\d+/);
    // And must not contain raw binary chunks of the key material.
    expect(serialized).toContain('beef01');
    expect(serialized).toContain('dead');
  });
});

// DM path: Agent.handleDirectMessage is explicitly fail-closed per PR #1
// and emits ONLY an 'error' event (see agent.ts). No inbound:message nor
// activity:message is wired on that code path in this PR. A proper
// DM-emission test lands alongside the DM signing / Double Ratchet PR.
