import { describe, expect, it } from 'vitest';
import {
  MessageType,
  NETWORK_ANNOUNCE_VERSION,
  assertAnnounceShape,
  canonicalAnnouncePayload,
  createGenesisEpoch,
  createSignedEpoch,
  decodeMessage,
  encodeMessage,
  generateIdentity,
  serializeEpoch,
  signAnnounce,
  verifyAnnounce,
  verifyAnnouncedGroupAuthority,
} from '../index.js';
import type { AgentIdentity, NetworkAnnounceMessage } from '../index.js';

function announcedGroup(identity: AgentIdentity, fill = 1) {
  const groupId = new Uint8Array(32).fill(fill);
  const genesis = createSignedEpoch(
    createGenesisEpoch(Buffer.from(groupId).toString('hex'), identity.edPublicKey),
    identity.edPrivateKey,
  );
  return {
    groupId,
    name: 'builders',
    selfMd: 'We build things.',
    memberCount: 1,
    genesisEpochData: serializeEpoch(genesis.epoch),
    genesisSignature: genesis.signature,
    genesisHash: genesis.hash,
  };
}

function announce(identity: AgentIdentity): NetworkAnnounceMessage {
  const groups = [announcedGroup(identity)];
  const timestamp = Date.now();
  return {
    type: MessageType.NetworkAnnounce,
    protocolVersion: NETWORK_ANNOUNCE_VERSION,
    groups,
    signature: signAnnounce(groups, timestamp, identity.edPrivateKey),
    timestamp,
  };
}

describe('canonical NetworkAnnounce', () => {
  it('round-trips and verifies its domain-separated, versioned payload', () => {
    const identity = generateIdentity();
    const message = announce(identity);
    const decoded = decodeMessage(encodeMessage(message)) as NetworkAnnounceMessage;
    expect(decoded.protocolVersion).toBe(1);
    expect(verifyAnnounce(decoded.groups, decoded.timestamp, decoded.signature, identity.edPublicKey, decoded.protocolVersion)).toBe(true);
    expect(canonicalAnnouncePayload(1, decoded.groups, decoded.timestamp)).toEqual(canonicalAnnouncePayload(1, message.groups, message.timestamp));
  });

  it('rejects version substitution, tampering, and a different signing key', () => {
    const identity = generateIdentity();
    const attacker = generateIdentity();
    const message = announce(identity);
    expect(verifyAnnounce(message.groups, message.timestamp, message.signature, attacker.edPublicKey)).toBe(false);
    expect(verifyAnnounce([{ ...message.groups[0], selfMd: 'hijacked' }], message.timestamp, message.signature, identity.edPublicKey)).toBe(false);
    expect(verifyAnnounce(message.groups, message.timestamp, message.signature, identity.edPublicKey, 2)).toBe(false);
  });

  it('enforces freshness, canonical order, duplicates, and field limits', () => {
    const identity = generateIdentity();
    const message = announce(identity);
    expect(() => assertAnnounceShape(message, message.timestamp + 300_001)).toThrow(/stale/i);
    const duplicate = { ...message, groups: [message.groups[0], message.groups[0]] };
    expect(() => assertAnnounceShape(duplicate)).toThrow(/duplicate/i);
    expect(() => assertAnnounceShape({ ...message, groups: [{ ...message.groups[0], name: 'x'.repeat(129) }] })).toThrow(/name/i);
  });

  it('requires an exact signed genesis anchored to the authenticated announcer', () => {
    const owner = generateIdentity();
    const attacker = generateIdentity();
    const group = announcedGroup(owner);
    expect(verifyAnnouncedGroupAuthority(group, owner.edPublicKey)).toBe(true);
    expect(verifyAnnouncedGroupAuthority(group, attacker.edPublicKey)).toBe(false);
    expect(verifyAnnouncedGroupAuthority({ ...group, genesisHash: new Uint8Array(32) }, owner.edPublicKey)).toBe(false);
  });
});
