import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { argon2id } from 'hash-wasm';
import {
  generateIdentity,
  deriveEd25519PublicKey,
  deriveX25519KeyPair,
  fingerprintFromPublicKey,
  encrypt,
  decrypt,
  deriveKey,
  sign,
  verify,
  computeSharedSecret,
  DoubleRatchet,
  signAnnounce,
  verifyAnnounce,
  copyAndValidateTTYAAuthSecret,
  assertAnnounceShape,
  verifyAnnouncedGroupAuthority,
  NETWORK_ANNOUNCE_VERSION,
  serializeEpoch,
} from '@networkselfmd/core';
import type {
  AgentIdentity,
  PeerInfo,
  GroupInfo,
  ProtocolMessage,
  DirectEncryptedMessage,
  SenderKeyDistributionMessage,
  GroupEncryptedMessage,
  GroupManagementMessage,
  GroupEpochMessage,
  NetworkAnnounceMessage,
  DoubleRatchetState,
} from '@networkselfmd/core';
import { MessageType } from '@networkselfmd/core';
import { createId } from '@paralleldrive/cuid2';
import {
  AgentDatabase,
  IdentityRepository,
  PeerRepository,
  GroupRepository,
  MessageRepository,
  SenderKeyRepository,
  DiscoveredGroupRepository,
  RatchetStateRepository,
  GroupEpochRepository,
  GroupInviteRepository,
  NetworkAnnounceStateRepository,
} from './storage/index.js';
import { SwarmManager } from './network/swarm.js';
import type { PeerSession } from './network/connection.js';
import type { HandshakeResult } from './network/handshake.js';
import { GroupManager } from './groups/group-manager.js';
import type { SecretProvider } from './secrets.js';
import { TTYAManager, type TTYAVisitor } from './ttya/ttya-manager.js';

export interface AgentOptions {
  dataDir: string;
  passphrase?: string;
  secretProvider?: SecretProvider;
  displayName?: string;
  bootstrap?: Array<{ host: string; port: number }>;
  /** Enables the isolated TTYA transport. Must be at least 32 random bytes. */
  ttyaAuthSecret?: Uint8Array;
}

export type IdentityKeyStorageErrorCode =
  | 'PASSPHRASE_REQUIRED'
  | 'INVALID_PASSPHRASE'
  | 'SECRET_PROVIDER_FAILED'
  | 'UNLOCK_FAILED'
  | 'KEY_STORAGE_ORPHANED'
  | 'PLAINTEXT_ERASURE_FAILED'
  | 'KEY_STORAGE_CORRUPT';

export class IdentityKeyStorageError extends Error {
  constructor(
    message: string,
    readonly code: IdentityKeyStorageErrorCode,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'IdentityKeyStorageError';
  }
}

export interface MemberInfo {
  publicKey: Uint8Array;
  fingerprint: string;
  role: string;
  displayName?: string;
}

export interface Message {
  id: string;
  groupId?: Uint8Array;
  senderPublicKey?: Uint8Array;
  peerPublicKey?: Uint8Array;
  content: string;
  timestamp: number;
  type: string;
}

export class Agent extends EventEmitter {
  identity!: AgentIdentity;
  peers: Map<string, PeerSession> = new Map();
  groups: Map<string, GroupInfo> = new Map();
  isRunning = false;

  private options: AgentOptions;
  private database!: AgentDatabase;
  private identityRepo!: IdentityRepository;
  private peerRepo!: PeerRepository;
  private groupRepo!: GroupRepository;
  private messageRepo!: MessageRepository;
  private senderKeyRepo!: SenderKeyRepository;
  private discoveredGroupRepo!: DiscoveredGroupRepository;
  private ratchetStateRepo!: RatchetStateRepository;
  private groupEpochRepo!: GroupEpochRepository;
  private groupInviteRepo!: GroupInviteRepository;
  private announceStateRepo!: NetworkAnnounceStateRepository;
  private swarm!: SwarmManager;
  private groupManager!: GroupManager;
  private ttyaManager: TTYAManager | null = null;

  constructor(options: AgentOptions) {
    super();
    this.options = {
      ...options,
      ttyaAuthSecret: options.ttyaAuthSecret
        ? copyAndValidateTTYAAuthSecret(options.ttyaAuthSecret)
        : undefined,
    };

    // Prevent unhandled 'error' events from crashing the process.
    // Node.js EventEmitter kills the process if 'error' is emitted with no listener.
    this.on('error', (err: Error) => {
      console.error('[Agent error]', err.message);
    });
  }

  async start(): Promise<void> {
    if (this.isRunning) return;

    const passphrase = await this.resolvePassphrase();
    if (
      passphrase !== undefined &&
      !existsSync(join(this.options.dataDir, 'agent.db'))
    ) {
      this.assertStrongPassphrase(passphrase);
    }

    try {
      // Init database
      this.database = new AgentDatabase(this.options.dataDir);
      this.database.migrate();

      const db = this.database.getDb();
      this.identityRepo = new IdentityRepository(db);
      this.peerRepo = new PeerRepository(db);
      this.groupRepo = new GroupRepository(db);
      this.messageRepo = new MessageRepository(db);
      this.senderKeyRepo = new SenderKeyRepository(db);
      this.discoveredGroupRepo = new DiscoveredGroupRepository(db);
      this.ratchetStateRepo = new RatchetStateRepository(db);
      this.groupEpochRepo = new GroupEpochRepository(db);
      this.groupInviteRepo = new GroupInviteRepository(db);
      this.announceStateRepo = new NetworkAnnounceStateRepository(db);

      // Load or generate identity. Startup cleanup below closes the database
      // on an unlock failure so callers can retry with a fresh Agent instance.
      await this.loadOrGenerateIdentity(passphrase);

      // Init swarm
      this.swarm = new SwarmManager({
        identity: this.identity,
        bootstrap: this.options.bootstrap,
        acceptPeerIdentity: (result) => {
          this.peerRepo.pinTransportIdentity(
            result.peerPublicKey,
            result.peerFingerprint,
            result.peerNoisePublicKey,
            result.peerDisplayName,
          );
        },
      });

      // Init group manager
      this.groupManager = new GroupManager({
        identity: this.identity,
        swarm: this.swarm,
        groups: this.groupRepo,
        messages: this.messageRepo,
        senderKeys: this.senderKeyRepo,
        peers: this.peerRepo,
        epochs: this.groupEpochRepo,
        invites: this.groupInviteRepo,
      });

      // Wire up events
      this.setupSwarmEvents();
      this.setupRouterHandlers();
      this.setupGroupManagerEvents();

      // Start networking
      await this.swarm.start();

      // TTYA is a separate authenticated transport. It is disabled unless a
      // PSK is explicitly provisioned; the generic peer router never accepts it.
      if (this.options.ttyaAuthSecret) {
        this.ttyaManager = new TTYAManager(
          this.identity.edPublicKey,
          this.options.ttyaAuthSecret,
        );
        this.ttyaManager.on('visitor:request', (request) => {
          this.emit('ttya:request', request);
        });
        this.ttyaManager.on('visitor:disconnect', (visitorId) => {
          this.emit('ttya:disconnect', visitorId);
        });
        await this.ttyaManager.start();
      }

      // Rejoin existing groups
      await this.groupManager.rejoinAllGroups();

      // Join global network discovery topic
      const networkTopic = deriveKey(
        new TextEncoder().encode('networkselfmd'),
        'networkselfmd-discovery-v1',
        '',
        32,
      );
      await this.swarm.join(Buffer.from(networkTopic));

      this.isRunning = true;
      this.emit('started');
    } catch (error) {
      if (this.ttyaManager) {
        await this.ttyaManager.stop().catch(() => {});
        this.ttyaManager = null;
      }
      if (this.swarm) await this.swarm.stop().catch(() => {});
      if (this.database) {
        try {
          this.database.close();
        } catch {
          // Preserve the startup failure.
        }
      }
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return;

    this.isRunning = false;

    if (this.ttyaManager) {
      await this.ttyaManager.stop();
      this.ttyaManager = null;
    }

    if (this.swarm) {
      await this.swarm.stop();
    }

    if (this.database) {
      this.database.close();
    }

    this.peers.clear();
    this.groups.clear();
    this.emit('stopped');
  }

  // ---- TTYA ----

  get isTTYAEnabled(): boolean {
    return this.ttyaManager?.isRunning ?? false;
  }

  getPendingTTYAVisitors(): TTYAVisitor[] {
    return this.requireTTYAManager().getPending();
  }

  approveTTYAVisitor(visitorId: string): void {
    this.requireTTYAManager().approve(visitorId);
  }

  rejectTTYAVisitor(visitorId: string): void {
    this.requireTTYAManager().reject(visitorId);
  }

  replyToTTYAVisitor(visitorId: string, content: string): void {
    this.requireTTYAManager().reply(visitorId, content);
  }

  private requireTTYAManager(): TTYAManager {
    if (!this.ttyaManager?.isRunning) {
      throw new Error(
        'TTYA is disabled; provision ttyaAuthSecret before starting the agent',
      );
    }
    return this.ttyaManager;
  }

  // ---- Groups ----

  async createGroup(
    name: string,
    options?: { public?: boolean; selfMd?: string },
  ): Promise<{ groupId: Uint8Array; topic: Buffer }> {
    const nameLength = new TextEncoder().encode(name).length;
    if (nameLength === 0 || nameLength > 128) throw new Error('Group name must be 1..128 bytes');
    if (options?.selfMd !== undefined && new TextEncoder().encode(options.selfMd).length > 16 * 1024) throw new Error('self.md exceeds 16384 bytes');
    const result = await this.groupManager.createGroup(name);
    if (options?.public) {
      this.groupRepo.setPublic(result.groupId, true, options.selfMd);
      this.announcePublicGroups();
    }
    return result;
  }

  async inviteToGroup(groupId: string, peerPublicKey: string): Promise<void> {
    const gid = hexToBytes(groupId);
    const pk = hexToBytes(peerPublicKey);
    await this.groupManager.inviteToGroup(gid, pk);
  }

  async joinGroup(groupId: string): Promise<void> {
    const gid = hexToBytes(groupId);
    await this.groupManager.joinGroup(gid);
  }

  async leaveGroup(groupId: string): Promise<void> {
    const gid = hexToBytes(groupId);
    await this.groupManager.leaveGroup(gid);
    this.groups.delete(groupId);
  }

  async kickFromGroup(groupId: string, memberPublicKey: string): Promise<void> {
    const gid = hexToBytes(groupId);
    const pk = hexToBytes(memberPublicKey);
    await this.groupManager.kickFromGroup(gid, pk);
  }

  listGroups(): GroupInfo[] {
    const stored = this.groupRepo.list();
    return stored.map((g) => ({
      groupId: new Uint8Array(g.group_id),
      name: g.name,
      role: g.role as 'admin' | 'member',
      createdAt: g.created_at,
      joinedAt: g.joined_at ?? g.created_at,
      memberCount: this.groupRepo.getMembers(new Uint8Array(g.group_id)).length,
      selfMd: g.self_md ?? undefined,
      isPublic: g.is_public === 1,
    }));
  }

  getGroupMembers(groupId: string): MemberInfo[] {
    const gid = hexToBytes(groupId);
    const members = this.groupRepo.getMembers(gid);
    return members.map((m) => {
      const pk = new Uint8Array(m.public_key);
      const peer = this.peerRepo.find(pk);
      return {
        publicKey: pk,
        fingerprint: fingerprintFromPublicKey(pk),
        role: m.role,
        displayName: peer?.display_name ?? undefined,
      };
    });
  }

  // ---- Messaging ----

  async sendGroupMessage(groupId: string, content: string): Promise<void> {
    const gid = hexToBytes(groupId);
    await this.groupManager.sendGroupMessage(gid, content);
  }

  async sendDirectMessage(
    peerPublicKey: string,
    content: string,
  ): Promise<void> {
    const pk = hexToBytes(peerPublicKey);
    const peerFingerprint = fingerprintFromPublicKey(pk);
    const session = this.swarm.getSession(peerFingerprint);
    if (!session) {
      throw new Error('Peer not connected');
    }

    const plaintext = new TextEncoder().encode(content);

    // Load or initialize Double Ratchet state for this peer
    let ratchetState = this.ratchetStateRepo.load(peerFingerprint);

    if (!ratchetState) {
      // First message to this peer — initialize as sender
      if (!session.peerXPublicKey) {
        throw new Error(
          'Peer X25519 public key not available for DM encryption',
        );
      }
      const sharedSecret = computeSharedSecret(
        this.identity.xPrivateKey,
        session.peerXPublicKey,
      );
      ratchetState = DoubleRatchet.initSender(
        sharedSecret,
        session.peerXPublicKey,
      );
    }

    // Encrypt with Double Ratchet
    const encrypted = DoubleRatchet.encrypt(ratchetState, plaintext);

    // Save updated ratchet state
    this.ratchetStateRepo.save(peerFingerprint, encrypted.nextState);

    const messageId = createId();
    const message: ProtocolMessage = {
      type: MessageType.DirectMessage,
      senderFingerprint: this.identity.fingerprint,
      recipientFingerprint: peerFingerprint,
      ratchetPublicKey: encrypted.ratchetPublicKey,
      previousChainLength: encrypted.previousChainLength,
      messageNumber: encrypted.messageNumber,
      ciphertext: encrypted.ciphertext,
      nonce: encrypted.nonce,
      timestamp: Date.now(),
    };

    session.send(message);

    this.messageRepo.insert({
      id: messageId,
      peerPublicKey: pk,
      senderPublicKey: this.identity.edPublicKey,
      content,
      timestamp: Date.now(),
      type: 'direct',
    });

    this.emit('dm:sent', {
      peerPublicKey: pk,
      content,
      messageId,
    });
  }

  getMessages(opts: {
    groupId?: string;
    peerPublicKey?: string;
    limit?: number;
    before?: string;
  }): Message[] {
    const queryOpts = {
      groupId: opts.groupId ? hexToBytes(opts.groupId) : undefined,
      peerPublicKey: opts.peerPublicKey
        ? hexToBytes(opts.peerPublicKey)
        : undefined,
      limit: opts.limit,
      before: opts.before,
    };

    const stored = this.messageRepo.query(queryOpts);
    return stored.map((m) => ({
      id: m.id,
      groupId: m.group_id ? new Uint8Array(m.group_id) : undefined,
      senderPublicKey: m.sender_public_key
        ? new Uint8Array(m.sender_public_key)
        : undefined,
      peerPublicKey: m.peer_public_key
        ? new Uint8Array(m.peer_public_key)
        : undefined,
      content: m.content,
      timestamp: m.timestamp,
      type: m.type,
    }));
  }

  // ---- Peers ----

  listPeers(): PeerInfo[] {
    const stored = this.peerRepo.list();
    return stored.map((p) => ({
      publicKey: new Uint8Array(p.public_key),
      fingerprint: p.fingerprint,
      displayName: p.display_name ?? undefined,
      online: this.peers.has(p.fingerprint),
      trusted: p.trusted === 1,
      lastSeen: p.last_seen ?? 0,
    }));
  }

  trustPeer(peerPublicKey: string): void {
    const pk = hexToBytes(peerPublicKey);
    this.peerRepo.trust(pk);
  }

  untrustPeer(peerPublicKey: string): void {
    const pk = hexToBytes(peerPublicKey);
    this.peerRepo.untrust(pk);
  }

  makeGroupPublic(groupId: string, selfMd: string): void {
    if (new TextEncoder().encode(selfMd).length > 16 * 1024) throw new Error('self.md exceeds 16384 bytes');
    const gid = hexToBytes(groupId);
    const latestEpoch = this.groupEpochRepo.getLatestEpoch(groupId);
    if (latestEpoch) {
      const isAdmin = latestEpoch.epoch.members.some(
        (m) =>
          m.role === 'admin' &&
          buffersEqual(m.publicKey, this.identity.edPublicKey),
      );
      if (!isAdmin) {
        throw new Error('Not authorized: not admin in latest epoch');
      }
    }
    this.groupRepo.setPublic(gid, true, selfMd);
    this.announcePublicGroups();
  }

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

  async joinPublicGroup(groupId: string): Promise<void> {
    const gid = hexToBytes(groupId);
    const discovered = this.discoveredGroupRepo.find(gid);
    const name = discovered?.name ?? 'Public Group';
    if (!discovered) throw new Error('Public group authority not discovered');
    await this.groupManager.joinGroup(gid, name, {
      creatorPublicKey: new Uint8Array(discovered.authority_key),
      genesisEpochData: new Uint8Array(discovered.genesis_epoch_data),
      genesisSignature: new Uint8Array(discovered.genesis_signature),
      genesisHash: new Uint8Array(discovered.genesis_hash),
    });
    this.discoveredGroupRepo.remove(gid);
  }

  // ---- Private ----

  private announcePublicGroups(): void {
    const announce = this.buildPublicAnnounce();
    if (!announce) return;

    for (const session of this.swarm.getAllSessions()) {
      try {
        session.send(announce);
      } catch {
        // Ignore send errors on closed sessions
      }
    }
  }

  private buildPublicAnnounce(): NetworkAnnounceMessage | null {
    const groups = this.groupRepo
      .listPublic()
      .flatMap((group) => {
        const groupId = Uint8Array.from(group.group_id);
        const genesis = this.groupEpochRepo.getEpochByVersion(
          Buffer.from(groupId).toString('hex'),
          0,
        );
        if (!genesis) return [];
        return [
          {
            groupId,
            name: group.name,
            selfMd: group.self_md ?? '',
            memberCount: this.groupRepo.getMembers(groupId).length,
            genesisEpochData: serializeEpoch(genesis.epoch),
            genesisSignature: genesis.signature,
            genesisHash: genesis.hash,
          },
        ];
      })
      .sort((a, b) =>
        Buffer.compare(Buffer.from(a.groupId), Buffer.from(b.groupId)),
      );
    if (groups.length === 0) return null;
    const timestamp = Date.now();
    return {
      type: MessageType.NetworkAnnounce,
      protocolVersion: NETWORK_ANNOUNCE_VERSION,
      groups,
      signature: signAnnounce(groups, timestamp, this.identity.edPrivateKey),
      timestamp,
    };
  }

  private async loadOrGenerateIdentity(passphrase: string | undefined): Promise<void> {
    // A losing concurrent starter re-reads the winner rather than continuing
    // from stale plaintext or replacing its encrypted key material.
    for (let attempt = 0; attempt < 4; attempt++) {
      const stored = this.identityRepo.load();
      const keyData = this.identityRepo.loadEncryptedKeys();

      if (!stored && keyData) {
        if (!passphrase) {
          throw new IdentityKeyStorageError(
            'Encrypted key storage exists without its identity row; a passphrase is required to recover it',
            'KEY_STORAGE_ORPHANED',
          );
        }
        const privateKey = await this.unlockEncryptedKey(keyData, passphrase);
        const publicKey = deriveEd25519PublicKey(privateKey);
        if (!this.identityRepo.recoverOrphanedIdentity(keyData, publicKey)) continue;
        await this.ensurePlaintextErased(privateKey);
        this.setIdentity(privateKey, publicKey, this.options.displayName);
        return;
      }

      if (!stored) {
        if (passphrase !== undefined) this.assertStrongPassphrase(passphrase);
        const identity = generateIdentity(this.options.displayName);
        const created = passphrase
          ? await this.createProtectedIdentity(identity, passphrase)
          : this.identityRepo.createPlaintext(
              identity.edPrivateKey,
              identity.edPublicKey,
              this.options.displayName,
            );
        if (!created) continue;
        this.identity = identity;
        this.database.enforcePermissions();
        return;
      }

      const publicKey = new Uint8Array(stored.ed_public_key);
      if (publicKey.length !== 32) {
        this.corrupt('Stored identity public key has an invalid length');
      }

      if (keyData) {
        if (!passphrase) {
          throw new IdentityKeyStorageError(
            'Identity is passphrase-protected; a passphrase is required',
            'PASSPHRASE_REQUIRED',
          );
        }
        const privateKey = await this.unlockEncryptedKey(keyData, passphrase);
        this.assertPrivateKeyMatchesPublicKey(privateKey, publicKey);

        if (stored.ed_private_key !== null) {
          const plaintext = new Uint8Array(stored.ed_private_key);
          if (!buffersEqual(plaintext, privateKey)) {
            this.corrupt('Plaintext and encrypted identity keys do not match');
          }
          if (!this.identityRepo.removePlaintextPrivateKey(plaintext, publicKey)) continue;
          await this.ensurePlaintextErased(privateKey, true);
        } else {
          // Recovers a prior startup that committed the migration but could not
          // truncate a busy WAL before failing closed.
          await this.ensurePlaintextErased(privateKey);
        }
        this.setIdentity(privateKey, publicKey, stored.display_name ?? this.options.displayName);
        return;
      }

      if (stored.ed_private_key === null) {
        this.corrupt('Identity key storage is incomplete');
      }
      const privateKey = new Uint8Array(stored.ed_private_key);
      this.assertPrivateKeyMatchesPublicKey(privateKey, publicKey);

      if (!passphrase) {
        this.setIdentity(privateKey, publicKey, stored.display_name ?? this.options.displayName);
        return;
      }

      this.assertStrongPassphrase(passphrase);
      const salt = crypto.getRandomValues(new Uint8Array(32));
      const wrappingKey = await deriveWrappingKey(passphrase, salt);
      const { ciphertext, nonce } = encrypt(wrappingKey, privateKey);
      const result = this.identityRepo.migrateToEncrypted(
        privateKey,
        publicKey,
        salt,
        nonce,
        ciphertext,
      );
      if (result !== 'migrated') continue;
      await this.ensurePlaintextErased(privateKey, true);
      this.setIdentity(privateKey, publicKey, stored.display_name ?? this.options.displayName);
      return;
    }

    throw new IdentityKeyStorageError(
      'Identity changed repeatedly during startup',
      'KEY_STORAGE_CORRUPT',
    );
  }

  private async resolvePassphrase(): Promise<string | undefined> {
    if (this.options.passphrase !== undefined && this.options.secretProvider) {
      throw new IdentityKeyStorageError(
        'Configure either passphrase or secretProvider, not both',
        'INVALID_PASSPHRASE',
      );
    }
    let passphrase = this.options.passphrase;
    if (this.options.secretProvider) {
      try {
        passphrase = await this.options.secretProvider();
      } catch (cause) {
        throw new IdentityKeyStorageError(
          'Unable to read the identity passphrase from the configured secret provider',
          'SECRET_PROVIDER_FAILED',
          { cause },
        );
      }
    }
    if (passphrase === undefined) return undefined;
    if (passphrase.length === 0) {
      throw new IdentityKeyStorageError(
        'Passphrase must not be empty',
        'INVALID_PASSPHRASE',
      );
    }
    return passphrase;
  }

  private assertStrongPassphrase(passphrase: string): void {
    if (passphrase.length < 12 || new Set(passphrase).size < 4) {
      throw new IdentityKeyStorageError(
        'Passphrase must be at least 12 characters and contain at least 4 distinct characters',
        'INVALID_PASSPHRASE',
      );
    }
  }

  private async createProtectedIdentity(
    identity: AgentIdentity,
    passphrase: string,
  ): Promise<boolean> {
    this.assertStrongPassphrase(passphrase);
    const salt = crypto.getRandomValues(new Uint8Array(32));
    const wrappingKey = await deriveWrappingKey(passphrase, salt);
    const { ciphertext, nonce } = encrypt(wrappingKey, identity.edPrivateKey);
    return this.identityRepo.createEncrypted(
      identity.edPublicKey,
      this.options.displayName,
      salt,
      nonce,
      ciphertext,
    );
  }

  private async unlockEncryptedKey(
    keyData: { salt: Buffer; nonce: Buffer; ciphertext: Buffer },
    passphrase: string,
  ): Promise<Uint8Array> {
    if (
      keyData.salt.length !== 32 ||
      keyData.nonce.length !== 24 ||
      keyData.ciphertext.length !== 48
    ) {
      this.corrupt('Encrypted identity key data has invalid lengths');
    }
    try {
      const wrappingKey = await deriveWrappingKey(passphrase, new Uint8Array(keyData.salt));
      const privateKey = decrypt(
        wrappingKey,
        new Uint8Array(keyData.nonce),
        new Uint8Array(keyData.ciphertext),
      );
      if (privateKey.length !== 32) {
        this.corrupt('Decrypted identity key has an invalid length');
      }
      return privateKey;
    } catch (cause) {
      if (cause instanceof IdentityKeyStorageError) throw cause;
      throw new IdentityKeyStorageError(
        'Unable to unlock identity; the passphrase is incorrect or encrypted key data is corrupt',
        'UNLOCK_FAILED',
        { cause },
      );
    }
  }

  private async ensurePlaintextErased(
    privateKey: Uint8Array,
    forceCheckpoint = false,
  ): Promise<void> {
    try {
      await this.database.erasePlaintextSnapshots(privateKey, forceCheckpoint);
    } catch (cause) {
      throw new IdentityKeyStorageError(
        'Encrypted identity was saved, but a plaintext database snapshot could not be destroyed',
        'PLAINTEXT_ERASURE_FAILED',
        { cause },
      );
    }
  }

  private setIdentity(
    privateKey: Uint8Array,
    publicKey: Uint8Array,
    displayName?: string,
  ): void {
    const { xPrivateKey, xPublicKey } = deriveX25519KeyPair(privateKey);
    this.identity = {
      edPublicKey: publicKey,
      edPrivateKey: privateKey,
      xPrivateKey,
      xPublicKey,
      fingerprint: fingerprintFromPublicKey(publicKey),
      displayName,
    };
  }

  private corrupt(message: string): never {
    throw new IdentityKeyStorageError(message, 'KEY_STORAGE_CORRUPT');
  }

  private assertPrivateKeyMatchesPublicKey(
    privateKey: Uint8Array,
    publicKey: Uint8Array,
  ): void {
    try {
      const probe = new TextEncoder().encode('networkselfmd-identity-key-check-v1');
      if (privateKey.length !== 32 || !verify(sign(probe, privateKey), probe, publicKey)) {
        throw new Error('Key pair mismatch');
      }
    } catch (cause) {
      throw new IdentityKeyStorageError(
        'Identity private key does not match the stored public key',
        'KEY_STORAGE_CORRUPT',
        { cause },
      );
    }
  }

  private setupSwarmEvents(): void {
    this.swarm.on('peer:connected', (result: HandshakeResult) => {
      const fp = result.peerFingerprint;
      this.peers.set(fp, result.session);

      this.emit('peer:connected', {
        publicKey: result.peerPublicKey,
        fingerprint: fp,
        displayName: result.peerDisplayName,
      });
    });

    this.swarm.on('peer:verified', (result: HandshakeResult) => {
      this.emit('peer:verified', {
        publicKey: result.peerPublicKey,
        fingerprint: result.peerFingerprint,
        displayName: result.peerDisplayName,
      });

      // A new connection receives only keys for groups where its authenticated
      // identity appears in the current signed epoch. Rotation remains the
      // only operation that intentionally fans out to all members.
      const groups = this.groupRepo.list();
      for (const group of groups) {
        const gid = Uint8Array.from(group.group_id);
        this.groupManager
          .distributeSenderKeyToPeer(gid, result.session)
          .catch((err) => {
            this.emit('error', err);
          });
      }

      this.groupManager.syncWithPeer(result.session);

      // Announce our public groups to new peer
      const announce = this.buildPublicAnnounce();
      if (announce) {
        result.session.send(announce);
      }
    });

    this.swarm.on(
      'peer:disconnected',
      (info: { peerPublicKey: Uint8Array; peerFingerprint: string }) => {
        this.peers.delete(info.peerFingerprint);
        this.emit('peer:disconnected', {
          publicKey: info.peerPublicKey,
          fingerprint: info.peerFingerprint,
        });
      },
    );

    this.swarm.on('error', (err: Error) => {
      this.emit('error', err);
    });
  }

  private setupRouterHandlers(): void {
    const router = this.swarm.router;

    router.on(MessageType.SenderKeyDistribution, (session, message) => {
      this.groupManager.handleSenderKeyDistribution(
        session,
        message as SenderKeyDistributionMessage,
      );
    });

    router.on(MessageType.GroupMessage, (session, message) => {
      this.groupManager
        .handleGroupMessage(session, message as GroupEncryptedMessage)
        .catch((err) => {
          this.emit('error', err);
        });
    });

    router.on(MessageType.GroupManagement, (session, message) => {
      this.groupManager.handleGroupManagement(
        session,
        message as GroupManagementMessage,
      ).catch((err) => this.emit('error', err));
    });

    router.on(MessageType.GroupEpoch, (session, message) => {
      this.groupManager.handleGroupEpoch(session, message as GroupEpochMessage);
    });

    router.on(MessageType.DirectMessage, (session, message) => {
      this.handleDirectMessage(session, message as DirectEncryptedMessage);
    });

    router.on(MessageType.NetworkAnnounce, (session, message) => {
      const announce = message as NetworkAnnounceMessage;
      if (!session.peerPublicKey) return;
      const peerPublicKey = session.peerPublicKey;

      try {
        assertAnnounceShape(announce, Date.now());
      } catch (error) {
        this.emit('error', new Error(`Rejected NetworkAnnounce: ${(error as Error).message}`));
        return;
      }
      if (!verifyAnnounce(announce.groups, announce.timestamp, announce.signature, peerPublicKey, announce.protocolVersion)) {
        this.emit('error', new Error('Rejected NetworkAnnounce: invalid canonical signature'));
        return;
      }
      if (!announce.groups.every((group) => verifyAnnouncedGroupAuthority(group, peerPublicKey))) {
        this.emit('error', new Error('Rejected NetworkAnnounce: invalid group authority proof'));
        return;
      }
      if (!this.announceStateRepo.accept(peerPublicKey, announce.timestamp)) {
        this.emit('error', new Error('Rejected NetworkAnnounce: replayed or rate limited'));
        return;
      }

      for (const g of announce.groups) {
        const accepted = this.discoveredGroupRepo.upsert(
          g.groupId,
          g.name,
          g.selfMd,
          g.memberCount,
          session.peerPublicKey,
          g.genesisEpochData,
          g.genesisSignature,
          g.genesisHash,
          announce.timestamp,
        );
        if (!accepted) this.emit('error', new Error('Rejected NetworkAnnounce: same-group authority overwrite'));
      }

      this.emit('network:announce', {
        peerFingerprint: session.peerFingerprint,
        groups: announce.groups,
      });
    });

    router.on(MessageType.Ack, (_session, message) => {
      this.emit('ack', message);
    });
  }

  private setupGroupManagerEvents(): void {
    this.groupManager.on('group:message', (data) => {
      this.emit('group:message', data);
    });

    this.groupManager.on('group:joined', (data) => {
      this.emit('group:joined', data);
    });

    this.groupManager.on('group:invited', (data) => {
      this.emit('group:invited', data);
    });

    this.groupManager.on('group:memberLeft', (data) => {
      this.emit('group:memberLeft', data);
    });

    this.groupManager.on('group:keysRotated', (data) => {
      this.emit('group:keysRotated', data);
    });

    this.groupManager.on('group:epochUpdated', (data) => {
      this.emit('group:epochUpdated', data);
    });

    this.groupManager.on('error', (err) => {
      this.emit('error', err);
    });
  }

  private handleDirectMessage(
    session: PeerSession,
    message: DirectEncryptedMessage,
  ): void {
    if (!session.peerPublicKey || !session.peerFingerprint) return;

    const senderFingerprint = session.peerFingerprint;

    // Load or initialize Double Ratchet state for this peer
    let ratchetState = this.ratchetStateRepo.load(senderFingerprint);

    if (!ratchetState) {
      // First message from this peer — initialize as receiver
      if (!session.peerXPublicKey) {
        this.emit(
          'error',
          new Error('Peer X25519 public key not available for DM decryption'),
        );
        return;
      }
      const sharedSecret = computeSharedSecret(
        this.identity.xPrivateKey,
        session.peerXPublicKey,
      );
      ratchetState = DoubleRatchet.initReceiver(sharedSecret, {
        privateKey: this.identity.xPrivateKey,
        publicKey: this.identity.xPublicKey,
      });
    }

    // Decrypt with Double Ratchet
    let decrypted: { plaintext: Uint8Array; nextState: DoubleRatchetState };
    try {
      decrypted = DoubleRatchet.decrypt(
        ratchetState,
        message.ratchetPublicKey,
        message.previousChainLength,
        message.messageNumber,
        message.nonce,
        message.ciphertext,
      );
    } catch {
      this.emit('error', new Error('Failed to decrypt direct message'));
      return;
    }

    // Save updated ratchet state
    this.ratchetStateRepo.save(senderFingerprint, decrypted.nextState);

    const content = new TextDecoder().decode(decrypted.plaintext);

    this.messageRepo.insert({
      id: createId(),
      senderPublicKey: session.peerPublicKey,
      peerPublicKey: session.peerPublicKey,
      content,
      timestamp: message.timestamp ?? Date.now(),
      type: 'direct',
    });

    this.emit('dm:message', {
      senderPublicKey: session.peerPublicKey,
      senderFingerprint: session.peerFingerprint,
      content,
      timestamp: message.timestamp,
    });
  }
}

async function deriveWrappingKey(
  passphrase: string,
  salt: Uint8Array,
): Promise<Uint8Array> {
  const hash = await argon2id({
    password: passphrase,
    salt,
    parallelism: 1,
    iterations: 3,
    memorySize: 65536, // 64MB
    hashLength: 32,
    outputType: 'binary',
  });
  return new Uint8Array(hash);
}

function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error('Expected a 32-byte hexadecimal identifier');
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

function buffersEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
