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
} from '../storage/repositories.js';

const KEY_ROTATION_INTERVAL = 100;

export interface GroupManagerOptions {
  identity: AgentIdentity;
  swarm: SwarmManager;
  groups: GroupRepository;
  messages: MessageRepository;
  senderKeys: SenderKeyRepository;
  peers: PeerRepository;
  epochs: GroupEpochRepository;
  invites: GroupInviteRepository;
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
    this.inviteRepo = options.invites;
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
    const anchor = authority ?? (pending ? {
      creatorPublicKey: new Uint8Array(pending.inviter_public_key),
      genesisEpochData: new Uint8Array(pending.genesis_epoch_data),
      genesisSignature: new Uint8Array(pending.genesis_signature),
      genesisHash: new Uint8Array(pending.genesis_hash),
      inviteId: pending.invite_id,
    } : undefined);
    if (!anchor) throw new Error('No authenticated pending invite or public group authority');
    const groupIdHex = Buffer.from(groupId).toString('hex');
    const genesis: SignedGroupEpoch = {
      epoch: deserializeEpoch(anchor.genesisEpochData),
      signature: anchor.genesisSignature,
      hash: anchor.genesisHash,
    };
    if (!verifyGenesisEpoch(genesis, groupIdHex, anchor.creatorPublicKey)) throw new Error('Invalid group genesis trust anchor');

    this.groupRepo.join(groupId, pending?.group_name ?? name, 'member', anchor.creatorPublicKey, anchor.genesisHash);
    this.epochRepo.saveEpoch(genesis);
    await this.swarm.join(Buffer.from(deriveKey(groupId, 'networkselfmd-topic-v1', '', 32)));

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
      session.send({
        type: MessageType.GroupManagement,
        action: 'accept',
        groupId,
        inviteId: acceptInviteId,
        targetFingerprint: this.identity.fingerprint,
        epochVersion: 0,
        epochHash: anchor.genesisHash,
        timestamp: Date.now(),
      });
    }
    this.emit('group:joined', { groupId, name: pending?.group_name ?? name });
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
    const message: ProtocolMessage = {
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
      timestamp: Date.now(),
    };

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

    if (latestEpoch) {
      if (!this.isAdminInEpoch(latestEpoch, this.identity.edPublicKey)) {
        throw new Error('Not authorized: not admin in latest epoch');
      }
    } else if (group.role !== 'admin') {
      console.warn('[GroupManager] No epoch chain found for group, falling back to local role check');
      throw new Error('Not authorized to kick members');
    }

    // Send kick message to all members
    const members = this.groupRepo.getMembers(groupId);
    const memberFingerprint = fingerprintFromPublicKey(memberPublicKey);
    const kickMessage: ProtocolMessage = {
      type: MessageType.GroupManagement,
      action: 'kick',
      groupId,
      targetFingerprint: memberFingerprint,
      timestamp: Date.now(),
    };

    for (const member of members) {
      const fp = fingerprintFromPublicKey(new Uint8Array(member.public_key));
      const session = this.swarm.getSession(fp);
      if (session) {
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
        timestamp: Date.now(),
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

  handleSenderKeyDistribution(
    session: PeerSession,
    message: SenderKeyDistributionMessage,
  ): void {
    if (!session.peerPublicKey || !session.peerXPublicKey) return;
    if (!Number.isSafeInteger(message.timestamp) || Math.abs(Date.now() - message.timestamp) > 5 * 60 * 1000 || !(message.ciphertext instanceof Uint8Array) || message.ciphertext.length === 0 || message.ciphertext.length > 64 * 1024) return;

    let payload;
    try {
      payload = SenderKeys.decryptDistribution(
        message,
        this.identity.xPrivateKey,
        this.identity.edPublicKey,
        session.peerXPublicKey,
        session.peerPublicKey,
      );
    } catch {
      console.warn('[GroupManager] Rejecting invalid sender-key distribution');
      return;
    }

    // Never let a sender-key envelope create a group or bootstrap trust. Both
    // the local group and a signed epoch chain must already exist.
    const group = this.groupRepo.find(payload.groupId);
    if (!group) {
      console.warn('[GroupManager] Rejecting sender key for unknown group');
      return;
    }

    const groupIdHex = Buffer.from(payload.groupId).toString('hex');
    const latestEpoch = this.epochRepo.getLatestEpoch(groupIdHex);
    if (!latestEpoch) {
      console.warn('[GroupManager] Rejecting sender key without group epoch');
      return;
    }

    if (
      payload.epochVersion !== latestEpoch.epoch.version ||
      !buffersEqual(payload.epochHash, latestEpoch.hash)
    ) {
      console.warn('[GroupManager] Rejecting sender key for stale group epoch');
      return;
    }

    if (
      !this.isMemberInEpoch(latestEpoch, this.identity.edPublicKey) ||
      !this.isMemberInEpoch(latestEpoch, session.peerPublicKey)
    ) {
      console.warn('[GroupManager] Rejecting sender key from non-member in latest epoch');
      return;
    }
    const senderPublicKey = session.peerPublicKey;

    if (!this.senderKeyRepo.storeIfNewer(
      payload.groupId,
      senderPublicKey,
      payload.chainKey,
      payload.chainIndex,
      payload.generationId,
      payload.sequence,
      payload.epochVersion,
      payload.epochHash,
    )) {
      console.warn('[GroupManager] Rejecting replayed sender-key distribution');
      return;
    }

    const sender = latestEpoch.epoch.members.find((member) =>
      buffersEqual(member.publicKey, senderPublicKey),
    );
    this.groupRepo.addMember(
      payload.groupId,
      senderPublicKey,
      sender?.role ?? 'member',
    );
  }

  async handleGroupMessage(
    session: PeerSession,
    message: GroupEncryptedMessage,
  ): Promise<void> {
    if (!session.peerPublicKey) return;
    if (!(message.groupId instanceof Uint8Array) || message.groupId.length !== 32 || !(message.generationId instanceof Uint8Array) || message.generationId.length !== 16 || !(message.epochHash instanceof Uint8Array) || message.epochHash.length !== 32 || !(message.nonce instanceof Uint8Array) || message.nonce.length !== 24 || !(message.ciphertext instanceof Uint8Array) || message.ciphertext.length === 0 || message.ciphertext.length > 64 * 1024 || message.senderFingerprint !== session.peerFingerprint || !Number.isSafeInteger(message.chainIndex) || message.chainIndex < 0 || !Number.isSafeInteger(message.epochVersion) || message.epochVersion < 0 || !Number.isSafeInteger(message.timestamp) || Math.abs(Date.now() - message.timestamp) > 5 * 60 * 1000) return;

    const senderKey = this.senderKeyRepo.load(
      message.groupId,
      session.peerPublicKey,
    );
    if (!senderKey) {
      this.emit('error', new Error('No sender key for peer'));
      return;
    }
    const latest = this.epochRepo.getLatestEpoch(Buffer.from(message.groupId).toString('hex'));
    if (!latest || !senderKey.generation_id || !senderKey.epoch_hash ||
      message.epochVersion !== latest.epoch.version || !buffersEqual(message.epochHash, latest.hash) ||
      !buffersEqual(message.generationId, new Uint8Array(senderKey.generation_id))) {
      this.emit('error', new Error('Rejected group message outside current sender-key generation/epoch'));
      return;
    }

    try {
      const record = {
        chainKey: new Uint8Array(senderKey.chain_key),
        chainIndex: senderKey.chain_index,
        skippedKeys: new Map<number, Uint8Array>(),
      };

      const { plaintext, nextRecord } = SenderKeys.decrypt(
        record,
        message.chainIndex,
        message.nonce,
        message.ciphertext,
        groupMessageAad(message.groupId, session.peerPublicKey, message.generationId, message.epochVersion, message.epochHash, message.chainIndex),
      );

      // Update stored key state
      this.senderKeyRepo.store(
        message.groupId,
        session.peerPublicKey,
        nextRecord.chainKey,
        nextRecord.chainIndex,
        new Uint8Array(senderKey.generation_id),
        senderKey.distribution_sequence,
        senderKey.epoch_version,
        new Uint8Array(senderKey.epoch_hash),
      );

      const content = new TextDecoder().decode(plaintext);

      this.messageRepo.insert({
        id: createId(),
        groupId: message.groupId,
        senderPublicKey: session.peerPublicKey,
        content,
        timestamp: message.timestamp ?? Date.now(),
        type: 'group',
      });

      this.emit('group:message', {
        groupId: message.groupId,
        senderPublicKey: session.peerPublicKey,
        senderFingerprint: session.peerFingerprint,
        content,
        timestamp: message.timestamp,
      });
    } catch (err) {
      this.emit('error', err);
    }
  }

  async sendGroupMessage(
    groupId: Uint8Array,
    content: string,
  ): Promise<void> {
    const senderKey = this.senderKeyRepo.load(groupId, this.identity.edPublicKey);
    if (!senderKey || !senderKey.generation_id || !senderKey.epoch_hash) {
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

    const message: ProtocolMessage = {
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
    };

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
    const groupHex = Buffer.from(groupId).toString('hex');
    const count = (this.messageCounters.get(groupHex) ?? 0) + 1;
    this.messageCounters.set(groupHex, count);

    if (count >= KEY_ROTATION_INTERVAL) {
      await this.rotateKeys(groupId);
      this.messageCounters.set(groupHex, 0);
    }
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
    if (!session.peerPublicKey) return;
    if (!(message.groupId instanceof Uint8Array) || message.groupId.length !== 32 || !Number.isSafeInteger(message.timestamp) || Math.abs(Date.now() - message.timestamp) > 5 * 60 * 1000) return;
    if ((message.inviteId !== undefined && (typeof message.inviteId !== 'string' || message.inviteId.length > 128)) || (message.groupName !== undefined && (typeof message.groupName !== 'string' || new TextEncoder().encode(message.groupName).length > 128)) || (message.genesisEpochData !== undefined && (!(message.genesisEpochData instanceof Uint8Array) || message.genesisEpochData.length > 4096))) return;

    const groupIdHex = Buffer.from(message.groupId).toString('hex');
    const latestEpoch = this.epochRepo.getLatestEpoch(groupIdHex);

    // If we have an epoch chain, verify the sender is admin in the latest epoch
    if (latestEpoch && (message.action === 'kick' || message.action === 'invite')) {
      if (!this.isAdminInEpoch(latestEpoch, session.peerPublicKey)) {
        console.warn('[GroupManager] Rejecting group management from non-admin peer');
        return;
      }
    }

    switch (message.action) {
      case 'invite': {
        if (
          message.targetFingerprint !== this.identity.fingerprint ||
          !message.inviteId || !message.groupName ||
          !message.genesisEpochData || !message.genesisSignature || !message.genesisHash
        ) return;
        const genesis: SignedGroupEpoch = {
          epoch: deserializeEpoch(message.genesisEpochData),
          signature: message.genesisSignature,
          hash: message.genesisHash,
        };
        if (!verifyGenesisEpoch(genesis, groupIdHex, session.peerPublicKey)) return;
        this.inviteRepo.save({
          invite_id: message.inviteId,
          group_name: message.groupName,
          groupId: message.groupId,
          inviterPublicKey: session.peerPublicKey,
          inviteePublicKey: this.identity.edPublicKey,
          genesisEpochData: message.genesisEpochData,
          genesisSignature: message.genesisSignature,
          genesisHash: message.genesisHash,
          direction: 'incoming',
          created_at: message.timestamp,
        });
        this.emit('group:invited', {
          groupId: message.groupId,
          invitedBy: session.peerPublicKey,
          groupName: message.groupName,
          inviteId: message.inviteId,
        });
        break;
      }

      case 'accept': {
        if (message.targetFingerprint !== session.peerFingerprint || !message.inviteId || !latestEpoch) return;
        const pending = this.inviteRepo.findById(message.inviteId);
        const group = this.groupRepo.find(message.groupId);
        if (pending) {
          if (pending.direction !== 'outgoing' || !buffersEqual(new Uint8Array(pending.invitee_public_key), session.peerPublicKey)) return;
        } else if (!group?.is_public) {
          return;
        }
        if (!this.isAdminInEpoch(latestEpoch, this.identity.edPublicKey)) return;
        if (this.isMemberInEpoch(latestEpoch, session.peerPublicKey)) {
          this.sendEpochChain(message.groupId, session, 0);
          return;
        }
        const newMembers: GroupMemberEntry[] = [...latestEpoch.epoch.members, { publicKey: session.peerPublicKey, role: 'member' }];
        const signedEpoch = createSignedEpoch({
          version: latestEpoch.epoch.version + 1,
          prevHash: latestEpoch.hash,
          groupId: groupIdHex,
          members: newMembers,
          timestamp: Date.now(),
          createdBy: this.identity.edPublicKey,
        }, this.identity.edPrivateKey);
        this.epochRepo.saveEpoch(signedEpoch);
        this.syncMembershipToEpoch(message.groupId, signedEpoch);
        this.broadcastEpoch(message.groupId, signedEpoch);
        this.sendEpochChain(message.groupId, session, 0);
        if (pending) this.inviteRepo.delete(pending.invite_id);
        await this.distributeSenderKeys(message.groupId);
        break;
      }

      case 'sync-request':
        if (latestEpoch && this.isMemberInEpoch(latestEpoch, session.peerPublicKey)) {
          this.sendEpochChain(message.groupId, session, (message.epochVersion ?? -1) + 1);
        }
        break;

      case 'kick':
        if (
          message.targetFingerprint &&
          message.targetFingerprint === this.identity.fingerprint
        ) {
          await this.leaveGroup(message.groupId);
        } else if (message.targetFingerprint) {
          const members = this.groupRepo.getMembers(message.groupId);
          for (const member of members) {
            const memberKey = new Uint8Array(member.public_key);
            const fp = fingerprintFromPublicKey(memberKey);
            if (fp === message.targetFingerprint) {
              this.groupRepo.removeMember(message.groupId, memberKey);
              this.senderKeyRepo.delete(message.groupId, memberKey);
              break;
            }
          }
          this.emit('group:memberLeft', {
            groupId: message.groupId,
            targetFingerprint: message.targetFingerprint,
          });
        }
        break;
    }
  }

  handleGroupEpoch(
    session: PeerSession,
    message: GroupEpochMessage,
  ): void {
    if (!session.peerPublicKey) return;
    if (!(message.groupId instanceof Uint8Array) || message.groupId.length !== 32 || !(message.epochData instanceof Uint8Array) || message.epochData.length === 0 || message.epochData.length > 256 * 1024 || !(message.signature instanceof Uint8Array) || message.signature.length !== 64 || !(message.hash instanceof Uint8Array) || message.hash.length !== 32 || !Number.isSafeInteger(message.timestamp) || Math.abs(Date.now() - message.timestamp) > 5 * 60 * 1000) return;

    const groupIdHex = Buffer.from(message.groupId).toString('hex');
    if (!this.groupRepo.find(message.groupId)) {
      console.warn('[GroupManager] Rejecting epoch for unknown group');
      return;
    }

    const group = this.groupRepo.find(message.groupId)!;
    let epochData: Uint8Array;
    let epoch;
    try {
      epochData = new Uint8Array(message.epochData);
      epoch = deserializeEpoch(epochData);
    } catch {
      console.warn('[GroupManager] Rejecting malformed epoch');
      return;
    }
    const computedHash = hashEpoch(epochData);

    if (
      epoch.groupId !== groupIdHex ||
      !buffersEqual(computedHash, message.hash)
    ) {
      console.warn('[GroupManager] Rejecting epoch: group or hash mismatch');
      return;
    }

    const signed: SignedGroupEpoch = {
      epoch,
      signature: message.signature,
      hash: computedHash,
    };

    const latestEpoch = this.epochRepo.getLatestEpoch(groupIdHex);

    if (!group.creator_public_key || !group.genesis_hash) {
      console.warn('[GroupManager] Rejecting epoch without pinned authority');
      return;
    }

    if (epoch.version === 0) {
      if (!verifyGenesisEpoch(signed, groupIdHex, new Uint8Array(group.creator_public_key)) || !buffersEqual(signed.hash, new Uint8Array(group.genesis_hash))) {
        console.warn('[GroupManager] Rejecting unpinned genesis');
        return;
      }
      if (latestEpoch) return;
    }

    if (latestEpoch) {
      if (epoch.version <= latestEpoch.epoch.version) return;
      // Verify against the previous epoch
      if (epoch.version !== latestEpoch.epoch.version + 1) {
        console.warn('[GroupManager] Rejecting epoch: version mismatch');
        this.requestEpochSync(message.groupId, session, latestEpoch);
        return;
      }
      if (epoch.timestamp < latestEpoch.epoch.timestamp) {
        console.warn('[GroupManager] Rejecting epoch: non-monotonic timestamp');
        return;
      }

      // createdBy must be admin in the PREVIOUS epoch
      if (!this.isAdminInEpoch(latestEpoch, epoch.createdBy)) {
        console.warn('[GroupManager] Rejecting epoch: creator is not admin in previous epoch');
        return;
      }

      if (!verifyEpoch(signed, latestEpoch.hash)) {
        console.warn('[GroupManager] Rejecting epoch: verification failed');
        return;
      }
    } else {
      if (!verifyGenesisEpoch(signed, groupIdHex, new Uint8Array(group.creator_public_key))) {
        console.warn('[GroupManager] Rejecting epoch: genesis verification failed');
        return;
      }
    }

    const removedMember = latestEpoch?.epoch.members.some((oldMember) =>
      !signed.epoch.members.some((member) => buffersEqual(member.publicKey, oldMember.publicKey)),
    ) ?? false;
    this.epochRepo.saveEpoch(signed);
    this.syncMembershipToEpoch(message.groupId, signed);
    if (!this.isMemberInEpoch(signed, this.identity.edPublicKey)) {
      this.leaveGroup(message.groupId).catch((err) => this.emit('error', err));
      return;
    }
    this.inviteRepo.deleteIncoming(message.groupId);
    if (removedMember) {
      const previous = this.senderKeyRepo.load(message.groupId, this.identity.edPublicKey);
      this.senderKeyRepo.deleteForGroup(message.groupId);
      const state = SenderKeys.generate();
      this.senderKeyRepo.store(message.groupId, this.identity.edPublicKey, state.chainKey, 0, crypto.getRandomValues(new Uint8Array(16)), previous?.distribution_sequence ?? -1, signed.epoch.version, signed.hash);
    } else if (!this.senderKeyRepo.load(message.groupId, this.identity.edPublicKey)) {
      const state = SenderKeys.generate();
      this.senderKeyRepo.store(message.groupId, this.identity.edPublicKey, state.chainKey, 0, crypto.getRandomValues(new Uint8Array(16)), -1, signed.epoch.version, signed.hash);
    }
    this.distributeSenderKeys(message.groupId).catch((err) => this.emit('error', err));
    this.emit('group:epochUpdated', { groupId: message.groupId, version: epoch.version });
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
    const epochMessage: ProtocolMessage = {
      type: MessageType.GroupEpoch,
      groupId,
      epochData: serialized,
      signature: signed.signature,
      hash: signed.hash,
      timestamp: Date.now(),
    };

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
          session.send(epochMessage);
        } catch {
          // Ignore send errors
        }
      }
    }
  }

  private sendEpochChain(groupId: Uint8Array, session: PeerSession, fromVersion = 0): void {
    const groupIdHex = Buffer.from(groupId).toString('hex');
    for (const signed of this.epochRepo.getEpochChain(groupIdHex)) {
      if (signed.epoch.version < fromVersion) continue;
      const message: ProtocolMessage = {
        type: MessageType.GroupEpoch,
        groupId,
        epochData: serializeEpoch(signed.epoch),
        signature: signed.signature,
        hash: signed.hash,
        timestamp: Date.now(),
      };
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
        session.send({
          type: MessageType.GroupManagement,
          action: 'accept',
          groupId,
          inviteId: pending.invite_id,
          targetFingerprint: this.identity.fingerprint,
          epochVersion: latest.epoch.version,
          epochHash: latest.hash,
          timestamp: Date.now(),
        });
      }
      this.requestEpochSync(groupId, session, latest);
      if (this.isAdminInEpoch(latest, this.identity.edPublicKey)) this.sendEpochChain(groupId, session, 0);
    }
  }

  private requestEpochSync(groupId: Uint8Array, session: PeerSession, latest: SignedGroupEpoch): void {
    try {
      session.send({
        type: MessageType.GroupManagement,
        action: 'sync-request',
        groupId,
        epochVersion: latest.epoch.version,
        epochHash: latest.hash,
        timestamp: Date.now(),
      });
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
      if (genesis && verifyGenesisEpoch(genesis, groupIdHex)) {
        if (!group.creator_public_key || !group.genesis_hash) {
          this.groupRepo.pinAuthority(groupId, genesis.epoch.createdBy, genesis.hash);
        }
        const localKey = this.senderKeyRepo.load(groupId, this.identity.edPublicKey);
        if (latest && this.isMemberInEpoch(latest, this.identity.edPublicKey) && (!localKey || !localKey.generation_id)) {
          const state = SenderKeys.generate();
          this.senderKeyRepo.store(groupId, this.identity.edPublicKey, state.chainKey, 0, crypto.getRandomValues(new Uint8Array(16)), localKey?.distribution_sequence ?? -1, latest.epoch.version, latest.hash);
        }
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
