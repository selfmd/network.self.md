import { describe, expect, it } from 'vitest';
import {
  canonicalAnnouncePayload,
  createGenesisEpoch,
  createSignedEpoch,
  decodeMessage,
  encodeMessage,
  generateIdentity,
  MessageType,
  NETWORK_ANNOUNCE_VERSION,
  serializeEpoch,
  signAnnounce,
  verifyAnnounce,
  verifyAnnouncedGroupAuthority,
} from '../index.js';
import type { NetworkAnnounceMessage } from '../index.js';

function announcedGroup(identity = generateIdentity(), fill = 1) {
  const groupId = new Uint8Array(32).fill(fill);
  const genesis = createSignedEpoch(
    createGenesisEpoch(toHex(groupId), identity.edPublicKey, 1_700_000_000_000),
    identity.edPrivateKey,
  );
  return {
    identity,
    group: {
      groupId,
      name: 'builders',
      selfMd: 'We build things.',
      memberCount: 1,
      genesisEpochData: serializeEpoch(genesis.epoch),
      genesisSignature: genesis.signature,
      genesisHash: genesis.hash,
    },
  };
}

describe('NetworkAnnounce canonical authentication', () => {
  it('round-trips the exhaustive versioned schema', () => {
    const { group } = announcedGroup();
    const message: NetworkAnnounceMessage = {
      type: MessageType.NetworkAnnounce,
      protocolVersion: NETWORK_ANNOUNCE_VERSION,
      groups: [group],
      signature: new Uint8Array(64),
      timestamp: 1_700_000_000_001,
    };
    expect(decodeMessage(encodeMessage(message))).toEqual(message);
  });

  it('binds the version, ordered groups, provenance, and timestamp', () => {
    const { identity, group } = announcedGroup();
    const timestamp = 1_700_000_000_001;
    const signature = signAnnounce([group], timestamp, identity.edPrivateKey);
    expect(
      verifyAnnounce([group], timestamp, signature, identity.edPublicKey),
    ).toBe(true);
    expect(
      verifyAnnounce(
        [{ ...group, selfMd: 'tampered' }],
        timestamp,
        signature,
        identity.edPublicKey,
      ),
    ).toBe(false);
    expect(
      verifyAnnounce([group], timestamp + 1, signature, identity.edPublicKey),
    ).toBe(false);
    expect(
      verifyAnnounce([group], timestamp, signature, identity.edPublicKey, 1),
    ).toBe(false);
  });

  it('rejects non-canonical order and duplicate group IDs', () => {
    const first = announcedGroup(undefined, 1).group;
    const second = announcedGroup(undefined, 2).group;
    expect(() => canonicalAnnouncePayload(2, [second, first], 1)).toThrow(
      /canonical/i,
    );
    expect(() => canonicalAnnouncePayload(2, [first, first], 1)).toThrow(
      /canonical/i,
    );
  });

  it('authenticates exact genesis provenance', () => {
    const { identity, group } = announcedGroup();
    expect(verifyAnnouncedGroupAuthority(group, identity.edPublicKey)).toBe(
      true,
    );
    expect(
      verifyAnnouncedGroupAuthority(group, generateIdentity().edPublicKey),
    ).toBe(false);
  });

  it('matches the canonical payload golden vector', () => {
    const group = {
      groupId: new Uint8Array(32).fill(1),
      name: 'g',
      selfMd: '',
      memberCount: 1,
      genesisEpochData: new Uint8Array([0xaa]),
      genesisSignature: new Uint8Array(64).fill(2),
      genesisHash: new Uint8Array(32).fill(3),
    };
    expect(toHex(canonicalAnnouncePayload(2, [group], 5))).toBe(
      '6e6574776f726b2e73656c662e6d642f4e6574776f726b416e6e6f756e63652f76320000020000000000000005000101010101010101010101010101010101010101010101010101010101010101010000000167000000000000000100000001aa020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020303030303030303030303030303030303030303030303030303030303030303',
    );
  });
});

function toHex(value: Uint8Array): string {
  return Buffer.from(value).toString('hex');
}
