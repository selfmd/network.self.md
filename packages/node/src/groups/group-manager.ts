import { EventEmitter } from 'node:events';
import { createId } from '@paralleldrive/cuid2';
import {
  sign,
  verify,
  deriveKey,
  SenderKeys,
  fingerprintFromPublicKey,
  createGenesisEpoch,
  createSignedEpoch,
  verifyEpoch,
  serializeEpoch,
  deserializeEpoch,
  hashEpoch,
  groupEpochEnvelopeId,
  signAuthenticatedMessage,
  signGroupEpochEnvelope,
  verifyGroupEpochEnvelope,
  verifyGenesisEpoch,
  SENDER_KEY_CAPABILITY,
} from '@networkselfmd/core';
import type {
  AgentIdentity,
  ProtocolMessage,
  GroupEncryptedMessage,
  SenderKeyDistributionMessage,
  GroupManagementMessage,
  GroupEpochMessage,
  SignedGroupEpoch,
  GroupMemberEntry,
} from '@networkselfmd/core';
import { MessageType } from '@networkselfmd/core';
import { sha256 } from 'hash-wasm';
import type { PeerSession } from '../network/connection.js';
import type { SwarmManager } from '../network/swarm.js';
import type {
  GroupRepository,
  MessageRepository,
  SenderKeyRepository,
  PeerRepository,
  GroupEpochRepository,
  GroupInviteRepository,
  GroupBootstrapRepository,
  ProtocolReplayRepository,
} from '../storage/repositories.js';
import {
  validateAuthenticatedMessage,
  validateFreshTimestamp,
  validateReadySession,
  validateSenderKeyEnvelope,
} from '../network/protocol-security.js';

const KEY_ROTATION_INTERVAL = 100;
export const GROUP_KEY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface GroupManagerOptions {
  identity: AgentIdentity;
  swarm: SwarmManager;
  groups: GroupRepository;
  messages: MessageRepository;
  senderKeys: SenderKeyRepository;
  peers: PeerRepository;
  epochs: GroupEpochRepository;
  invites: GroupInviteRepository;
  replay: ProtocolReplayRepository;
  bootstraps: GroupBootstrapRepository;
  enqueueDelivery?: (groupId: Uint8Array, content: string) => Promise<string>;
}

export class GroupManager extends EventEmitter {
  private identity: AgentIdentity;
  private swarm: SwarmManager;
  private groupRepo: GroupRepository;
  private messageRepo: MessageRepository;
  private senderKeyRepo: SenderKeyRepository;
  private peerRepo: PeerRepository;
  private epochRepo: GroupEpochRepository;
  private inviteRepo: GroupInviteRepository;
  private replayRepo: ProtocolReplayRepository;
  private bootstrapRepo: GroupBootstrapRepository;
  private messageCounters = new Map<string, number>();
  private rotationTimer?: ReturnType<typeof setInterval>;
  private enqueueDelivery?: GroupManagerOptions['enqueueDelivery'];

  constructor(options: GroupManagerOptions) {
    super();
    this.identity = options.identity;
    this.swarm = options.swarm;
    this.groupRepo = options.groups;
    this.messageRepo = options.messages;
    this.senderKeyRepo = options.senderKeys;
    this.peerRepo = options.peers;
    this.epochRepo = options.epochs;
    this.inviteRepo = options.invites;
    this.replayRepo = options.replay;
    this.bootstrapRepo = options.bootstraps;
    this.enqueueDelivery = options.enqueueDelivery;
  }

  startKeyRotation(): void {
    if (this.rotationTimer) return;
    this.rotationTimer = setInterval(() => {
      this.rotateExpiredKeys().catch((error) => this.emit('error', error));
    }, 60_000);
    this.rotationTimer.unref();
  }

  stopKeyRotation(): void {
    if (this.rotationTimer) clearInterval(this.rotationTimer);
    this.rotationTimer = undefined;
  }

  async rotateExpiredKeys(): Promise<void> {
    for (const group of this.groupRepo.list()) {
      await this.rotateExpiredKey(new Uint8Array(group.group_id));
    }
  }

  async rotateExpiredKey(groupId: Uint8Array): Promise<void> {
    const key = this.senderKeyRepo.load(groupId, this.identity.edPublicKey);
    // Count actual encryptions, including per-recipient reliable attempts;
    // both the count and generation age survive a process restart.
    if (key && (key.chain_index >= KEY_ROTATION_INTERVAL ||
      Date.now() - key.generation_created_at >= GROUP_KEY_MAX_AGE_MS)) {
      await this.rotateKeys(groupId);
    }
  }

  broadcastMetadata(groupId: Uint8Array): void {
    const latest = this.epochRepo.getLatestEpoch(Buffer.from(groupId).toString('hex'));
    if (!latest) return;
    for (const member of latest.epoch.members) {
      if (buffersEqual(member.publicKey, this.identity.edPublicKey)) continue;
      const session = this.swarm.getSession(fingerprintFromPublicKey(member.publicKey));
      if (session) this.sendMetadata(groupId, session);
    }
  }

  private sendMetadata(groupId: Uint8Array, session: PeerSession): void {
    if (!session.peerCapabilities.has('group-metadata-v1') || !session.peerPublicKey) return;
    const group = this.groupRepo.find(groupId);
    const latest = this.epochRepo.getLatestEpoch(Buffer.from(groupId).toString('hex'));
    if (!group?.creator_public_key || !latest ||
      !buffersEqual(new Uint8Array(group.creator_public_key), this.identity.edPublicKey) ||
      !this.isAdminInEpoch(latest, this.identity.edPublicKey) ||
      !this.isMemberInEpoch(latest, session.peerPublicKey)) return;
    session.send(signAuthenticatedMessage<GroupManagementMessage>({
      type: MessageType.GroupManagement, action: 'metadata', groupId,
      selfMd: group.self_md ?? '', isPublic: group.is_public === 1,
      metadataVersion: group.metadata_version,
      epochVersion: latest.epoch.version, epochHash: latest.hash,
      senderFingerprint: this.identity.fingerprint,
      recipientFingerprint: validateReadySession(session), timestamp: Date.now(),
    }, this.identity.edPrivateKey));
  }

  async createGroup(name: string): Promise<{
    groupId: Uint8Array;
    topic: Buffer;
  }> {
    const timestamp = Date.now();
    const nonce = crypto.getRandomValues(new Uint8Array(32));

    // groupId = sha256(edPublicKey || uint64BE(timestamp) || nonce32)
    const input = new Uint8Array(
      this.identity.edPublicKey.length + 8 + nonce.length,
    );
    input.set(this.identity.edPublicKey, 0);
    const tsView = new DataView(input.buffer, input.byteOffset + this.identity.edPublicKey.length, 8);
    tsView.setBigUint64(0, BigInt(timestamp), false);
    input.set(nonce, this.identity.edPublicKey.length + 8);

    const hashHex = await sha256(input);
    const groupId = hexToBytes(hashHex);

    // Derive topic via HKDF
    const topic = deriveKey(groupId, 'networkselfmd-topic-v1', '', 32);

    // Create and store genesis epoch
    const groupIdHex = Buffer.from(groupId).toString('hex');
    const genesisEpoch = createGenesisEpoch(groupIdHex, this.identity.edPublicKey);
    const signedGenesis = createSignedEpoch(genesisEpoch, this.identity.edPrivateKey);
    this.groupRepo.create(groupId, name, 'admin', this.identity.edPublicKey, signedGenesis.hash);
    this.groupRepo.addMember(groupId, this.identity.edPublicKey, 'admin');
    this.epochRepo.saveEpoch(signedGenesis);

    // Generate sender key
    const senderKeyState = SenderKeys.generate();
    this.senderKeyRepo.store(
      groupId,
      this.identity.edPublicKey,
      senderKeyState.chainKey,
      senderKeyState.chainIndex,
      crypto.getRandomValues(new Uint8Array(16)),
      -1,
      0,
      signedGenesis.hash,
    );

    // Join swarm topic
    await this.swarm.join(Buffer.from(topic));

    // Distribute sender keys to already-connected peers
    await this.distributeSenderKeys(groupId);

    this.emit('group:created', { groupId, name, topic });

    return { groupId, topic: Buffer.from(topic) };
  }

  async joinGroup(groupId: Uint8Array, name = 'Unknown Group', authority?: {
    creatorPublicKey: Uint8Array;
    genesisEpochData: Uint8Array;
    genesisSignature: Uint8Array;
    genesisHash: Uint8Array;
    inviteId?: string;
  }): Promise<void> {
    const pending = this.inviteRepo.findIncoming(groupId);
    const bootstrap = this.bootstrapRepo.find(groupId);
    const anchor = authority ?? (pending ? {
      creatorPublicKey: new Uint8Array(pending.inviter_public_key),
      genesisEpochData: new Uint8Array(pending.genesis_epoch_data),
      genesisSignature: new Uint8Array(pending.genesis_signature),
      genesisHash: new Uint8Array(pending.genesis_hash),
      inviteId: pending.invite_id,
    } : bootstrap ? {
      creatorPublicKey: new Uint8Array(bootstrap.inviter_public_key),
      genesisEpochData: new Uint8Array(bootstrap.genesis_epoch_data),
      genesisSignature: new Uint8Array(bootstrap.genesis_signature),
      genesisHash: new Uint8Array(bootstrap.genesis_hash),
    } : undefined);
    if (!anchor) throw new Error('No authenticated pending invite or public group authority');
    const groupIdHex = Buffer.from(groupId).toString('hex');
    const genesis: SignedGroupEpoch = {
      epoch: deserializeEpoch(anchor.genesisEpochData),
      signature: anchor.genesisSignature,
      hash: anchor.genesisHash,
    };
    if (!verifyGenesisEpoch(genesis, groupIdHex, anchor.creatorPublicKey)) throw new Error('Invalid group genesis trust anchor');

    this.groupRepo.join(groupId, pending?.group_name ?? bootstrap?.group_name ?? name, 'member', anchor.creatorPublicKey, anchor.genesisHash);
    this.epochRepo.saveEpoch(genesis);
    await this.swarm.join(Buffer.from(deriveKey(groupId, 'networkselfmd-topic-v1', '', 32)));

    // Leaving erases sender secrets but retains the authenticated epoch chain.
    // Historical epoch delivery does not recreate keys, so restore membership
    // and a fresh generation explicitly when joining an existing membership.
    const latest = this.epochRepo.getLatestEpoch(groupIdHex);
    if (latest && this.isMemberInEpoch(latest, this.identity.edPublicKey)) {
      this.syncMembershipToEpoch(groupId, latest);
      const localKey = this.senderKeyRepo.load(groupId, this.identity.edPublicKey);
      if (!localKey?.generation_id) await this.rotateKeys(groupId);
      // Existing connections do not trigger key exchange again after leaving.
      // Recover every member's erased receiving key through authenticated sync.
      for (const member of latest.epoch.members) {
        if (buffersEqual(member.publicKey, this.identity.edPublicKey)) continue;
        const peer = this.swarm.getSession(fingerprintFromPublicKey(member.publicKey));
        if (peer) this.requestEpochSync(groupId, peer, latest);
      }
    }

    const acceptInviteId = anchor.inviteId ?? `public:${this.identity.fingerprint}`;
    if (!pending) {
      this.inviteRepo.save({
        invite_id: acceptInviteId,
        group_name: name,
        groupId,
        inviterPublicKey: anchor.creatorPublicKey,
        inviteePublicKey: this.identity.edPublicKey,
        genesisEpochData: anchor.genesisEpochData,
        genesisSignature: anchor.genesisSignature,
        genesisHash: anchor.genesisHash,
        direction: 'incoming',
        created_at: Date.now(),
      });
    }
    const session = this.swarm.getSession(fingerprintFromPublicKey(anchor.creatorPublicKey));
    if (session) {
      session.send(
        signAuthenticatedMessage<GroupManagementMessage>(
          {
            type: MessageType.GroupManagement,
            action: 'accept',
            groupId,
            inviteId: acceptInviteId,
            targetFingerprint: this.identity.fingerprint,
            epochVersion: 0,
            epochHash: anchor.genesisHash,
            senderFingerprint: this.identity.fingerprint,
            recipientFingerprint: session.peerFingerprint!,
            timestamp: Date.now(),
          },
          this.identity.edPrivateKey,
        ),
      );
    }
    this.bootstrapRepo.delete(groupId);
    this.emit('group:joined', {
      groupId,
      name: pending?.group_name ?? bootstrap?.group_name ?? name,
    });
  }

  async leaveGroup(groupId: Uint8Array): Promise<void> {
    const topic = deriveKey(groupId, 'networkselfmd-topic-v1', '', 32);
    await this.swarm.leave(Buffer.from(topic));
    this.groupRepo.leave(groupId);
    this.senderKeyRepo.deleteForGroup(groupId);
    this.messageCounters.delete(Buffer.from(groupId).toString('hex'));
    this.emit('group:left', { groupId });
  }

  async inviteToGroup(
    groupId: Uint8Array,
    peerPublicKey: Uint8Array,
  ): Promise<void> {
    const group = this.groupRepo.find(groupId);
    if (!group) {
      throw new Error('Group not found');
    }

    const groupIdHex = Buffer.from(groupId).toString('hex');
    const latestEpoch = this.epochRepo.getLatestEpoch(groupIdHex);

    if (latestEpoch) {
      if (!this.isAdminInEpoch(latestEpoch, this.identity.edPublicKey)) {
        throw new Error('Not authorized: not admin in latest epoch');
      }
    } else if (group.role !== 'admin') {
      console.warn('[GroupManager] No epoch chain found for group, falling back to local role check');
      throw new Error('Not authorized to invite members');
    }

    const peerFingerprint = fingerprintFromPublicKey(peerPublicKey);
    const session = this.swarm.getSession(peerFingerprint);
    if (!session) {
      throw new Error('Peer not connected');
    }

    if (!latestEpoch) throw new Error('Missing group epoch chain');
    const genesis = this.epochRepo.getEpochByVersion(groupIdHex, 0);
    if (!genesis || !verifyGenesisEpoch(genesis, groupIdHex, this.identity.edPublicKey)) throw new Error('Invalid local genesis trust anchor');
    const inviteId = createId();
    const genesisEpochData = serializeEpoch(genesis.epoch);
    const message: ProtocolMessage =
      signAuthenticatedMessage<GroupManagementMessage>(
        {
          type: MessageType.GroupManagement,
          action: 'invite',
          groupId,
          targetFingerprint: peerFingerprint,
          groupName: group.name,
          inviteId,
          epochVersion: latestEpoch.epoch.version,
          epochHash: latestEpoch.hash,
          genesisEpochData,
          genesisSignature: genesis.signature,
          genesisHash: genesis.hash,
          senderFingerprint: this.identity.fingerprint,
          recipientFingerprint: peerFingerprint,
          timestamp: Date.now(),
        },
        this.identity.edPrivateKey,
      );

    this.inviteRepo.save({
      invite_id: inviteId,
      group_name: group.name,
      groupId,
      inviterPublicKey: this.identity.edPublicKey,
      inviteePublicKey: peerPublicKey,
      genesisEpochData,
      genesisSignature: genesis.signature,
      genesisHash: genesis.hash,
      direction: 'outgoing',
      created_at: Date.now(),
    });
    // A former member may have missed its removal and subsequent epochs while
    // offline. Authenticate that history before it validates this invitation.
    if (this.epochRepo.getEpochChain(groupIdHex).some((signed) => this.isMemberInEpoch(signed, peerPublicKey))) {
      this.sendEpochChain(groupId, session, 0);
    }
    session.send(message);

    this.emit('group:inviteSent', { groupId, peerPublicKey, inviteId });
  }

  async kickFromGroup(
    groupId: Uint8Array,
    memberPublicKey: Uint8Array,
  ): Promise<void> {
    const group = this.groupRepo.find(groupId);
    if (!group) {
      throw new Error('Group not found');
    }

    const groupIdHex = Buffer.from(groupId).toString('hex');
    const latestEpoch = this.epochRepo.getLatestEpoch(groupIdHex);

    if (
      !latestEpoch ||
      !this.isAdminInEpoch(latestEpoch, this.identity.edPublicKey)
    ) {
      throw new Error('Not authorized: missing epoch or not current admin');
    }

    // Send kick message to all members
    const members = this.groupRepo.getMembers(groupId);
    const memberFingerprint = fingerprintFromPublicKey(memberPublicKey);
    for (const member of members) {
      const fp = fingerprintFromPublicKey(new Uint8Array(member.public_key));
      const session = this.swarm.getSession(fp);
      if (session) {
        const kickMessage: ProtocolMessage =
          signAuthenticatedMessage<GroupManagementMessage>(
            {
              type: MessageType.GroupManagement,
              action: 'kick',
              groupId,
              targetFingerprint: memberFingerprint,
              epochVersion: latestEpoch.epoch.version,
              epochHash: latestEpoch.hash,
              senderFingerprint: this.identity.fingerprint,
              recipientFingerprint: fp,
              timestamp: Date.now(),
            },
            this.identity.edPrivateKey,
          );
        session.send(kickMessage);
      }
    }

    this.groupRepo.removeMember(groupId, memberPublicKey);
    this.senderKeyRepo.delete(groupId, memberPublicKey);

    // Create new epoch without the kicked member
    if (latestEpoch) {
      const newMembers = latestEpoch.epoch.members.filter(
        (m) => !buffersEqual(m.publicKey, memberPublicKey),
      );
      const newEpoch = {
        version: latestEpoch.epoch.version + 1,
        prevHash: latestEpoch.hash,
        groupId: groupIdHex,
        members: newMembers,
        createdAt: Date.now(),
        createdBy: this.identity.edPublicKey,
      };
      const signedEpoch = createSignedEpoch(newEpoch, this.identity.edPrivateKey);
      this.epochRepo.saveEpoch(signedEpoch);
      this.broadcastEpoch(groupId, signedEpoch);
    }

    // Rotate keys after kick
    await this.rotateKeys(groupId, true);
    this.emit('group:memberLeft', { groupId, memberPublicKey });
  }

  async distributeSenderKeys(groupId: Uint8Array): Promise<void> {
    const group = this.groupRepo.find(groupId);
    if (!group) return;

    const groupIdHex = Buffer.from(groupId).toString('hex');
    const latestEpoch = this.epochRepo.getLatestEpoch(groupIdHex);
    if (
      !latestEpoch ||
      !this.isMemberInEpoch(latestEpoch, this.identity.edPublicKey)
    ) {
      return;
    }

    const senderKey = this.senderKeyRepo.load(groupId, this.identity.edPublicKey);
    if (!senderKey || !senderKey.generation_id) return;

    const sequence = senderKey.distribution_sequence + 1;
    this.senderKeyRepo.store(groupId, this.identity.edPublicKey, new Uint8Array(senderKey.chain_key), senderKey.chain_index, new Uint8Array(senderKey.generation_id), sequence, latestEpoch.epoch.version, latestEpoch.hash);

    const payload = SenderKeys.createDistribution(
      groupId,
      {
        chainKey: new Uint8Array(senderKey.chain_key),
        chainIndex: senderKey.chain_index,
      },
      this.identity.edPublicKey,
      latestEpoch.epoch.version,
      latestEpoch.hash,
      new Uint8Array(senderKey.generation_id),
      sequence,
    );

    // The signed latest epoch is the sole recipient list. Each member gets a
    // separately encrypted envelope bound to its authenticated identity.
    for (const member of latestEpoch.epoch.members) {
      if (buffersEqual(member.publicKey, this.identity.edPublicKey)) continue;

      const session = this.swarm.getSession(
        fingerprintFromPublicKey(member.publicKey),
      );
      if (
        !session?.peerPublicKey ||
        !session.peerXPublicKey ||
        !buffersEqual(session.peerPublicKey, member.publicKey) ||
        !session.peerCapabilities.has(SENDER_KEY_CAPABILITY)
      ) {
        continue;
      }

      const message: ProtocolMessage = SenderKeys.encryptDistribution(
        payload,
        this.identity.xPrivateKey,
        this.identity.edPublicKey,
        session.peerXPublicKey,
        session.peerPublicKey,
      );
      try {
        session.send(message);
      } catch {
        // Ignore send errors (session may have closed)
      }
    }
  }

  /**
   * Send our current sender key only to the authenticated peer that just
   * connected. Discovery peers that are not in the signed epoch cause no key
   * sequence update, database write, or group-member network fan-out.
   */
  async distributeSenderKeyToPeer(
    groupId: Uint8Array,
    session: PeerSession,
  ): Promise<boolean> {
    if (!session.peerPublicKey || !session.peerXPublicKey) return false;
    if (
      !session.peerFingerprint ||
      this.swarm.getSession(session.peerFingerprint) !== session
    ) {
      return false;
    }
    if (!session.peerCapabilities.has(SENDER_KEY_CAPABILITY)) return false;

    const group = this.groupRepo.find(groupId);
    if (!group) return false;
    const latestEpoch = this.epochRepo.getLatestEpoch(
      Buffer.from(groupId).toString('hex'),
    );
    if (
      !latestEpoch ||
      !this.isMemberInEpoch(latestEpoch, this.identity.edPublicKey) ||
      !this.isMemberInEpoch(latestEpoch, session.peerPublicKey)
    ) {
      return false;
    }

    const senderKey = this.senderKeyRepo.load(
      groupId,
      this.identity.edPublicKey,
    );
    if (!senderKey?.generation_id) return false;

    const sequence = senderKey.distribution_sequence + 1;
    this.senderKeyRepo.store(
      groupId,
      this.identity.edPublicKey,
      new Uint8Array(senderKey.chain_key),
      senderKey.chain_index,
      new Uint8Array(senderKey.generation_id),
      sequence,
      latestEpoch.epoch.version,
      latestEpoch.hash,
    );
    const payload = SenderKeys.createDistribution(
      groupId,
      {
        chainKey: new Uint8Array(senderKey.chain_key),
        chainIndex: senderKey.chain_index,
      },
      this.identity.edPublicKey,
      latestEpoch.epoch.version,
      latestEpoch.hash,
      new Uint8Array(senderKey.generation_id),
      sequence,
    );
    const message: ProtocolMessage = SenderKeys.encryptDistribution(
      payload,
      this.identity.xPrivateKey,
      this.identity.edPublicKey,
      session.peerXPublicKey,
      session.peerPublicKey,
    );
    try {
      session.send(message);
      return true;
    } catch {
      return false;
    }
  }

  handleSenderKeyDistribution(
    session: PeerSession,
    message: SenderKeyDistributionMessage,
  ): void {
    try {
      if (!session.peerXPublicKey) {
        throw new Error('Rejected sender-key envelope: missing peer X25519 key');
      }
      const reservation = validateSenderKeyEnvelope(
        session,
        message,
        this.identity.edPublicKey,
      );
      const senderPublicKey = session.peerPublicKey!;
      const senderXPublicKey = session.peerXPublicKey;

      this.replayRepo.accept(reservation, () => {
        // Decryption is deliberately inside the replay transaction. A forged
        // ciphertext rolls the reservation back and cannot poison a later
        // authentic delivery of the same envelope.
        const payload = SenderKeys.decryptDistribution(
          message,
          this.identity.xPrivateKey,
          this.identity.edPublicKey,
          senderXPublicKey,
          senderPublicKey,
        );
        const group = this.groupRepo.find(payload.groupId);
        if (!group) {
          throw new Error('Rejected sender key for unknown group');
        }
        const latestEpoch = this.epochRepo.getLatestEpoch(
          Buffer.from(payload.groupId).toString('hex'),
        );
        if (!latestEpoch) {
          throw new Error('Rejected sender key without group epoch');
        }
        if (
          payload.epochVersion !== latestEpoch.epoch.version ||
          !buffersEqual(payload.epochHash, latestEpoch.hash)
        ) {
          throw new Error('Rejected sender key for stale group epoch');
        }
        if (
          !this.isMemberInEpoch(latestEpoch, this.identity.edPublicKey) ||
          !this.isMemberInEpoch(latestEpoch, senderPublicKey)
        ) {
          throw new Error('Rejected sender key from non-member in latest epoch');
        }
        if (
          !this.senderKeyRepo.storeIfNewer(
            payload.groupId,
            senderPublicKey,
            payload.chainKey,
            payload.chainIndex,
            payload.generationId,
            payload.sequence,
            payload.epochVersion,
            payload.epochHash,
          )
        ) {
          throw new Error('Rejected replayed sender-key distribution');
        }

        const sender = latestEpoch.epoch.members.find((member) =>
          buffersEqual(member.publicKey, senderPublicKey),
        );
        this.groupRepo.addMember(
          payload.groupId,
          senderPublicKey,
          sender?.role ?? 'member',
        );
      });
    } catch (error) {
      this.emit('error', error);
    }
  }

  async handleGroupMessage(
    session: PeerSession,
    message: GroupEncryptedMessage,
    delivery?: import('../network/delivery-manager.js').DeliveryContext,
  ): Promise<boolean> {
    try {
      const reservation = validateAuthenticatedMessage(
        session,
        message,
        this.identity.fingerprint,
      );
      const senderPublicKey = session.peerPublicKey!;
      const content = this.replayRepo.accept(reservation, () => {
        const group = this.groupRepo.find(message.groupId);
        const latest = this.epochRepo.getLatestEpoch(
          Buffer.from(message.groupId).toString('hex'),
        );
        if (!group || !latest) {
          throw new Error('Rejected group message: unknown or missing epoch');
        }
        if (
          message.epochVersion !== latest.epoch.version ||
          !buffersEqual(message.epochHash, latest.hash)
        ) {
          throw new Error('Rejected group message: stale group epoch');
        }
        if (
          !this.isMemberInEpoch(latest, this.identity.edPublicKey) ||
          !this.isMemberInEpoch(latest, senderPublicKey)
        ) {
          throw new Error('Rejected group message: sender is revoked');
        }

        const senderKey = this.senderKeyRepo.load(
          message.groupId,
          senderPublicKey,
        );
        if (
          !senderKey?.generation_id ||
          !senderKey.epoch_hash ||
          message.epochVersion !== senderKey.epoch_version ||
          !buffersEqual(message.epochHash, new Uint8Array(senderKey.epoch_hash)) ||
          !buffersEqual(
            message.generationId,
            new Uint8Array(senderKey.generation_id),
          )
        ) {
          throw new Error(
            'Rejected group message outside current sender-key generation/epoch',
          );
        }

        const { plaintext, nextRecord } = SenderKeys.decrypt(
          {
            chainKey: new Uint8Array(senderKey.chain_key),
            chainIndex: senderKey.chain_index,
            skippedKeys: new Map<number, Uint8Array>(),
          },
          message.chainIndex,
          message.nonce,
          message.ciphertext,
          groupMessageAad(
            message.groupId,
            senderPublicKey,
            message.generationId,
            message.epochVersion,
            message.epochHash,
            message.chainIndex,
          ),
        );
        this.senderKeyRepo.store(
          message.groupId,
          senderPublicKey,
          nextRecord.chainKey,
          nextRecord.chainIndex,
          new Uint8Array(senderKey.generation_id),
          senderKey.distribution_sequence,
          senderKey.epoch_version,
          new Uint8Array(senderKey.epoch_hash),
        );

        const decoded = new TextDecoder().decode(plaintext);
        delivery?.accept(decoded);
        this.messageRepo.insert({
          id: delivery?.messageId ?? createId(),
          groupId: message.groupId,
          senderPublicKey,
          content: decoded,
          timestamp: delivery?.timestamp ?? message.timestamp,
          type: 'group',
        });
        return decoded;
      });

      this.emit('group:message', {
        groupId: message.groupId,
        senderPublicKey,
        senderFingerprint: session.peerFingerprint,
        content,
        timestamp: delivery?.timestamp ?? message.timestamp,
      });
      return true;
    } catch (error) {
      this.emit('error', error);
      return false;
    }
  }

  async sendGroupMessage(
    groupId: Uint8Array,
    content: string,
  ): Promise<string> {
    await this.rotateExpiredKey(groupId);
    if (this.enqueueDelivery) return this.enqueueDelivery(groupId, content);
    const latest = this.epochRepo.getLatestEpoch(
      Buffer.from(groupId).toString('hex'),
    );
    if (!latest || !this.isMemberInEpoch(latest, this.identity.edPublicKey)) {
      throw new Error('Cannot send group message without a current member epoch');
    }
    const senderKey = this.senderKeyRepo.load(groupId, this.identity.edPublicKey);
    if (
      !senderKey ||
      !senderKey.generation_id ||
      !senderKey.epoch_hash ||
      senderKey.epoch_version !== latest.epoch.version ||
      !buffersEqual(new Uint8Array(senderKey.epoch_hash), latest.hash)
    ) {
      throw new Error('No sender key for this group');
    }

    const plaintext = new TextEncoder().encode(content);
    if (plaintext.length === 0 || plaintext.length > 64 * 1024) throw new Error('Group message must be 1..65536 bytes');

    const state = {
      chainKey: new Uint8Array(senderKey.chain_key),
      chainIndex: senderKey.chain_index,
    };

    const aad = groupMessageAad(groupId, this.identity.edPublicKey, new Uint8Array(senderKey.generation_id), senderKey.epoch_version, new Uint8Array(senderKey.epoch_hash), senderKey.chain_index);
    const { ciphertext, nonce, chainIndex: encChainIndex, nextState } = SenderKeys.encrypt(state, plaintext, aad);

    // Update stored key state
    this.senderKeyRepo.store(
      groupId,
      this.identity.edPublicKey,
      nextState.chainKey,
      nextState.chainIndex,
      new Uint8Array(senderKey.generation_id),
      senderKey.distribution_sequence,
      senderKey.epoch_version,
      new Uint8Array(senderKey.epoch_hash),
    );

    const messageId = createId();

    const message: ProtocolMessage =
      signAuthenticatedMessage<GroupEncryptedMessage>(
        {
          type: MessageType.GroupMessage,
          groupId,
          senderFingerprint: this.identity.fingerprint,
          chainIndex: encChainIndex,
          generationId: new Uint8Array(senderKey.generation_id),
          epochVersion: senderKey.epoch_version,
          epochHash: new Uint8Array(senderKey.epoch_hash),
          ciphertext,
          nonce,
          timestamp: Date.now(),
        },
        this.identity.edPrivateKey,
      );

    // Send to all connected members
    for (const member of latest.epoch.members) {
      const memberKey = member.publicKey;
      if (buffersEqual(memberKey, this.identity.edPublicKey)) continue;
      const fp = fingerprintFromPublicKey(memberKey);
      const session = this.swarm.getSession(fp);
      if (session) {
        session.send(message);
      }
    }

    // Store own message
    this.messageRepo.insert({
      id: messageId,
      groupId,
      senderPublicKey: this.identity.edPublicKey,
      content,
      timestamp: Date.now(),
      type: 'group',
    });

    // Check key rotation
    const groupHex = Buffer.from(groupId).toString('hex');
    const count = (this.messageCounters.get(groupHex) ?? 0) + 1;
    this.messageCounters.set(groupHex, count);

    if (count >= KEY_ROTATION_INTERVAL) {
      await this.rotateKeys(groupId);
      this.messageCounters.set(groupHex, 0);
    }
    return messageId;
  }

  /** Called after fresh key distribution, inside the outbox transaction. */
  encryptDelivery(groupId: Uint8Array, content: string): GroupEncryptedMessage {
    const latest = this.epochRepo.getLatestEpoch(Buffer.from(groupId).toString('hex'));
    if (!latest || !this.isMemberInEpoch(latest, this.identity.edPublicKey)) throw new Error('Sender is revoked');
    const key = this.senderKeyRepo.load(groupId, this.identity.edPublicKey);
    if (!key?.generation_id || !key.epoch_hash || key.epoch_version !== latest.epoch.version || !buffersEqual(key.epoch_hash, latest.hash)) throw new Error('No current sender key');
    const plaintext = new TextEncoder().encode(content);
    if (!plaintext.length || plaintext.length > 65536) throw new Error('Group message must be 1..65536 bytes');
    const aad = groupMessageAad(groupId, this.identity.edPublicKey, key.generation_id, key.epoch_version, key.epoch_hash, key.chain_index);
    const encrypted = SenderKeys.encrypt({ chainKey: new Uint8Array(key.chain_key), chainIndex: key.chain_index }, plaintext, aad);
    this.senderKeyRepo.store(groupId, this.identity.edPublicKey, encrypted.nextState.chainKey, encrypted.nextState.chainIndex,
      key.generation_id, key.distribution_sequence, key.epoch_version, key.epoch_hash);
    return signAuthenticatedMessage<GroupEncryptedMessage>({
      type: MessageType.GroupMessage, groupId, senderFingerprint: this.identity.fingerprint,
      chainIndex: encrypted.chainIndex, generationId: new Uint8Array(key.generation_id),
      epochVersion: key.epoch_version, epochHash: new Uint8Array(key.epoch_hash),
      ciphertext: encrypted.ciphertext, nonce: encrypted.nonce, timestamp: Date.now(),
    }, this.identity.edPrivateKey);
  }

  async rotateKeys(groupId: Uint8Array, invalidateRemote = false): Promise<void> {
    const newState = SenderKeys.generate();
    const previous = this.senderKeyRepo.load(groupId, this.identity.edPublicKey);
    const latest = this.epochRepo.getLatestEpoch(Buffer.from(groupId).toString('hex'));
    if (!latest || !this.isMemberInEpoch(latest, this.identity.edPublicKey)) return;
    if (invalidateRemote) this.senderKeyRepo.deleteForGroup(groupId);
    this.senderKeyRepo.store(
      groupId,
      this.identity.edPublicKey,
      newState.chainKey,
      newState.chainIndex,
      crypto.getRandomValues(new Uint8Array(16)),
      previous?.distribution_sequence ?? -1,
      latest.epoch.version,
      latest.hash,
    );

    await this.distributeSenderKeys(groupId);
    this.emit('group:keysRotated', { groupId });
  }

  async handleGroupManagement(
    session: PeerSession,
    message: GroupManagementMessage,
  ): Promise<void> {
    type Outcome =
      | { kind: 'invited' }
      | { kind: 'accept'; epoch?: SignedGroupEpoch }
      | { kind: 'sync'; fromVersion: number }
      | { kind: 'metadata' }
      | { kind: 'leave' }
      | { kind: 'kicked' };

    try {
      const reservation = validateAuthenticatedMessage(
        session,
        message,
        this.identity.fingerprint,
      );
      const senderPublicKey = session.peerPublicKey!;
      const senderFingerprint = session.peerFingerprint!;
      const groupIdHex = Buffer.from(message.groupId).toString('hex');

      const outcome = this.replayRepo.accept<Outcome>(reservation, () => {
        const group = this.groupRepo.find(message.groupId);
        const latestEpoch = this.epochRepo.getLatestEpoch(groupIdHex);

        switch (message.action) {
          case 'invite': {
            if (
              message.targetFingerprint !== this.identity.fingerprint ||
              !message.inviteId ||
              !message.groupName ||
              message.epochVersion === undefined ||
              !message.epochHash ||
              !message.genesisEpochData ||
              !message.genesisSignature ||
              !message.genesisHash
            ) {
              throw new Error('Rejected group invite: incomplete bootstrap');
            }
            const genesis: SignedGroupEpoch = {
              epoch: deserializeEpoch(message.genesisEpochData),
              signature: message.genesisSignature,
              hash: message.genesisHash,
            };
            const expectedCreator = group?.creator_public_key
              ? new Uint8Array(group.creator_public_key)
              : senderPublicKey;
            if (
              !expectedCreator ||
              !verifyGenesisEpoch(genesis, groupIdHex, expectedCreator) ||
              (latestEpoch &&
                (!this.isAdminInEpoch(latestEpoch, senderPublicKey) ||
                  message.epochVersion !== latestEpoch.epoch.version ||
                  !message.epochHash ||
                  !buffersEqual(message.epochHash, latestEpoch.hash))) ||
              (group &&
                !latestEpoch &&
                !buffersEqual(senderPublicKey, expectedCreator))
            ) {
              throw new Error(
                'Rejected group invite: unauthenticated genesis provenance',
              );
            }
            this.inviteRepo.save({
              invite_id: message.inviteId,
              group_name: message.groupName,
              groupId: message.groupId,
              inviterPublicKey: senderPublicKey,
              inviteePublicKey: this.identity.edPublicKey,
              genesisEpochData: message.genesisEpochData,
              genesisSignature: message.genesisSignature,
              genesisHash: message.genesisHash,
              direction: 'incoming',
              created_at: message.timestamp,
            });
            this.bootstrapRepo.save({
              groupId: message.groupId,
              groupName: message.groupName,
              inviterPublicKey: senderPublicKey,
              genesisEpochData: message.genesisEpochData,
              genesisSignature: message.genesisSignature,
              genesisHash: message.genesisHash,
              receivedAt: message.timestamp,
            });
            return { kind: 'invited' };
          }

          case 'metadata': {
            if (!group?.creator_public_key || !latestEpoch ||
              !buffersEqual(new Uint8Array(group.creator_public_key), senderPublicKey) ||
              !this.isAdminInEpoch(latestEpoch, senderPublicKey) ||
              !this.isMemberInEpoch(latestEpoch, this.identity.edPublicKey) ||
              message.epochVersion !== latestEpoch.epoch.version ||
              !message.epochHash || !buffersEqual(message.epochHash, latestEpoch.hash) ||
              typeof message.selfMd !== 'string' || Buffer.byteLength(message.selfMd, 'utf8') > 16 * 1024 ||
              typeof message.isPublic !== 'boolean' ||
              !Number.isSafeInteger(message.metadataVersion) || message.metadataVersion! < 0) {
              throw new Error('Rejected group metadata: unauthorized or invalid context');
            }
            this.groupRepo.applyMetadata(message.groupId, message.selfMd, message.isPublic, message.metadataVersion!);
            return { kind: 'metadata' };
          }

          case 'accept': {
            if (
              message.targetFingerprint !== senderFingerprint ||
              !message.inviteId ||
              !group ||
              !latestEpoch ||
              !this.isAdminInEpoch(latestEpoch, this.identity.edPublicKey) ||
              message.epochVersion === undefined ||
              !message.epochHash
            ) {
              throw new Error('Rejected group accept: invalid group context');
            }
            const acceptedEpoch = this.epochRepo.getEpochByVersion(
              groupIdHex,
              message.epochVersion,
            );
            if (
              !acceptedEpoch ||
              !buffersEqual(acceptedEpoch.hash, message.epochHash)
            ) {
              throw new Error('Rejected group accept: epoch context mismatch');
            }
            const pending = this.inviteRepo.findById(message.inviteId);
            if (pending) {
              if (
                pending.direction !== 'outgoing' ||
                !buffersEqual(new Uint8Array(pending.group_id), message.groupId) ||
                !buffersEqual(
                  new Uint8Array(pending.inviter_public_key),
                  this.identity.edPublicKey,
                ) ||
                !buffersEqual(
                  new Uint8Array(pending.invitee_public_key),
                  senderPublicKey,
                )
              ) {
                throw new Error('Rejected group accept: invite mismatch');
              }
            } else if (!group.is_public) {
              throw new Error('Rejected group accept: no pending invite');
            }
            if (this.isMemberInEpoch(latestEpoch, senderPublicKey)) {
              if (pending) this.inviteRepo.delete(pending.invite_id);
              return { kind: 'accept' };
            }
            const signedEpoch = createSignedEpoch(
              {
                version: latestEpoch.epoch.version + 1,
                prevHash: latestEpoch.hash,
                groupId: groupIdHex,
                members: [
                  ...latestEpoch.epoch.members,
                  { publicKey: senderPublicKey, role: 'member' },
                ],
                createdAt: Date.now(),
                createdBy: this.identity.edPublicKey,
              },
              this.identity.edPrivateKey,
            );
            this.epochRepo.saveEpoch(signedEpoch);
            this.syncMembershipToEpoch(message.groupId, signedEpoch);
            if (pending) this.inviteRepo.delete(pending.invite_id);
            return { kind: 'accept', epoch: signedEpoch };
          }

          case 'sync-request':
            if (
              !latestEpoch ||
              !this.isMemberInEpoch(latestEpoch, senderPublicKey) ||
              message.epochVersion === undefined ||
              !message.epochHash
            ) {
              throw new Error('Rejected epoch sync from non-member');
            }
            const requestedEpoch = this.epochRepo.getEpochByVersion(
              groupIdHex,
              message.epochVersion,
            );
            if (
              !requestedEpoch ||
              !buffersEqual(requestedEpoch.hash, message.epochHash)
            ) {
              throw new Error('Rejected epoch sync: unknown epoch context');
            }
            return {
              kind: 'sync',
              fromVersion: message.epochVersion + 1,
            };

          case 'kick': {
            if (
              !group ||
              !latestEpoch ||
              !this.isAdminInEpoch(latestEpoch, senderPublicKey) ||
              !message.targetFingerprint ||
              message.epochVersion !== latestEpoch.epoch.version ||
              !message.epochHash ||
              !buffersEqual(message.epochHash, latestEpoch.hash)
            ) {
              throw new Error('Rejected group kick: unauthorized context');
            }
            const target = this.groupRepo
              .getMembers(message.groupId)
              .find(
                (member) =>
                  fingerprintFromPublicKey(
                    new Uint8Array(member.public_key),
                  ) === message.targetFingerprint,
              );
            if (!target) {
              throw new Error('Rejected group kick: target is not a member');
            }
            if (message.targetFingerprint === this.identity.fingerprint) {
              this.groupRepo.leave(message.groupId);
              this.senderKeyRepo.deleteForGroup(message.groupId);
              this.messageCounters.delete(groupIdHex);
              return { kind: 'leave' };
            }
            const targetKey = new Uint8Array(target.public_key);
            this.groupRepo.removeMember(message.groupId, targetKey);
            this.senderKeyRepo.delete(message.groupId, targetKey);
            return { kind: 'kicked' };
          }

          default:
            throw new Error(
              `Rejected unsupported GroupManagement action: ${String(message.action)}`,
            );
        }
      });

      if (outcome.kind === 'invited') {
        this.emit('group:invited', {
          groupId: message.groupId,
          invitedBy: senderPublicKey,
          groupName: message.groupName,
          inviteId: message.inviteId,
        });
      } else if (outcome.kind === 'accept') {
        if (outcome.epoch) this.broadcastEpoch(message.groupId, outcome.epoch);
        this.sendEpochChain(message.groupId, session, 0);
        await this.distributeSenderKeyToPeer(message.groupId, session);
        this.sendMetadata(message.groupId, session);
      } else if (outcome.kind === 'sync') {
        this.sendEpochChain(message.groupId, session, outcome.fromVersion);
        await this.distributeSenderKeyToPeer(message.groupId, session);
        this.sendMetadata(message.groupId, session);
      } else if (outcome.kind === 'metadata') {
        this.emit('group:metadataUpdated', { groupId: message.groupId });
      } else if (outcome.kind === 'leave') {
        const topic = deriveKey(message.groupId, 'networkselfmd-topic-v1', '', 32);
        await this.swarm.leave(Buffer.from(topic));
        this.emit('group:left', { groupId: message.groupId });
      } else {
        this.emit('group:memberLeft', {
          groupId: message.groupId,
          targetFingerprint: message.targetFingerprint,
        });
      }
    } catch (error) {
      this.emit('error', error);
    }
  }

  handleGroupEpoch(
    session: PeerSession,
    message: GroupEpochMessage,
  ): void {
    type EpochOutcome =
      | { kind: 'historical' }
      | {
          kind: 'updated';
          localIsMember: boolean;
          localRemoved: boolean;
        };

    let shouldRequestSync = false;
    try {
      const senderFingerprint = validateReadySession(session);
      validateFreshTimestamp(message.timestamp);
      if (
        message.senderFingerprint !== senderFingerprint ||
        message.recipientFingerprint !== this.identity.fingerprint ||
        !verifyGroupEpochEnvelope(message, session.peerPublicKey!)
      ) {
        throw new Error('Rejected epoch: invalid delivery envelope');
      }

      const epochData = new Uint8Array(message.epochData);
      const epoch = deserializeEpoch(epochData);
      const computedHash = hashEpoch(epochData);
      const groupIdHex = Buffer.from(message.groupId).toString('hex');
      if (
        epoch.groupId !== groupIdHex ||
        !buffersEqual(message.hash, computedHash)
      ) {
        throw new Error('Rejected epoch: signed context mismatch');
      }
      const signed: SignedGroupEpoch = {
        epoch,
        signature: message.signature,
        hash: computedHash,
      };
      const reservation = {
        messageId: groupEpochEnvelopeId(message),
        senderFingerprint,
        messageType: message.type,
        receivedAt: Date.now(),
      };

      const outcome = this.replayRepo.accept<EpochOutcome>(reservation, () => {
        const group = this.groupRepo.find(message.groupId);
        const authority = group?.creator_public_key && group.genesis_hash
          ? group : this.groupRepo.findRetainedAuthority(message.groupId);
        if (!authority?.creator_public_key || !authority.genesis_hash) {
          throw new Error('Rejected epoch: group has no pinned provenance');
        }
        const creator = new Uint8Array(authority.creator_public_key);
        const pinnedGenesisHash = new Uint8Array(authority.genesis_hash);
        const latest = this.epochRepo.getLatestEpoch(groupIdHex);

        if (!latest) {
          if (
            !verifyGenesisEpoch(signed, groupIdHex, creator) ||
            !buffersEqual(signed.hash, pinnedGenesisHash) ||
            !buffersEqual(session.peerPublicKey!, creator)
          ) {
            throw new Error('Rejected epoch: invalid pinned genesis v0');
          }
        } else if (epoch.version <= latest.epoch.version) {
          if (!this.isMemberInEpoch(latest, session.peerPublicKey!)) {
            throw new Error('Rejected epoch: envelope sender is revoked');
          }
          const existing = this.epochRepo.getEpochByVersion(
            groupIdHex,
            epoch.version,
          );
          if (
            !existing ||
            !buffersEqual(existing.hash, signed.hash) ||
            !buffersEqual(existing.signature, signed.signature)
          ) {
            throw new Error('Rejected epoch: historical fork');
          }
          if (this.isMemberInEpoch(latest, this.identity.edPublicKey)) {
            this.inviteRepo.deleteIncoming(message.groupId);
          }
          return { kind: 'historical' };
        } else {
          if (epoch.version !== latest.epoch.version + 1) {
            shouldRequestSync = true;
            throw new Error('Rejected epoch: version gap');
          }
          if (
            !this.isMemberInEpoch(latest, session.peerPublicKey!) ||
            !this.isAdminInEpoch(latest, epoch.createdBy) ||
            epoch.createdAt < latest.epoch.createdAt ||
            !verifyEpoch(signed, latest.hash)
          ) {
            throw new Error(
              'Rejected epoch: stale, revoked, or unauthorized transition',
            );
          }
        }

        const localWasMember = latest
          ? this.isMemberInEpoch(latest, this.identity.edPublicKey)
          : false;
        const localIsMember = this.isMemberInEpoch(
          signed,
          this.identity.edPublicKey,
        );
        const removedMember =
          latest?.epoch.members.some(
            (oldMember) =>
              !signed.epoch.members.some((member) =>
                buffersEqual(member.publicKey, oldMember.publicKey),
              ),
          ) ?? false;

        this.epochRepo.saveEpoch(signed);
        // Advance authenticated history for an inactive group only. Explicit
        // join is still required to restore membership and generate secrets.
        if (!group) return { kind: 'historical' };
        this.syncMembershipToEpoch(message.groupId, signed);

        if (localWasMember && !localIsMember) {
          this.groupRepo.leave(message.groupId);
          this.senderKeyRepo.deleteForGroup(message.groupId);
          this.messageCounters.delete(groupIdHex);
          return {
            kind: 'updated',
            localIsMember: false,
            localRemoved: true,
          };
        }

        if (localIsMember) {
          this.inviteRepo.deleteIncoming(message.groupId);
          const previous = this.senderKeyRepo.load(
            message.groupId,
            this.identity.edPublicKey,
          );
          if (removedMember || !previous || !previous.generation_id) {
            if (removedMember) this.senderKeyRepo.deleteForGroup(message.groupId);
            const state = SenderKeys.generate();
            this.senderKeyRepo.store(
              message.groupId,
              this.identity.edPublicKey,
              state.chainKey,
              state.chainIndex,
              crypto.getRandomValues(new Uint8Array(16)),
              previous?.distribution_sequence ?? -1,
              signed.epoch.version,
              signed.hash,
            );
          } else {
            this.senderKeyRepo.store(
              message.groupId,
              this.identity.edPublicKey,
              new Uint8Array(previous.chain_key),
              previous.chain_index,
              new Uint8Array(previous.generation_id),
              previous.distribution_sequence,
              signed.epoch.version,
              signed.hash,
            );
          }
        }

        return {
          kind: 'updated',
          localIsMember,
          localRemoved: false,
        };
      });

      if (outcome.kind === 'historical') return;
      if (outcome.localRemoved) {
        const topic = deriveKey(
          message.groupId,
          'networkselfmd-topic-v1',
          '',
          32,
        );
        this.swarm
          .leave(Buffer.from(topic))
          .catch((error) => this.emit('error', error));
        this.emit('group:left', { groupId: message.groupId });
        return;
      }
      if (outcome.localIsMember) {
        this.distributeSenderKeys(message.groupId).catch((error) =>
          this.emit('error', error),
        );
      }
      this.emit('group:epochUpdated', {
        groupId: message.groupId,
        version: epoch.version,
      });
    } catch (error) {
      if (shouldRequestSync) {
        const latest = this.epochRepo.getLatestEpoch(
          Buffer.from(message.groupId).toString('hex'),
        );
        if (latest) this.requestEpochSync(message.groupId, session, latest);
      }
      this.emit('error', error);
    }
  }

  private isMemberInEpoch(
    signed: SignedGroupEpoch,
    publicKey: Uint8Array,
  ): boolean {
    return signed.epoch.members.some((member) =>
      buffersEqual(member.publicKey, publicKey),
    );
  }

  private isAdminInEpoch(signed: SignedGroupEpoch, publicKey: Uint8Array): boolean {
    return signed.epoch.members.some(
      (m) => m.role === 'admin' && buffersEqual(m.publicKey, publicKey),
    );
  }

  private broadcastEpoch(
    groupId: Uint8Array,
    signed: SignedGroupEpoch,
    excludedPublicKey?: Uint8Array,
  ): void {
    const serialized = serializeEpoch(signed.epoch);
    const members = this.groupRepo.getMembers(groupId);
    for (const member of members) {
      const memberKey = new Uint8Array(member.public_key);
      if (
        buffersEqual(memberKey, this.identity.edPublicKey) ||
        (excludedPublicKey && buffersEqual(memberKey, excludedPublicKey))
      ) {
        continue;
      }
      const fp = fingerprintFromPublicKey(memberKey);
      const session = this.swarm.getSession(fp);
      if (session) {
        try {
          const epochMessage: ProtocolMessage = signGroupEpochEnvelope(
            {
              type: MessageType.GroupEpoch,
              protocolVersion: 2,
              groupId,
              epochData: serialized,
              signature: signed.signature,
              hash: signed.hash,
              senderFingerprint: this.identity.fingerprint,
              recipientFingerprint: fp,
              timestamp: Date.now(),
            },
            this.identity.edPrivateKey,
          );
          session.send(epochMessage);
        } catch {
          // Ignore send errors
        }
      }
    }
  }

  private sendEpochChain(groupId: Uint8Array, session: PeerSession, fromVersion = 0): void {
    const recipientFingerprint = validateReadySession(session);
    const groupIdHex = Buffer.from(groupId).toString('hex');
    for (const signed of this.epochRepo.getEpochChain(groupIdHex)) {
      if (signed.epoch.version < fromVersion) continue;
      const message: ProtocolMessage = signGroupEpochEnvelope(
        {
          type: MessageType.GroupEpoch,
          protocolVersion: 2,
          groupId,
          epochData: serializeEpoch(signed.epoch),
          signature: signed.signature,
          hash: signed.hash,
          senderFingerprint: this.identity.fingerprint,
          recipientFingerprint,
          timestamp: Date.now(),
        },
        this.identity.edPrivateKey,
      );
      session.send(message);
    }
  }

  syncWithPeer(session: PeerSession): void {
    if (!session.peerPublicKey || !session.peerCapabilities.has('group-epoch-v1')) return;
    for (const group of this.groupRepo.list()) {
      const groupId = new Uint8Array(group.group_id);
      const latest = this.epochRepo.getLatestEpoch(Buffer.from(groupId).toString('hex'));
      if (!latest || !this.isMemberInEpoch(latest, session.peerPublicKey)) continue;
      const pending = this.inviteRepo.findIncoming(groupId);
      if (pending && buffersEqual(new Uint8Array(pending.inviter_public_key), session.peerPublicKey)) {
        session.send(
          signAuthenticatedMessage<GroupManagementMessage>(
            {
              type: MessageType.GroupManagement,
              action: 'accept',
              groupId,
              inviteId: pending.invite_id,
              targetFingerprint: this.identity.fingerprint,
              epochVersion: latest.epoch.version,
              epochHash: latest.hash,
              senderFingerprint: this.identity.fingerprint,
              recipientFingerprint: session.peerFingerprint!,
              timestamp: Date.now(),
            },
            this.identity.edPrivateKey,
          ),
        );
      }
      this.requestEpochSync(groupId, session, latest);
      if (this.isAdminInEpoch(latest, this.identity.edPublicKey)) this.sendEpochChain(groupId, session, 0);
    }
  }

  private requestEpochSync(groupId: Uint8Array, session: PeerSession, latest: SignedGroupEpoch): void {
    try {
      session.send(
        signAuthenticatedMessage<GroupManagementMessage>(
          {
            type: MessageType.GroupManagement,
            action: 'sync-request',
            groupId,
            epochVersion: latest.epoch.version,
            epochHash: latest.hash,
            senderFingerprint: this.identity.fingerprint,
            recipientFingerprint: validateReadySession(session),
            timestamp: Date.now(),
          },
          this.identity.edPrivateKey,
        ),
      );
    } catch {
      // Closed session; reconnect will retry.
    }
  }

  private syncMembershipToEpoch(
    groupId: Uint8Array,
    signed: SignedGroupEpoch,
  ): void {
    const currentMembers = this.groupRepo.getMembers(groupId);
    for (const current of currentMembers) {
      const publicKey = new Uint8Array(current.public_key);
      // An invitee receives the chain from genesis forward. Preserve its
      // locally generated key while replaying precursor epochs that do not
      // include it yet; the final epoch gates whether it may distribute it.
      if (buffersEqual(publicKey, this.identity.edPublicKey)) continue;
      if (!this.isMemberInEpoch(signed, publicKey)) {
        this.groupRepo.removeMember(groupId, publicKey);
        this.senderKeyRepo.delete(groupId, publicKey);
      }
    }
    for (const member of signed.epoch.members) {
      this.groupRepo.addMember(groupId, member.publicKey, member.role);
    }
  }

  async rejoinAllGroups(): Promise<void> {
    const groups = this.groupRepo.list();
    for (const group of groups) {
      const groupId = new Uint8Array(group.group_id);
      const groupIdHex = Buffer.from(groupId).toString('hex');
      const genesis = this.epochRepo.getEpochByVersion(groupIdHex, 0);
      const latest = this.epochRepo.getLatestEpoch(groupIdHex);
      const hasCreator = group.creator_public_key !== null;
      const hasGenesisHash = group.genesis_hash !== null;
      let trustedGenesis = false;

      if (genesis && hasCreator && hasGenesisHash) {
        const creator = new Uint8Array(group.creator_public_key!);
        trustedGenesis =
          verifyGenesisEpoch(genesis, groupIdHex, creator) &&
          buffersEqual(genesis.hash, new Uint8Array(group.genesis_hash!));
      } else if (
        genesis &&
        !hasCreator &&
        !hasGenesisHash &&
        group.role === 'admin' &&
        buffersEqual(genesis.epoch.createdBy, this.identity.edPublicKey) &&
        verifyGenesisEpoch(genesis, groupIdHex, this.identity.edPublicKey)
      ) {
        // A legacy admin group may recover only from a genesis signed by this
        // local identity. Member groups require a fresh authenticated invite
        // or verified public announcement before any network participation.
        this.groupRepo.pinAuthority(
          groupId,
          this.identity.edPublicKey,
          genesis.hash,
        );
        trustedGenesis = true;
      }

      if (!trustedGenesis) continue;

      const localKey = this.senderKeyRepo.load(
        groupId,
        this.identity.edPublicKey,
      );
      if (
        latest &&
        this.isMemberInEpoch(latest, this.identity.edPublicKey) &&
        (!localKey || !localKey.generation_id)
      ) {
        const state = SenderKeys.generate();
        this.senderKeyRepo.store(
          groupId,
          this.identity.edPublicKey,
          state.chainKey,
          0,
          crypto.getRandomValues(new Uint8Array(16)),
          localKey?.distribution_sequence ?? -1,
          latest.epoch.version,
          latest.hash,
        );
      }
      const topic = deriveKey(groupId, 'networkselfmd-topic-v1', '', 32);
      await this.swarm.join(Buffer.from(topic));
    }
  }
}

function hexToBytes(hex: string): Uint8Array {
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

function groupMessageAad(groupId: Uint8Array, sender: Uint8Array, generationId: Uint8Array, epochVersion: number, epochHash: Uint8Array, chainIndex: number): Uint8Array {
  const domain = new TextEncoder().encode('network.self.md/GroupMessage/v2\0');
  const numbers = new Uint8Array(16);
  const view = new DataView(numbers.buffer);
  view.setBigUint64(0, BigInt(epochVersion), false);
  view.setBigUint64(8, BigInt(chainIndex), false);
  const result = new Uint8Array(domain.length + groupId.length + sender.length + generationId.length + epochHash.length + numbers.length);
  let offset = 0;
  for (const part of [domain, groupId, sender, generationId, epochHash, numbers]) { result.set(part, offset); offset += part.length; }
  return result;
}
