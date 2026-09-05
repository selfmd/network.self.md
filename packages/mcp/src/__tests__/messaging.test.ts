import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Agent } from '@networkselfmd/node';
import { createServer } from '../server.js';

const stateId = 'ab'.repeat(32);
const peerPublicKey = 'cd'.repeat(32);

describe('MCP message reads over the protocol', () => {
  let client: Client;
  let server: McpServer;
  const getMessages = vi.fn(() => []);

  beforeEach(async () => {
    getMessages.mockClear();
    server = createServer({
      getMessages,
      isRunning: true,
      identity: { fingerprint: 'test-agent', edPublicKey: Buffer.from(peerPublicKey, 'hex') },
    } as unknown as Agent);
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
