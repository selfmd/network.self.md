import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  generateIdentity,
  MessageType,
  signAuthenticatedMessage,
} from '@networkselfmd/core';
import type { GroupEncryptedMessage } from '@networkselfmd/core';
import type {
  AuthenticatedProtocolMessage,
  DirectEncryptedMessage,
  GroupManagementMessage,
  SenderKeyDistributionMessage,
} from '@networkselfmd/core';
import { PeerSession } from '../network/connection.js';
import { acceptAuthenticatedMessage } from '../network/protocol-security.js';
import { MessageRouter } from '../network/router.js';
import { AgentDatabase, ProtocolReplayRepository } from '../storage/index.js';

describe('authenticated inbound replay protection', () => {
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
      signAuthenticatedMessage<SenderKeyDistributionMessage>(
        {
          type: MessageType.SenderKeyDistribution,
          groupId: new Uint8Array(32).fill(1),
          chainKey: new Uint8Array(32).fill(2),
          chainIndex: 1,
          signingPublicKey: sender.edPublicKey,
          senderFingerprint: sender.fingerprint,
          recipientFingerprint: recipient.fingerprint,
          timestamp,
        },
        sender.edPrivateKey,
      ),
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
          action: 'invite',
          targetFingerprint: recipient.fingerprint,
          groupName: 'test',
          senderFingerprint: sender.fingerprint,
          recipientFingerprint: recipient.fingerprint,
          timestamp,
        },
        sender.edPrivateKey,
      ),
    ];
  }

  it.each(authenticatedMessages())(
    'rejects duplicate signed message type $type',
    (signed) => {
      const replay = new ProtocolReplayRepository(database.getDb());
      expect(() =>
        acceptAuthenticatedMessage(
          session,
          signed,
          recipient.fingerprint,
          replay,
        ),
      ).not.toThrow();
      expect(() =>
        acceptAuthenticatedMessage(
          session,
          signed,
          recipient.fingerprint,
          replay,
        ),
      ).toThrow(/replay/i);
    },
  );

  it('rejects a replay and preserves the decision across restart', () => {
    const signed = message();
    let replay = new ProtocolReplayRepository(database.getDb());
    expect(() =>
      acceptAuthenticatedMessage(
        session,
        signed,
        recipient.fingerprint,
        replay,
      ),
    ).not.toThrow();
    expect(() =>
      acceptAuthenticatedMessage(
        session,
        signed,
        recipient.fingerprint,
        replay,
      ),
    ).toThrow(/replay/i);

    database.close();
    database = new AgentDatabase(dir);
    database.migrate();
    replay = new ProtocolReplayRepository(database.getDb());
    expect(() =>
      acceptAuthenticatedMessage(
        session,
        signed,
        recipient.fingerprint,
        replay,
      ),
    ).toThrow(/replay/i);
  });

  it('rejects stale timestamps and forged session identities before claiming', () => {
    const replay = new ProtocolReplayRepository(database.getDb());
    const stale = message(Date.now() - 5 * 60 * 1000 - 1);
    expect(() =>
      acceptAuthenticatedMessage(session, stale, recipient.fingerprint, replay),
    ).toThrow(/timestamp/i);

    const signed = message();
    const forgedSession = {
      ...session,
      peerFingerprint: recipient.fingerprint,
    } as PeerSession;
    expect(() =>
      acceptAuthenticatedMessage(
        forgedSession,
        signed,
        recipient.fingerprint,
        replay,
      ),
    ).toThrow(/sender/i);
    expect(() =>
      acceptAuthenticatedMessage(
        session,
        signed,
        recipient.fingerprint,
        replay,
      ),
    ).not.toThrow();
  });
});

describe('protocol phase and use gating', () => {
  const router = new MessageRouter();
  const identity = generateIdentity();

  it('rejects application traffic before the session is ready', async () => {
    const session = { state: 'verified' } as PeerSession;
    await expect(
      router.route(session, {
        type: MessageType.GroupSync,
        groupId: new Uint8Array(32),
        members: [],
        epoch: 0,
        timestamp: Date.now(),
      }),
    ).rejects.toThrow(/session is not ready/i);
  });

  it('rejects handshakes and unsupported dead types after readiness', async () => {
    const session = { state: 'ready' } as PeerSession;
    await expect(
      router.route(session, {
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
      router.route(session, {
        type: MessageType.Ack,
        messageId: 'unused',
        timestamp: Date.now(),
      }),
    ).rejects.toThrow(/unsupported protocol message/i);
  });
});

describe('malformed frame handling', () => {
  it('reports the error and destroys the offending session', () => {
    const handlers = new Map<string, (...args: unknown[]) => void>();
    const destroy = vi.fn();
    const peerSession = new PeerSession({
      write: vi.fn(),
      end: vi.fn(),
      destroy,
      on: (event, handler) => handlers.set(event, handler),
      removeAllListeners: vi.fn(),
      publicKey: Buffer.alloc(32, 1),
      remotePublicKey: Buffer.alloc(32, 2),
    });
    const errors: Error[] = [];
    peerSession.on('error', (error) => errors.push(error));

    handlers.get('data')?.(Buffer.from([0, 0, 0, 1, 0xff]));

    expect(errors).toHaveLength(1);
    expect(destroy).toHaveBeenCalledOnce();
  });
});
