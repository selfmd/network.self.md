import { EventEmitter } from 'node:events';
import { argon2id } from 'hash-wasm';
import {
  generateIdentity,
  fingerprintFromPublicKey,
  encrypt,
  decrypt,
  deriveKey,
  deriveX25519FromEd25519,
} from '@networkselfmd/core';
import type {
  AgentIdentity,
  PeerInfo,
  GroupInfo,
  DirectEncryptedMessage,
  SenderKeyDistributionMessage,
  GroupEncryptedMessage,
  GroupManagementMessage,
  PolicyAuditEntry,
  PolicyConfig,
  PolicyDecision,
  PrivateInboundMessageEvent,
  PublicActivityEvent,
} from '@networkselfmd/core';
import { MessageType } from '@networkselfmd/core';
import { InboundEventQueue } from './events/inbound-queue.js';
import { AgentPolicy } from './policy/agent-policy.js';
import { PolicyAuditLog } from './policy/audit-log.js';
import { PolicyGate } from './policy/policy-gate.js';
import {
  validatePolicyConfig,
  PolicyConfigValidationError,
} from './policy/validate-config.js';
import {
  AgentDatabase,
  IdentityRepository,
  PeerRepository,
  GroupRepository,
  MessageRepository,
  SenderKeyRepository,
  PolicyConfigRepository,
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
  // Initial policy gate configuration. When omitted, defaults to {} which
  // is intentionally restrictive: AgentPolicy.decide returns 'ignore' /
  // 'not-addressed' for events with no @-mention, no trusted sender, and
  // no interest hit, so unconfigured agents do not surface noise to the
  // inbound queue. Tighten/loosen at runtime via agent.setPolicyConfig().
  policyConfig?: PolicyConfig;
  // Audit log capacity (entries). Default: 1000.
  policyAuditMax?: number;
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
  readonly inboundQueue: InboundEventQueue = new InboundEventQueue();
  // Policy machinery — constructed in start() once the database/repos and
  // identity are ready. The gate is the single chokepoint between
  // GroupManager's authenticated `inbound:message` events and any
  // agent-runtime side effect (queue push, public re-emit). See
  // docs/POLICY.md. Marked readonly to match `inboundQueue` and prevent
  // callers from swapping the gate or audit log out from under the
  // wiring set up in start().
  readonly policy!: AgentPolicy;
  readonly policyAudit!: PolicyAuditLog;
  readonly policyGate!: PolicyGate;

  private options: AgentOptions;
  private database!: AgentDatabase;
  private identityRepo!: IdentityRepository;
  private peerRepo!: PeerRepository;
  private groupRepo!: GroupRepository;
  private messageRepo!: MessageRepository;
  private senderKeyRepo!: SenderKeyRepository;
  private policyConfigRepo!: PolicyConfigRepository;
  private swarm!: SwarmManager;
  private groupManager!: GroupManager;

  constructor(options: AgentOptions) {
    super();
    this.options = options;
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
    this.policyConfigRepo = new PolicyConfigRepository(db);

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

    // Init policy machinery. The gate sits between GroupManager events
    // and any agent-runtime side effect; see setupGroupManagerEvents.
    // The readonly modifier on policy/policyAudit/policyGate above
    // documents post-start immutability; we use a typed cast here for
    // the one-time assignment so callers don't see the seam.
    const mut = this as {
      -readonly [K in 'policy' | 'policyAudit' | 'policyGate']: Agent[K];
    };
    mut.policyAudit = new PolicyAuditLog({ max: this.options.policyAuditMax });

    // Precedence: persisted operator config wins. Operators that have
    // ever called agent.setPolicyConfig (via CLI, MCP, or code) expect
    // their last-saved config to apply across restarts. Programmatic
    // AgentOptions.policyConfig is a "first-time default" used only
    // when no row has been persisted yet, and is NOT auto-persisted.
    const persisted = this.policyConfigRepo.load();
    const initialConfig = persisted ?? this.options.policyConfig ?? {};
    mut.policy = new AgentPolicy({
      agent: this,
      config: initialConfig,
    });
    mut.policyGate = new PolicyGate({
      policy: mut.policy,
      audit: mut.policyAudit,
      isMember: (groupId, publicKey) => {
        const members = this.groupRepo.getMembers(groupId);
        for (const m of members) {
          if (bytesEqual(new Uint8Array(m.public_key), publicKey)) return true;
        }
        return false;
      },
    });
    mut.policyGate.on('decision', (decision: PolicyDecision) => {
      this.emit('policy:decision', decision);
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

  async createGroup(name: string): Promise<GroupInfo> {
    const { groupId } = await this.groupManager.createGroup(name);
    const fingerprint = Buffer.from(groupId).toString('hex');
    const now = Date.now();
    const info: GroupInfo = {
      groupId,
      name,
      role: 'admin',
      createdAt: now,
      joinedAt: now,
      memberCount: 1,
    };
    this.groups.set(fingerprint, info);
    return info;
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
    _peerPublicKey: string,
    _content: string,
  ): Promise<void> {
    // Intentionally fail-closed. The previous implementation encrypted with
    // `identity.edPrivateKey.subarray(0,32)` on send and `peerPublicKey.subarray(0,32)`
    // on receive — those are not the same key, so no recipient could ever
    // decrypt. Rather than ship a function that looks like it works, we
    // surface a clear error until Double Ratchet is wired in.
    throw new Error(
      'Direct messages are not yet implemented: Double Ratchet session setup pending',
    );
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

  // ---- Policy ----

  // Returns a defensive copy of the current runtime policy configuration.
  // Lists are sliced so callers cannot mutate the live config; mutating
  // the returned arrays does not affect AgentPolicy.decide.
  getPolicyConfig(): PolicyConfig {
    const c = this.policy.getConfig();
    const out: PolicyConfig = {};
    if (c.trustedFingerprints !== undefined) {
      out.trustedFingerprints = c.trustedFingerprints.slice();
    }
    if (c.interests !== undefined) out.interests = c.interests.slice();
    if (c.requireMention !== undefined) out.requireMention = c.requireMention;
    if (c.mentionPrefixLen !== undefined) out.mentionPrefixLen = c.mentionPrefixLen;
    return out;
  }

  // Replace the policy configuration. Validates first; on bad input
  // throws PolicyConfigValidationError without mutating anything. On
  // success, persists to SQLite (so the change survives restart) and
  // updates the live AgentPolicy.config in place. Decisions are pure
  // over (config, identity, event), so the new config takes effect on
  // the very next inbound event.
  setPolicyConfig(config: unknown): void {
    const result = validatePolicyConfig(config);
    if (!result.ok) {
      throw new PolicyConfigValidationError(result.errors);
    }
    this.policyConfigRepo.save(result.config);
    this.policy.setConfig(result.config);
  }

  // Merge `partial` over the current configuration. Use this for
  // single-field updates (e.g. flipping requireMention) without
  // re-supplying the whole config. Validation runs on the merged
  // result; persistence and live update follow the same rules as
  // setPolicyConfig.
  updatePolicyConfig(partial: unknown): void {
    if (partial === null || typeof partial !== 'object' || Array.isArray(partial)) {
      throw new PolicyConfigValidationError([
        { field: 'config', message: 'must be an object' },
      ]);
    }
    const merged: PolicyConfig = {
      ...this.getPolicyConfig(),
      ...(partial as Partial<PolicyConfig>),
    };
    this.setPolicyConfig(merged);
  }

  // Wipe persisted config and reset the runtime to AgentOptions.
  // policyConfig (or {} if none was passed). Useful for tests and for
  // operators that want to start over without restarting the process.
  resetPolicyConfig(): void {
    this.policyConfigRepo.clear();
    this.policy.setConfig(this.options.policyConfig ?? {});
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

  // ---- Private ----

  private async loadOrGenerateIdentity(): Promise<void> {
    const stored = this.identityRepo.load();

    if (stored) {
      let edPrivateKey: Uint8Array = new Uint8Array(stored.ed_private_key);
      const edPublicKey: Uint8Array = new Uint8Array(stored.ed_public_key);

      // If passphrase-protected, the plaintext private key column is a
      // zero-length placeholder; the real key lives encrypted in key_storage.
      if (this.options.passphrase) {
        const keyData = this.identityRepo.loadEncryptedKeys();
        if (!keyData) {
          throw new Error('Identity is passphrase-protected but no encrypted key storage found');
        }
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

      if (edPrivateKey.length !== 32) {
        throw new Error('Invalid stored identity: expected 32-byte Ed25519 seed');
      }

      // Derive X25519 keys via the same Edwards-to-Montgomery conversion used
      // at initial generation. The previous HKDF placeholder produced keys
      // that no peer could ever reconstruct — a latent footgun for DMs.
      const { xPrivateKey, xPublicKey } = deriveX25519FromEd25519(edPrivateKey, edPublicKey);

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

      const passphraseProtected = Boolean(this.options.passphrase);
      this.identityRepo.save(
        identity.edPrivateKey,
        identity.edPublicKey,
        this.options.displayName,
        passphraseProtected,
      );

      // Encrypt at rest if passphrase given. Note that save() above already
      // stored a zero-length placeholder for ed_private_key in that case, so
      // no plaintext copy remains in the identity table.
      if (passphraseProtected) {
        const salt = crypto.getRandomValues(new Uint8Array(32));
        const wrappingKey = await deriveWrappingKey(this.options.passphrase!, salt);
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
        const gid = new Uint8Array(group.group_id);
        this.groupManager.distributeSenderKeys(gid).catch((err) => {
          this.emit('error', err);
        });
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

    // POLICY GATE — every authenticated/decrypted/persisted inbound
    // event from GroupManager passes through here before any
    // agent-runtime side effect. The gate runs validation, dedup,
    // membership recheck, and AgentPolicy.decide(); records a
    // metadata-only audit entry; and only on `allowed: true` does the
    // event reach the inbound queue and external listeners. See
    // docs/POLICY.md for the lifecycle.
    this.groupManager.on('inbound:message', (ev: PrivateInboundMessageEvent) => {
      const outcome = this.policyGate.evaluate(ev);
      this.emit('policy:audit', outcome.entry);
      if (outcome.allowed) {
        this.inboundQueue.push(outcome.ev);
        this.emit('inbound:message', outcome.ev);
      }
    });

    this.groupManager.on('activity:message', (ev: PublicActivityEvent) => {
      this.emit('activity:message', ev);
    });

    this.groupManager.on('error', (err) => {
      this.emit('error', err);
    });
  }

  private handleDirectMessage(
    _session: PeerSession,
    _message: DirectEncryptedMessage,
  ): void {
    // DM receipt is disabled until Double Ratchet is wired. We surface an
    // error event rather than silently dropping, so operators notice.
    // TODO(next-PR): once DM signing + Double Ratchet land, emit a typed
    // `inbound:message` (kind: 'dm') and `activity:message` here, gated on
    // the same post-auth/post-decrypt/post-persist contract as group
    // messages in GroupManager.handleGroupMessage.
    this.emit(
      'error',
      new Error('Received a direct message, but DM handling is not yet implemented'),
    );
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

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
