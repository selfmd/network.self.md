import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  generateIdentity,
  MessageType,
  signAuthenticatedMessage,
} from '@networkselfmd/core';
import type {
  AuthenticatedProtocolMessage,
  DirectEncryptedMessage,
  GroupEncryptedMessage,
  GroupManagementMessage,
} from '@networkselfmd/core';
import { PeerSession } from '../network/connection.js';
import {
  validateAuthenticatedMessage,
  validateSenderKeyEnvelope,
} from '../network/protocol-security.js';
import { MessageRouter } from '../network/router.js';
import { AgentDatabase, ProtocolReplayRepository } from '../storage/index.js';

describe('atomic inbound replay protection', () => {
  let dir: string;
  let database: AgentDatabase;
  const sender = generateIdentity();
  const recipient = generateIdentity();
  const session = {
    state: 'ready',
    peerPublicKey: sender.edPublicKey,
    peerFingerprint: sender.fingerprint,
  } as PeerSession;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nsmd-protocol-security-'));
    database = new AgentDatabase(dir);
    database.migrate();
  });

  afterEach(() => {
    database.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function message(timestamp = Date.now()): GroupEncryptedMessage {
    return signAuthenticatedMessage<GroupEncryptedMessage>(
      {
        type: MessageType.GroupMessage,
        groupId: new Uint8Array(32).fill(1),
        senderFingerprint: sender.fingerprint,
        chainIndex: 0,
        generationId: new Uint8Array(16).fill(4),
        epochVersion: 0,
        epochHash: new Uint8Array(32).fill(9),
        ciphertext: new Uint8Array(16).fill(2),
        nonce: new Uint8Array(24).fill(3),
        timestamp,
      },
      sender.edPrivateKey,
    );
  }

  function authenticatedMessages(
    timestamp = Date.now(),
  ): AuthenticatedProtocolMessage[] {
    return [
      message(timestamp),
      signAuthenticatedMessage<DirectEncryptedMessage>(
        {
          type: MessageType.DirectMessage,
          senderFingerprint: sender.fingerprint,
          recipientFingerprint: recipient.fingerprint,
          ratchetPublicKey: new Uint8Array(32).fill(4),
          previousChainLength: 0,
          messageNumber: 1,
          ciphertext: new Uint8Array(16).fill(5),
          nonce: new Uint8Array(24).fill(6),
          timestamp,
        },
        sender.edPrivateKey,
      ),
      signAuthenticatedMessage<GroupManagementMessage>(
        {
          type: MessageType.GroupManagement,
          groupId: new Uint8Array(32).fill(1),
          action: 'kick',
          targetFingerprint: recipient.fingerprint,
          senderFingerprint: sender.fingerprint,
          recipientFingerprint: recipient.fingerprint,
          timestamp,
        },
        sender.edPrivateKey,
      ),
    ];
  }

  it.each(authenticatedMessages())(
    'rejects a committed duplicate for type $type',
    (signed) => {
      const replay = new ProtocolReplayRepository(database.getDb());
      const reservation = validateAuthenticatedMessage(
        session,
        signed,
        recipient.fingerprint,
      );
      expect(() => replay.accept(reservation, () => undefined)).not.toThrow();
      expect(() => replay.accept(reservation, () => undefined)).toThrow(
        /replay/i,
      );
    },
  );

  it('rolls back both reservation and state when mutation/decrypt fails', () => {
    let replay = new ProtocolReplayRepository(database.getDb());
    const reservation = validateAuthenticatedMessage(
      session,
      message(),
      recipient.fingerprint,
    );
    expect(() =>
      replay.accept(reservation, () => {
        database
          .getDb()
          .prepare(
            `INSERT INTO messages (id, content, timestamp, type)
             VALUES ('partial', 'must rollback', 1, 'direct')`,
          )
          .run();
        throw new Error('simulated decrypt failure/crash');
      }),
    ).toThrow(/simulated/i);
    expect(replay.has(reservation.messageId)).toBe(false);
    expect(
      database
        .getDb()
        .prepare("SELECT 1 FROM messages WHERE id = 'partial'")
        .get(),
    ).toBeUndefined();
    database.close();
    database = new AgentDatabase(dir);
    database.migrate();
    replay = new ProtocolReplayRepository(database.getDb());
    expect(() => replay.accept(reservation, () => undefined)).not.toThrow();
  });

  it('survives restart only after state and reservation commit together', () => {
    const signed = message();
    let replay = new ProtocolReplayRepository(database.getDb());
    const reservation = validateAuthenticatedMessage(
      session,
      signed,
      recipient.fingerprint,
    );
    replay.accept(reservation, () => {
      database
        .getDb()
        .prepare(
          `INSERT INTO messages (id, content, timestamp, type)
           VALUES ('committed', 'ok', 1, 'direct')`,
        )
        .run();
    });

    database.close();
    database = new AgentDatabase(dir);
    database.migrate();
    replay = new ProtocolReplayRepository(database.getDb());
    expect(replay.has(reservation.messageId)).toBe(true);
    expect(() => replay.accept(reservation, () => undefined)).toThrow(
      /replay/i,
    );
    expect(
      database
        .getDb()
        .prepare("SELECT 1 FROM messages WHERE id = 'committed'")
        .get(),
    ).toBeDefined();
  });

  it('prunes by TTL and enforces per-sender and global caps', () => {
    const replay = new ProtocolReplayRepository(database.getDb(), {
      ttlMs: 10,
      perSenderCap: 2,
      globalCap: 3,
    });
    const reserve = (
      id: number,
      senderFingerprint = sender.fingerprint,
      at = 1,
    ) => ({
      messageId: new Uint8Array(32).fill(id),
      senderFingerprint,
      messageType: MessageType.DirectMessage,
      receivedAt: at,
    });
    replay.accept(reserve(1), () => undefined);
    replay.accept(reserve(2), () => undefined);
    expect(() => replay.accept(reserve(3), () => undefined)).toThrow(
      /per-sender/i,
    );
    replay.accept(reserve(3, recipient.fingerprint), () => undefined);
    expect(() =>
      replay.accept(reserve(4, 'b'.repeat(32)), () => undefined),
    ).toThrow(/global/i);
    expect(replay.prune(11)).toBe(3);
    expect(() =>
      replay.accept(reserve(4, sender.fingerprint, 11), () => undefined),
    ).not.toThrow();
  });

  it('rejects stale timestamps and forged session identities before reservation', () => {
    const stale = message(Date.now() - 5 * 60 * 1000 - 1);
    expect(() =>
      validateAuthenticatedMessage(session, stale, recipient.fingerprint),
    ).toThrow(/timestamp/i);
    const forgedSession = {
      ...session,
      peerFingerprint: recipient.fingerprint,
    } as PeerSession;
    expect(() =>
      validateAuthenticatedMessage(
        forgedSession,
        message(),
        recipient.fingerprint,
      ),
    ).toThrow(/fingerprint/i);
  });

  it('prepares opaque recipient-specific sender-key envelopes for atomic replay', () => {
    const envelope = {
      type: MessageType.SenderKeyDistribution,
      protocolVersion: 2,
      recipientPublicKey: recipient.edPublicKey,
      ciphertext: new Uint8Array(16).fill(7),
      nonce: new Uint8Array(24).fill(8),
      timestamp: Date.now(),
    } as const;
    const reservation = validateSenderKeyEnvelope(
      session,
      envelope,
      recipient.edPublicKey,
    );
    expect(reservation.senderFingerprint).toBe(sender.fingerprint);
    expect(() =>
      validateSenderKeyEnvelope(session, envelope, sender.edPublicKey),
    ).toThrow(/recipient/i);
  });
});

describe('protocol phase and use gating', () => {
  const router = new MessageRouter();
  const identity = generateIdentity();

  it('rejects application traffic before the session is ready', async () => {
    await expect(
      router.route({ state: 'verified' } as PeerSession, {
        type: MessageType.GroupSync,
        groupId: new Uint8Array(32),
        members: [],
        epoch: 0,
        timestamp: Date.now(),
      }),
    ).rejects.toThrow(/session is not ready/i);
  });

  it('rejects handshakes and unsupported dead types after readiness', async () => {
    const ready = { state: 'ready' } as PeerSession;
    await expect(
      router.route(ready, {
        type: MessageType.IdentityHandshake,
        edPublicKey: identity.edPublicKey,
        xPublicKey: identity.xPublicKey,
        noisePublicKey: new Uint8Array(32),
        signature: new Uint8Array(64),
        protocolVersion: 2,
        timestamp: Date.now(),
      }),
    ).rejects.toThrow(/invalid after handshake/i);
    await expect(
      router.route(ready, {
        type: MessageType.Ack,
        messageId: 'unused',
        timestamp: Date.now(),
      }),
    ).rejects.toThrow(/unsupported protocol message/i);
  });
});

describe('malformed frame handling matrix', () => {
  it.each([
    ['malformed cbor', Buffer.from([0, 0, 0, 1, 0xff])],
    ['empty frame', Buffer.from([0, 0, 0, 0])],
    ['oversized frame', Buffer.from([0, 16, 0, 1])],
  ])('reports %s and destroys the offending session', (_label, frame) => {
    const handlers = new Map<string, (...args: unknown[]) => void>();
    const destroy = vi.fn();
    const peerSession = new PeerSession({
      write: vi.fn(),
      end: vi.fn(),
      destroy,
      on: (event, handler) => handlers.set(event, handler),
      removeListener: vi.fn(),
      publicKey: Buffer.alloc(32, 1),
      remotePublicKey: Buffer.alloc(32, 2),
    });
    const errors: Error[] = [];
    peerSession.on('error', (error) => errors.push(error));
    handlers.get('data')?.(frame);
    expect(errors).toHaveLength(1);
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('does not destroy a session for a fragmented frame prefix', () => {
    const handlers = new Map<string, (...args: unknown[]) => void>();
    const destroy = vi.fn();
    new PeerSession({
      write: vi.fn(),
      end: vi.fn(),
      destroy,
      on: (event, handler) => handlers.set(event, handler),
      removeListener: vi.fn(),
      publicKey: Buffer.alloc(32, 1),
      remotePublicKey: Buffer.alloc(32, 2),
    });
    handlers.get('data')?.(Buffer.from([0, 0]));
    expect(destroy).not.toHaveBeenCalled();
  });
});
