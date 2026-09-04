import { EventEmitter } from 'node:events';
import { createId } from '@paralleldrive/cuid2';
import {
  deriveKey,
  SenderKeys,
  fingerprintFromPublicKey,
  createGenesisEpoch,
  createSignedEpoch,
  verifyEpoch,
  serializeEpoch,
  deserializeEpoch,
  hashEpoch,
  signAuthenticatedMessage,
  verifyGenesisEpoch,
  signGroupEpochEnvelope,
  verifyGroupEpochEnvelope,
  groupEpochEnvelopeId,
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
  ProtocolReplayRepository,
  GroupBootstrapRepository,
} from '../storage/repositories.js';
import {
  validateAuthenticatedMessage,
  validateFreshTimestamp,
  validateReadySession,
  validateSenderKeyEnvelope,
} from '../network/protocol-security.js';

const KEY_ROTATION_INTERVAL = 100;

export interface GroupManagerOptions {
  identity: AgentIdentity;
  swarm: SwarmManager;
  groups: GroupRepository;
  messages: MessageRepository;
  senderKeys: SenderKeyRepository;
  peers: PeerRepository;
  epochs: GroupEpochRepository;
  replay: ProtocolReplayRepository;
  bootstraps: GroupBootstrapRepository;
}

export class GroupManager extends EventEmitter {
  private identity: AgentIdentity;
  private swarm: SwarmManager;
  private groupRepo: GroupRepository;
  private messageRepo: MessageRepository;
  private senderKeyRepo: SenderKeyRepository;
  private peerRepo: PeerRepository;
  private epochRepo: GroupEpochRepository;
  private replayRepo: ProtocolReplayRepository;
  private bootstrapRepo: GroupBootstrapRepository;
  private messageCounters = new Map<string, number>();

  constructor(options: GroupManagerOptions) {
    super();
    this.identity = options.identity;
    this.swarm = options.swarm;
    this.groupRepo = options.groups;
    this.messageRepo = options.messages;
    this.senderKeyRepo = options.senderKeys;
    this.peerRepo = options.peers;
    this.epochRepo = options.epochs;
    this.replayRepo = options.replay;
    this.bootstrapRepo = options.bootstraps;
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
    const tsView = new DataView(
      input.buffer,
      input.byteOffset + this.identity.edPublicKey.length,
      8,
    );
    tsView.setBigUint64(0, BigInt(timestamp), false);
    input.set(nonce, this.identity.edPublicKey.length + 8);

    const hashHex = await sha256(input);
    const groupId = hexToBytes(hashHex);

    // Derive topic via HKDF
    const topic = deriveKey(groupId, 'networkselfmd-topic-v1', '', 32);

    // Create and store genesis epoch
    const groupIdHex = Buffer.from(groupId).toString('hex');
    const genesisEpoch = createGenesisEpoch(
      groupIdHex,
      this.identity.edPublicKey,
    );
    const signedGenesis = createSignedEpoch(
      genesisEpoch,
      this.identity.edPrivateKey,
    );
    this.groupRepo.create(
      groupId,
      name,
      'admin',
      this.identity.edPublicKey,
      signedGenesis.hash,
    );
    this.groupRepo.addMember(groupId, this.identity.edPublicKey, 'admin');
    this.epochRepo.saveEpoch(signedGenesis);

    // Generate sender key
    const senderKeyState = SenderKeys.generate();
    this.senderKeyRepo.store(
      groupId,
      this.identity.edPublicKey,
      senderKeyState.chainKey,
      senderKeyState.chainIndex,
    );

    // Join swarm topic
    await this.swarm.join(Buffer.from(topic));

    // Distribute sender keys to already-connected peers
    await this.distributeSenderKeys(groupId);

    this.emit('group:created', { groupId, name, topic });

    return { groupId, topic: Buffer.from(topic) };
  }

  async joinGroup(
    groupId: Uint8Array,
    name: string = 'Unknown Group',
    authority?: {
      creatorPublicKey: Uint8Array;
      genesisEpochData: Uint8Array;
      genesisSignature: Uint8Array;
      genesisHash: Uint8Array;
    },
  ): Promise<void> {
    const stored = this.bootstrapRepo.find(groupId);
    const anchor =
      authority ??
      (stored
        ? {
            creatorPublicKey: new Uint8Array(stored.inviter_public_key),
            genesisEpochData: new Uint8Array(stored.genesis_epoch_data),
            genesisSignature: new Uint8Array(stored.genesis_signature),
            genesisHash: new Uint8Array(stored.genesis_hash),
          }
        : undefined);
    if (!anchor) {
      throw new Error('No authenticated bootstrap provenance for group');
    }
    const groupIdHex = Buffer.from(groupId).toString('hex');
    const genesis: SignedGroupEpoch = {
      epoch: deserializeEpoch(anchor.genesisEpochData),
      signature: anchor.genesisSignature,
      hash: anchor.genesisHash,
    };
    if (!verifyGenesisEpoch(genesis, groupIdHex, anchor.creatorPublicKey)) {
      throw new Error('Invalid authenticated group genesis');
    }

    const topic = deriveKey(groupId, 'networkselfmd-topic-v1', '', 32);
    this.groupRepo.join(
      groupId,
      stored?.group_name ?? name,
      'member',
      anchor.creatorPublicKey,
      anchor.genesisHash,
    );
    this.epochRepo.saveEpoch(genesis);

    // Add self as member
    this.groupRepo.addMember(groupId, this.identity.edPublicKey, 'member');

    // Generate our sender key
    const senderKeyState = SenderKeys.generate();
    this.senderKeyRepo.store(
      groupId,
      this.identity.edPublicKey,
      senderKeyState.chainKey,
      senderKeyState.chainIndex,
    );

    await this.swarm.join(Buffer.from(topic));

    this.bootstrapRepo.delete(groupId);

    this.emit('group:joined', { groupId, name });
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

    if (!latestEpoch) {
      throw new Error('Missing group epoch chain');
    }
    if (!this.isAdminInEpoch(latestEpoch, this.identity.edPublicKey)) {
      throw new Error('Not authorized: not admin in latest epoch');
    }

    const peerFingerprint = fingerprintFromPublicKey(peerPublicKey);
    const session = this.swarm.getSession(peerFingerprint);
    if (!session) {
      throw new Error('Peer not connected');
    }

    const genesis = this.epochRepo.getEpochByVersion(groupIdHex, 0);
    if (
      !genesis ||
      !group.creator_public_key ||
      !group.genesis_hash ||
      !verifyGenesisEpoch(
        genesis,
        groupIdHex,
        new Uint8Array(group.creator_public_key),
      ) ||
      !buffersEqual(genesis.hash, new Uint8Array(group.genesis_hash))
    ) {
      throw new Error('Invalid local genesis trust anchor');
    }
    const message = signAuthenticatedMessage<GroupManagementMessage>(
      {
        type: MessageType.GroupManagement,
        action: 'invite',
        groupId,
        targetFingerprint: peerFingerprint,
        groupName: group.name,
        genesisEpochData: serializeEpoch(genesis.epoch),
        genesisSignature: genesis.signature,
        genesisHash: genesis.hash,
        senderFingerprint: this.identity.fingerprint,
        recipientFingerprint: peerFingerprint,
        timestamp: Date.now(),
      },
      this.identity.edPrivateKey,
    );

    session.send(message);
    this.groupRepo.addMember(groupId, peerPublicKey, 'member');

    // Create new epoch with member added
    if (latestEpoch) {
      const newMembers: GroupMemberEntry[] = [
        ...latestEpoch.epoch.members,
        { publicKey: peerPublicKey, role: 'member' as const },
      ];
      const newEpoch = {
        version: latestEpoch.epoch.version + 1,
        prevHash: latestEpoch.hash,
        groupId: groupIdHex,
        members: newMembers,
        createdAt: Date.now(),
        createdBy: this.identity.edPublicKey,
      };
      const signedEpoch = createSignedEpoch(
        newEpoch,
        this.identity.edPrivateKey,
      );
      this.epochRepo.saveEpoch(signedEpoch);
      this.broadcastEpoch(groupId, signedEpoch);
    }

    this.emit('group:invited', { groupId, peerPublicKey });
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

    if (!latestEpoch) {
      throw new Error('Missing group epoch chain');
    }
    if (!this.isAdminInEpoch(latestEpoch, this.identity.edPublicKey)) {
      throw new Error('Not authorized: not admin in latest epoch');
    }

    // Send kick message to all members
    const members = this.groupRepo.getMembers(groupId);
    const memberFingerprint = fingerprintFromPublicKey(memberPublicKey);
    for (const member of members) {
      const fp = fingerprintFromPublicKey(new Uint8Array(member.public_key));
      const session = this.swarm.getSession(fp);
      if (session) {
        const kickMessage = signAuthenticatedMessage<GroupManagementMessage>(
          {
            type: MessageType.GroupManagement,
            action: 'kick',
            groupId,
            targetFingerprint: memberFingerprint,
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
      const signedEpoch = createSignedEpoch(
        newEpoch,
        this.identity.edPrivateKey,
      );
      this.epochRepo.saveEpoch(signedEpoch);
      this.broadcastEpoch(groupId, signedEpoch);
    }

    // Rotate keys after kick
    await this.rotateKeys(groupId);
    this.emit('group:memberLeft', { groupId, memberPublicKey });
  }

  async distributeSenderKeys(groupId: Uint8Array): Promise<void> {
    // Sender-key encryption belongs to security-02-sender-keys. This branch
    // intentionally emits nothing until that recipient-specific envelope is
    // integrated; the old plaintext broadcast leaked the group key to every
    // connected session.
    void groupId;
  }

  handleSenderKeyDistribution(
    session: PeerSession,
    message: SenderKeyDistributionMessage,
  ): void {
    try {
      validateSenderKeyEnvelope(session, message, this.identity.edPublicKey);
    } catch (error) {
      this.emit('error', error);
      return;
    }
    this.emit(
      'error',
      new Error('Encrypted sender-key envelope awaits security-02 integration'),
    );
  }

  async handleGroupMessage(
    session: PeerSession,
    message: GroupEncryptedMessage,
  ): Promise<void> {
    let reservation;
    try {
      reservation = validateAuthenticatedMessage(
        session,
        message,
        this.identity.fingerprint,
      );
    } catch (error) {
      this.emit('error', error);
      return;
    }
    try {
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
          !this.isMemberInEpoch(latest, session.peerPublicKey!) ||
          !this.isMemberInEpoch(latest, this.identity.edPublicKey)
        ) {
          throw new Error('Rejected group message: sender is revoked');
        }
        const senderKey = this.senderKeyRepo.load(
          message.groupId,
          session.peerPublicKey!,
        );
        if (!senderKey) throw new Error('No sender key for peer');

        const { plaintext, nextRecord } = SenderKeys.decrypt(
          {
            chainKey: new Uint8Array(senderKey.chain_key),
            chainIndex: senderKey.chain_index,
            skippedKeys: new Map<number, Uint8Array>(),
          },
          message.chainIndex,
          message.nonce,
          message.ciphertext,
        );
        const decoded = new TextDecoder().decode(plaintext);
        this.senderKeyRepo.store(
          message.groupId,
          session.peerPublicKey!,
          nextRecord.chainKey,
          nextRecord.chainIndex,
        );
        this.messageRepo.insert({
          id: createId(),
          groupId: message.groupId,
          senderPublicKey: session.peerPublicKey!,
          content: decoded,
          timestamp: message.timestamp,
          type: 'group',
        });
        return decoded;
      });
      this.emit('group:message', {
        groupId: message.groupId,
        senderPublicKey: session.peerPublicKey!,
        senderFingerprint: session.peerFingerprint,
        content,
        timestamp: message.timestamp,
      });
    } catch (err) {
      this.emit('error', err);
    }
  }

  async sendGroupMessage(groupId: Uint8Array, content: string): Promise<void> {
    const groupIdHex = Buffer.from(groupId).toString('hex');
    const latest = this.epochRepo.getLatestEpoch(groupIdHex);
    if (
      !this.groupRepo.find(groupId) ||
      !latest ||
      !this.isMemberInEpoch(latest, this.identity.edPublicKey)
    ) {
      throw new Error(
        'Cannot send group message without a current member epoch',
      );
    }
    const senderKey = this.senderKeyRepo.load(
      groupId,
      this.identity.edPublicKey,
    );
    if (!senderKey) {
      throw new Error('No sender key for this group');
    }

    const plaintext = new TextEncoder().encode(content);
    if (plaintext.length === 0 || plaintext.length > 65_536) {
      throw new Error('Group message must be 1-65536 UTF-8 bytes');
    }

    const state = {
      chainKey: new Uint8Array(senderKey.chain_key),
      chainIndex: senderKey.chain_index,
    };

    const {
      ciphertext,
      nonce,
      chainIndex: encChainIndex,
      nextState,
    } = SenderKeys.encrypt(state, plaintext);

    // Update stored key state
    this.senderKeyRepo.store(
      groupId,
      this.identity.edPublicKey,
      nextState.chainKey,
      nextState.chainIndex,
    );

    const messageId = createId();

    const message = signAuthenticatedMessage<GroupEncryptedMessage>(
      {
        type: MessageType.GroupMessage,
        groupId,
        senderFingerprint: this.identity.fingerprint,
        chainIndex: encChainIndex,
        epochVersion: latest.epoch.version,
        epochHash: latest.hash,
        ciphertext,
        nonce,
        timestamp: Date.now(),
      },
      this.identity.edPrivateKey,
    );

    // Send to all connected members
    const members = this.groupRepo.getMembers(groupId);
    for (const member of members) {
      const memberKey = new Uint8Array(member.public_key);
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
    const count = (this.messageCounters.get(groupIdHex) ?? 0) + 1;
    this.messageCounters.set(groupIdHex, count);

    if (count >= KEY_ROTATION_INTERVAL) {
      await this.rotateKeys(groupId);
      this.messageCounters.set(groupIdHex, 0);
    }
  }

  async rotateKeys(groupId: Uint8Array): Promise<void> {
    const latest = this.epochRepo.getLatestEpoch(
      Buffer.from(groupId).toString('hex'),
    );
    if (!latest || !this.isMemberInEpoch(latest, this.identity.edPublicKey)) {
      throw new Error('Cannot rotate keys without a current member epoch');
    }
    const newState = SenderKeys.generate();
    this.senderKeyRepo.store(
      groupId,
      this.identity.edPublicKey,
      newState.chainKey,
      newState.chainIndex,
    );

    await this.distributeSenderKeys(groupId);
    this.emit('group:keysRotated', { groupId });
  }

  handleGroupManagement(
    session: PeerSession,
    message: GroupManagementMessage,
  ): void {
    let reservation;
    try {
      reservation = validateAuthenticatedMessage(
        session,
        message,
        this.identity.fingerprint,
      );
    } catch (error) {
      this.emit('error', error);
      return;
    }

    if (message.action !== 'invite' && message.action !== 'kick') {
      this.emit(
        'error',
        new Error(
          `Rejected unsupported GroupManagement action: ${message.action}`,
        ),
      );
      return;
    }
    if (
      message.action === 'invite' &&
      message.targetFingerprint !== this.identity.fingerprint
    ) {
      this.emit(
        'error',
        new Error(
          'Rejected group invite: target does not match recipient identity',
        ),
      );
      return;
    }

    try {
      const shouldLeave = this.replayRepo.accept(reservation, () => {
        const groupIdHex = Buffer.from(message.groupId).toString('hex');
        const latestEpoch = this.epochRepo.getLatestEpoch(groupIdHex);
        if (message.action === 'invite') {
          const genesis: SignedGroupEpoch = {
            epoch: deserializeEpoch(message.genesisEpochData!),
            signature: message.genesisSignature!,
            hash: message.genesisHash!,
          };
          if (
            !verifyGenesisEpoch(genesis, groupIdHex, session.peerPublicKey!)
          ) {
            throw new Error(
              'Rejected group invite: unauthenticated genesis provenance',
            );
          }
          if (
            latestEpoch &&
            !this.isAdminInEpoch(latestEpoch, session.peerPublicKey!)
          ) {
            throw new Error(
              'Rejected group invite: sender is not current admin',
            );
          }
          this.bootstrapRepo.save({
            groupId: message.groupId,
            groupName: message.groupName!,
            inviterPublicKey: session.peerPublicKey!,
            genesisEpochData: message.genesisEpochData!,
            genesisSignature: message.genesisSignature!,
            genesisHash: message.genesisHash!,
            receivedAt: message.timestamp,
          });
          return false;
        }

        if (
          !this.groupRepo.find(message.groupId) ||
          !latestEpoch ||
          !this.isAdminInEpoch(latestEpoch, session.peerPublicKey!)
        ) {
          throw new Error(
            'Rejected group management: unknown, missing epoch, or revoked sender',
          );
        }

        const target = this.groupRepo
          .getMembers(message.groupId)
          .find(
            (member) =>
              fingerprintFromPublicKey(new Uint8Array(member.public_key)) ===
              message.targetFingerprint,
          );
        if (!target) {
          throw new Error(
            'Rejected group kick: target is not a current member',
          );
        }
        if (message.targetFingerprint === this.identity.fingerprint) {
          this.groupRepo.leave(message.groupId);
          return true;
        }
        const targetKey = new Uint8Array(target.public_key);
        this.groupRepo.removeMember(message.groupId, targetKey);
        this.senderKeyRepo.delete(message.groupId, targetKey);
        return false;
      });

      if (message.action === 'invite') {
        this.emit('group:invited', {
          groupId: message.groupId,
          invitedBy: session.peerPublicKey!,
          groupName: message.groupName,
        });
        return;
      }
      if (shouldLeave) {
        const topic = deriveKey(
          message.groupId,
          'networkselfmd-topic-v1',
          '',
          32,
        );
        this.swarm
          .leave(Buffer.from(topic))
          .catch((error) => this.emit('error', error));
      }
      this.emit('group:memberLeft', {
        groupId: message.groupId,
        targetFingerprint: message.targetFingerprint,
      });
    } catch (error) {
      this.emit('error', error);
    }
  }

  handleGroupEpoch(session: PeerSession, message: GroupEpochMessage): void {
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

      const changed = this.replayRepo.accept(reservation, () => {
        const group = this.groupRepo.find(message.groupId);
        if (!group?.creator_public_key || !group.genesis_hash) {
          throw new Error('Rejected epoch: group has no pinned provenance');
        }
        const creator = new Uint8Array(group.creator_public_key);
        const pinnedGenesisHash = new Uint8Array(group.genesis_hash);
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
          return false;
        } else {
          if (epoch.version !== latest.epoch.version + 1) {
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

        this.epochRepo.saveEpoch(signed);
        for (const member of this.groupRepo.getMembers(message.groupId)) {
          if (
            !signed.epoch.members.some((next) =>
              buffersEqual(next.publicKey, new Uint8Array(member.public_key)),
            )
          ) {
            this.groupRepo.removeMember(
              message.groupId,
              new Uint8Array(member.public_key),
            );
            this.senderKeyRepo.delete(
              message.groupId,
              new Uint8Array(member.public_key),
            );
          }
        }
        for (const member of signed.epoch.members) {
          this.groupRepo.addMember(
            message.groupId,
            member.publicKey,
            member.role,
          );
        }
        return true;
      });

      if (changed) {
        this.emit('group:epochUpdated', {
          groupId: message.groupId,
          version: epoch.version,
        });
      }
    } catch (error) {
      this.emit('error', error);
    }
  }

  private isAdminInEpoch(
    signed: SignedGroupEpoch,
    publicKey: Uint8Array,
  ): boolean {
    return signed.epoch.members.some(
      (m) => m.role === 'admin' && buffersEqual(m.publicKey, publicKey),
    );
  }

  private isMemberInEpoch(
    signed: SignedGroupEpoch,
    publicKey: Uint8Array,
  ): boolean {
    return signed.epoch.members.some((member) =>
      buffersEqual(member.publicKey, publicKey),
    );
  }

  private broadcastEpoch(groupId: Uint8Array, signed: SignedGroupEpoch): void {
    const serialized = serializeEpoch(signed.epoch);
    const members = this.groupRepo.getMembers(groupId);
    for (const member of members) {
      const memberKey = new Uint8Array(member.public_key);
      if (buffersEqual(memberKey, this.identity.edPublicKey)) continue;
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

  async rejoinAllGroups(): Promise<void> {
    const groups = this.groupRepo.list();
    for (const group of groups) {
      const groupId = new Uint8Array(group.group_id);
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
