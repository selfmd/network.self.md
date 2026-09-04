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
}

export class GroupManager extends EventEmitter {
  private identity: AgentIdentity;
  private swarm: SwarmManager;
  private groupRepo: GroupRepository;
  private messageRepo: MessageRepository;
  private senderKeyRepo: SenderKeyRepository;
  private peerRepo: PeerRepository;
  private epochRepo: GroupEpochRepository;
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

    this.groupRepo.create(groupId, name, 'admin');

    // Add self as member
    this.groupRepo.addMember(groupId, this.identity.edPublicKey, 'admin');

    // Create and store genesis epoch
    const groupIdHex = Buffer.from(groupId).toString('hex');
    const genesisEpoch = createGenesisEpoch(groupIdHex, this.identity.edPublicKey);
    const signedGenesis = createSignedEpoch(genesisEpoch, this.identity.edPrivateKey);
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

  async joinGroup(groupId: Uint8Array, name: string = 'Unknown Group'): Promise<void> {
    const topic = deriveKey(groupId, 'networkselfmd-topic-v1', '', 32);
    this.groupRepo.join(groupId, name, 'member');

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

    // Register any peers whose sender keys we already received for this group
    const existingKeys = this.senderKeyRepo.listForGroup(groupId);
    for (const key of existingKeys) {
      const pk = new Uint8Array(key.public_key);
      if (!buffersEqual(pk, this.identity.edPublicKey)) {
        this.groupRepo.addMember(groupId, pk, 'member');
      }
    }

    // Distribute sender keys to already-connected peers
    await this.distributeSenderKeys(groupId);

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

    const message: ProtocolMessage = {
      type: MessageType.GroupManagement,
      action: 'invite',
      groupId,
      targetFingerprint: peerFingerprint,
      groupName: group.name,
      timestamp: Date.now(),
    };

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
        timestamp: Date.now(),
        createdBy: this.identity.edPublicKey,
      };
      const signedEpoch = createSignedEpoch(newEpoch, this.identity.edPrivateKey);
      this.epochRepo.saveEpoch(signedEpoch);
      // Existing members only need the new epoch. The invitee needs the full
      // chain so it can authenticate the epoch that first includes it.
      this.broadcastEpoch(groupId, signedEpoch, peerPublicKey);
      this.sendEpochChain(groupId, session);
      await this.distributeSenderKeys(groupId);
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
    await this.rotateKeys(groupId);
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
    if (!senderKey) return;

    const payload = SenderKeys.createDistribution(
      groupId,
      {
        chainKey: new Uint8Array(senderKey.chain_key),
        chainIndex: senderKey.chain_index,
      },
      this.identity.edPublicKey,
      latestEpoch.epoch.version,
      latestEpoch.hash,
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
        !buffersEqual(session.peerPublicKey, member.publicKey)
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

    this.senderKeyRepo.store(
      payload.groupId,
      senderPublicKey,
      payload.chainKey,
      payload.chainIndex,
    );

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

    const senderKey = this.senderKeyRepo.load(
      message.groupId,
      session.peerPublicKey,
    );
    if (!senderKey) {
      this.emit('error', new Error('No sender key for peer'));
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
      );

      // Update stored key state
      this.senderKeyRepo.store(
        message.groupId,
        session.peerPublicKey,
        nextRecord.chainKey,
        nextRecord.chainIndex,
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
    if (!senderKey) {
      throw new Error('No sender key for this group');
    }

    const plaintext = new TextEncoder().encode(content);

    const state = {
      chainKey: new Uint8Array(senderKey.chain_key),
      chainIndex: senderKey.chain_index,
    };

    const { ciphertext, nonce, chainIndex: encChainIndex, nextState } = SenderKeys.encrypt(state, plaintext);

    // Update stored key state
    this.senderKeyRepo.store(
      groupId,
      this.identity.edPublicKey,
      nextState.chainKey,
      nextState.chainIndex,
    );

    const messageId = createId();

    const message: ProtocolMessage = {
      type: MessageType.GroupMessage,
      groupId,
      senderFingerprint: this.identity.fingerprint,
      chainIndex: encChainIndex,
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

  async rotateKeys(groupId: Uint8Array): Promise<void> {
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
    if (!session.peerPublicKey) return;

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
      case 'invite':
        this.emit('group:invited', {
          groupId: message.groupId,
          invitedBy: session.peerPublicKey,
          groupName: message.groupName,
        });
        break;

      case 'kick':
        if (
          message.targetFingerprint &&
          message.targetFingerprint === this.identity.fingerprint
        ) {
          this.leaveGroup(message.groupId).catch((err) => {
            this.emit('error', err);
          });
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

    const groupIdHex = Buffer.from(message.groupId).toString('hex');
    if (!this.groupRepo.find(message.groupId)) {
      console.warn('[GroupManager] Rejecting epoch for unknown group');
      return;
    }

    const epochData = new Uint8Array(message.epochData);
    const epoch = deserializeEpoch(epochData);
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

    if (latestEpoch) {
      // Verify against the previous epoch
      if (epoch.version !== latestEpoch.epoch.version + 1) {
        console.warn('[GroupManager] Rejecting epoch: version mismatch');
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
      // No existing chain -- verify as genesis
      const zeroHash = new Uint8Array(32);
      if (!verifyEpoch(signed, zeroHash)) {
        console.warn('[GroupManager] Rejecting epoch: genesis verification failed');
        return;
      }
    }

    this.epochRepo.saveEpoch(signed);
    this.syncMembershipToEpoch(message.groupId, signed);
    this.distributeSenderKeys(message.groupId).catch((err) => {
      this.emit('error', err);
    });
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

  private sendEpochChain(groupId: Uint8Array, session: PeerSession): void {
    const groupIdHex = Buffer.from(groupId).toString('hex');
    for (const signed of this.epochRepo.getEpochChain(groupIdHex)) {
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
