import { EventEmitter } from 'node:events';
import { argon2id } from 'hash-wasm';
import {
  generateIdentity,
  fingerprintFromPublicKey,
  encrypt,
  decrypt,
  deriveKey,
  sign,
  verify,
  computeSharedSecret,
  DoubleRatchet,
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
} from './storage/index.js';
import { SwarmManager } from './network/swarm.js';
import type { PeerSession } from './network/connection.js';
import type { HandshakeResult } from './network/handshake.js';
import { GroupManager } from './groups/group-manager.js';

export interface AgentOptions {
  dataDir: string;
  passphrase?: string;
  displayName?: string;
  bootstrap?: Array<{ host: string; port: number }>;
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
  private swarm!: SwarmManager;
  private groupManager!: GroupManager;

  constructor(options: AgentOptions) {
    super();
    this.options = options;

    // Prevent unhandled 'error' events from crashing the process.
    // Node.js EventEmitter kills the process if 'error' is emitted with no listener.
    this.on('error', (err: Error) => {
      console.error('[Agent error]', err.message);
    });
  }

  async start(): Promise<void> {
    if (this.isRunning) return;

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

    // Load or generate identity
    await this.loadOrGenerateIdentity();

    // Init swarm
    this.swarm = new SwarmManager({
      identity: this.identity,
      bootstrap: this.options.bootstrap,
    });

    // Init group manager
    this.groupManager = new GroupManager({
      identity: this.identity,
      swarm: this.swarm,
      groups: this.groupRepo,
      messages: this.messageRepo,
      senderKeys: this.senderKeyRepo,
      peers: this.peerRepo,
    });

    // Wire up events
    this.setupSwarmEvents();
    this.setupRouterHandlers();
    this.setupGroupManagerEvents();

    // Start networking
    await this.swarm.start();

    // Rejoin existing groups
    await this.groupManager.rejoinAllGroups();

    // Join TTYA topic
    const ttyaTopic = deriveKey(
      this.identity.edPublicKey,
      'networkselfmd-ttya-v1',
      '',
      32,
    );
    await this.swarm.join(Buffer.from(ttyaTopic));

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
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return;

    this.isRunning = false;

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

  // ---- Groups ----

  async createGroup(
    name: string,
    options?: { public?: boolean; selfMd?: string },
  ): Promise<{ groupId: Uint8Array; topic: Buffer }> {
    const result = await this.groupManager.createGroup(name);
    if (options?.public) {
      this.groupRepo.setPublic(result.groupId, true, options.selfMd);
      this.announcePublicGroups();
    }
    return result;
  }

  async inviteToGroup(
    groupId: string,
    peerPublicKey: string,
  ): Promise<void> {
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

  async kickFromGroup(
    groupId: string,
    memberPublicKey: string,
  ): Promise<void> {
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

  async sendGroupMessage(
    groupId: string,
    content: string,
  ): Promise<void> {
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
        throw new Error('Peer X25519 public key not available for DM encryption');
      }
      const sharedSecret = computeSharedSecret(this.identity.xPrivateKey, session.peerXPublicKey);
      ratchetState = DoubleRatchet.initSender(sharedSecret, session.peerXPublicKey);
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
      peerPublicKey: opts.peerPublicKey ? hexToBytes(opts.peerPublicKey) : undefined,
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
    const gid = hexToBytes(groupId);
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
    await this.groupManager.joinGroup(gid, name);
    this.discoveredGroupRepo.remove(gid);
  }

  // ---- Private ----

  private announcePublicGroups(): void {
    const publicGroups = this.groupRepo.listPublic();
    if (publicGroups.length === 0) return;

    const announce: ProtocolMessage = {
      type: MessageType.NetworkAnnounce,
      groups: publicGroups.map((g) => ({
        groupId: Uint8Array.from(g.group_id),
        name: g.name,
        selfMd: g.self_md ?? '',
        memberCount: this.groupRepo.getMembers(Uint8Array.from(g.group_id)).length,
      })),
      timestamp: Date.now(),
    };

    for (const session of this.swarm.getAllSessions()) {
      try {
        session.send(announce);
      } catch {
        // Ignore send errors on closed sessions
      }
    }
  }

  private async loadOrGenerateIdentity(): Promise<void> {
    const stored = this.identityRepo.load();

    if (stored) {
      let edPrivateKey: Uint8Array = new Uint8Array(stored.ed_private_key);
      const edPublicKey: Uint8Array = new Uint8Array(stored.ed_public_key);

      // If passphrase-protected, decrypt
      if (this.options.passphrase) {
        const keyData = this.identityRepo.loadEncryptedKeys();
        if (keyData) {
          const wrappingKey = await deriveWrappingKey(
            this.options.passphrase,
            new Uint8Array(keyData.salt),
          );
          edPrivateKey = decrypt(
            wrappingKey,
            new Uint8Array(keyData.nonce),
            new Uint8Array(keyData.ciphertext),
          );
        }
      }

      // When loading from storage, we don't have x keys stored,
      // so derive placeholder values. In a full implementation these would be stored too.
      const xPrivateKey = deriveKey(edPrivateKey, 'x25519-private', '', 32);
      const xPublicKey = deriveKey(edPublicKey, 'x25519-public', '', 32);

      this.identity = {
        edPublicKey,
        edPrivateKey,
        xPrivateKey,
        xPublicKey,
        fingerprint: fingerprintFromPublicKey(edPublicKey),
        displayName: stored.display_name ?? this.options.displayName,
      };
    } else {
      const identity = generateIdentity(this.options.displayName);

      this.identity = identity;

      this.identityRepo.save(identity.edPrivateKey, identity.edPublicKey, this.options.displayName);

      // Encrypt at rest if passphrase given
      if (this.options.passphrase) {
        const salt = crypto.getRandomValues(new Uint8Array(32));
        const wrappingKey = await deriveWrappingKey(this.options.passphrase, salt);
        const { ciphertext, nonce } = encrypt(wrappingKey, identity.edPrivateKey);
        this.identityRepo.saveEncryptedKeys(salt, nonce, ciphertext);
      }
    }
  }

  private setupSwarmEvents(): void {
    this.swarm.on('peer:connected', (result: HandshakeResult) => {
      const fp = result.peerFingerprint;
      this.peers.set(fp, result.session);

      // Store peer
      this.peerRepo.upsert(
        result.peerPublicKey,
        fp,
        result.peerDisplayName,
      );

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

      // Distribute sender keys for all groups to new peer
      const groups = this.groupRepo.list();
      for (const group of groups) {
        const gid = Uint8Array.from(group.group_id);
        this.groupManager.distributeSenderKeys(gid).catch((err) => {
          this.emit('error', err);
        });
      }

      // Announce our public groups to new peer
      const publicGroups = this.groupRepo.listPublic();
      if (publicGroups.length > 0) {
        const announce: ProtocolMessage = {
          type: MessageType.NetworkAnnounce,
          groups: publicGroups.map((g) => ({
            groupId: Uint8Array.from(g.group_id),
            name: g.name,
            selfMd: g.self_md ?? '',
            memberCount: this.groupRepo.getMembers(Uint8Array.from(g.group_id)).length,
          })),
          timestamp: Date.now(),
        };
        result.session.send(announce);
      }
    });

    this.swarm.on('peer:disconnected', (info: { peerPublicKey: Uint8Array; peerFingerprint: string }) => {
      this.peers.delete(info.peerFingerprint);
      this.emit('peer:disconnected', {
        publicKey: info.peerPublicKey,
        fingerprint: info.peerFingerprint,
      });
    });

    this.swarm.on('error', (err: Error) => {
      this.emit('error', err);
    });
  }

  private setupRouterHandlers(): void {
    const router = this.swarm.router;

    router.on(MessageType.SenderKeyDistribution, (_session, message) => {
      this.groupManager.handleSenderKeyDistribution(
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
      );
    });

    router.on(MessageType.DirectMessage, (session, message) => {
      this.handleDirectMessage(session, message as DirectEncryptedMessage);
    });

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

    router.on(MessageType.TTYARequest, (session, message) => {
      this.emit('ttya:request', { session, message });
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
        this.emit('error', new Error('Peer X25519 public key not available for DM decryption'));
        return;
      }
      const sharedSecret = computeSharedSecret(this.identity.xPrivateKey, session.peerXPublicKey);
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
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}
