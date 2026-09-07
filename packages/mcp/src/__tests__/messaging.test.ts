import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Agent } from '@networkselfmd/node';
import { InboundEventQueue } from '@networkselfmd/node';
import { createServer } from '../server.js';

const stateId = 'ab'.repeat(32);
const peerPublicKey = 'cd'.repeat(32);

describe('MCP message reads over the protocol', () => {
  let client: Client;
  let server: McpServer;
  const getMessages = vi.fn(() => []);
  let agent: Agent;

  beforeEach(async () => {
    getMessages.mockClear();
    agent = {
      getMessages,
      inboundQueue: new InboundEventQueue(),
      createGroup: vi.fn(async () => ({ groupId: Buffer.from(stateId, 'hex') })),
      updateGroupManifest: vi.fn(),
      listGroupInvitations: vi.fn(() => [{
        inviteId: 'invite-1', groupId: Buffer.from(stateId, 'hex'), name: 'builders',
        inviterPublicKey: Buffer.from(peerPublicKey, 'hex'), inviterFingerprint: 'inviter',
        createdAt: 1000, expiresAt: 86401000,
      }]),
      sendGroupMessage: vi.fn(async () => 'group-delivery-1'),
      sendDirectMessage: vi.fn(async () => 'direct-delivery-1'),
      listDeliveries: vi.fn(() => [{ id: 'direct-delivery-1', peerPublicKey, status: 'queued', attempts: 0, error: null }]),
      isRunning: true,
      start: vi.fn(async () => { Object.assign(agent, { isRunning: true }); }),
      setDisplayName: vi.fn((displayName: string) => { agent.identity.displayName = displayName; }),
      identity: { fingerprint: 'test-agent', edPublicKey: Buffer.from(peerPublicKey, 'hex'), displayName: 'Existing name' },
    } as unknown as Agent;
    server = createServer(agent);
    client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
  });

  it('exposes a reusable hex public key from both identity interfaces', async () => {
    const result = await client.callTool({ name: 'agent_init', arguments: {} });
    const content = result.content as Array<{ type: string; text: string }>;
    expect(JSON.parse(content[0]!.text).publicKey).toBe(peerPublicKey);
    const resource = await client.readResource({ uri: 'agent://identity' });
    const identity = resource.contents[0]!;
    expect('text' in identity && JSON.parse(identity.text).publicKey).toBe(peerPublicKey);
  });

  it('advertises only implemented tools and does not expose deferred TTYA tools', async () => {
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(28);
    expect(tools.some((tool) => tool.name.startsWith('ttya_'))).toBe(false);
    expect(tools.map((tool) => tool.name)).toContain('send_direct_message');
  });

  it('validates bounded private event drains before consuming the queue', async () => {
    agent.inboundQueue.push({ kind: 'dm', messageId: 'private-message',
      senderPublicKey: Buffer.from(peerPublicKey, 'hex'), senderFingerprint: 'peer',
      plaintext: new TextEncoder().encode('owner-only content'), timestamp: 1, receivedAt: 2 });
    for (const limit of [0, -1, 1001, 1.5]) {
      const result = await client.callTool({ name: 'get_pending_inbound_events', arguments: { limit } });
      expect(result.isError).toBe(true);
      expect(agent.inboundQueue.size()).toBe(1);
    }
    const result = await client.callTool({ name: 'get_pending_inbound_events', arguments: { limit: 1 } });
    const content = result.content as Array<{ type: string; text: string }>;
    expect(JSON.parse(content[0].text).events[0]).toMatchObject({
      messageId: 'private-message', senderPublicKeyHex: peerPublicKey, plaintextUtf8: 'owner-only content',
      plaintextBase64: Buffer.from('owner-only content').toString('base64'),
    });
    expect(agent.inboundQueue.size()).toBe(0);
  });

  it('exposes actionable incoming invitations with hexadecimal state IDs', async () => {
    const result = await client.callTool({ name: 'state_invites', arguments: {} });
    const content = result.content as Array<{ type: string; text: string }>;
    expect(JSON.parse(content[0]!.text).invitations).toEqual([{
      inviteId: 'invite-1', stateId, name: 'builders', inviterPublicKey: peerPublicKey,
      inviterFingerprint: 'inviter', createdAt: 1000, expiresAt: 86401000,
    }]);
  });

  it('passes private manifesto creation and updates to the runtime', async () => {
    await client.callTool({ name: 'state_found', arguments: { name: 'builders', selfMd: 'Shared rules' } });
    expect(agent.createGroup).toHaveBeenCalledWith('builders', { selfMd: 'Shared rules' });
    await client.callTool({ name: 'state_update_manifest', arguments: { stateId, selfMd: 'Revised rules' } });
    expect(agent.updateGroupManifest).toHaveBeenCalledWith(stateId, 'Revised rules');
  });

  it.each([
    ['send_state_message', { stateId, content: 'hello' }, 'group-delivery-1'],
    ['send_direct_message', { peerPublicKey, content: 'hello' }, 'direct-delivery-1'],
  ])('returns an acceptance ID, not a delivery claim, for %s', async (name, args, messageId) => {
    const result = await client.callTool({ name: name as string, arguments: args as Record<string, unknown> });
    const content = result.content as Array<{ type: string; text: string }>;
    expect(JSON.parse(content[0]!.text)).toEqual({ accepted: true, messageId });
  });

  it('queries recipient delivery state for a specific acceptance ID', async () => {
    const result = await client.callTool({ name: 'delivery_status', arguments: { messageId: 'direct-delivery-1' } });
    expect(agent.listDeliveries).toHaveBeenCalledWith('direct-delivery-1');
    const content = result.content as Array<{ type: string; text: string }>;
    expect(JSON.parse(content[0]!.text).deliveries[0].status).toBe('queued');
  });

  it.each([true, false])('applies a requested name when running=%s', async (isRunning) => {
    Object.assign(agent, { isRunning });
    const result = await client.callTool({ name: 'agent_init', arguments: { displayName: 'Hermes' } });
    expect(result.isError).not.toBe(true);
    expect(agent.setDisplayName).toHaveBeenCalledWith('Hermes');
    expect(agent.start).toHaveBeenCalledTimes(isRunning ? 0 : 1);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(JSON.parse(content[0]!.text).displayName).toBe('Hermes');
    const resource = await client.readResource({ uri: 'agent://identity' });
    const identity = resource.contents[0]!;
    expect('text' in identity && JSON.parse(identity.text).displayName).toBe('Hermes');
  });

  it('preserves the saved name when agent_init omits displayName', async () => {
    const result = await client.callTool({ name: 'agent_init', arguments: {} });
    expect(agent.setDisplayName).not.toHaveBeenCalled();
    const content = result.content as Array<{ type: string; text: string }>;
    expect(JSON.parse(content[0]!.text).displayName).toBe('Existing name');
  });

  it.each(['', 'a'.repeat(129), 'я'.repeat(65)])('rejects a name outside the handshake limits', async (displayName) => {
    Object.assign(agent, { isRunning: false });
    const result = await client.callTool({ name: 'agent_init', arguments: { displayName } });
    expect(result.isError).toBe(true);
    expect(agent.start).not.toHaveBeenCalled();
    expect(agent.setDisplayName).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { stateId, peerPublicKey },
    { stateId: '' },
    { stateId, limit: -1 },
    { stateId, limit: 0 },
    { stateId, limit: 1.5 },
    { stateId, limit: 501 },
  ])('rejects ambiguous or unbounded reads: %j', async (args) => {
    const result = await client.callTool({ name: 'read_messages', arguments: args });
    expect(result.isError).toBe(true);
    expect(getMessages).not.toHaveBeenCalled();
  });

  it.each([{ stateId }, { peerPublicKey, limit: 25, before: 'message-id' }])(
    'forwards a valid conversation read: %j',
    async (args) => {
      const result = await client.callTool({ name: 'read_messages', arguments: args });
      expect(result.isError).not.toBe(true);
      expect(getMessages).toHaveBeenCalledWith({
        groupId: 'stateId' in args ? stateId : undefined,
        peerPublicKey: 'peerPublicKey' in args ? peerPublicKey : undefined,
        limit: 'limit' in args ? 25 : undefined,
        before: 'before' in args ? 'message-id' : undefined,
      });
    },
  );
});
