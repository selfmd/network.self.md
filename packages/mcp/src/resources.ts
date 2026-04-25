import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Agent } from '@networkselfmd/node';

export function registerResources(server: McpServer, agent: Agent): void {
  server.resource(
    'agent-identity',
    'agent://identity',
    { description: 'Current agent identity information' },
    async (uri) => {
      const identity = agent.identity;
      return {
        contents: [{
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(identity ? {
            fingerprint: identity.fingerprint,
            displayName: identity.displayName,
            publicKey: Buffer.from(identity.edPublicKey).toString('base64'),
          } : null),
        }],
      };
    },
  );

  server.resource(
    'agent-states',
    'agent://states',
    { description: 'All states with member counts' },
    async (uri) => {
      const groups = agent.listGroups();
      return {
        contents: [{
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(groups.map(g => ({
            id: Buffer.from(g.groupId).toString('hex'),
            name: g.name,
            memberCount: g.memberCount,
            role: g.role,
          }))),
        }],
      };
    },
  );

  server.resource(
    'agent-peers',
    'agent://peers',
    { description: 'Known peers with online status' },
    async (uri) => {
      const peers = agent.listPeers();
      return {
        contents: [{
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(peers.map(p => ({
            publicKey: Buffer.from(p.publicKey).toString('hex'),
            fingerprint: p.fingerprint,
            displayName: p.displayName,
            online: p.online,
            lastSeen: p.lastSeen,
            trusted: p.trusted,
          }))),
        }],
      };
    },
  );

  server.resource(
    'discovered-states',
    'agent://discovered-states',
    { description: 'Public states discovered from the network' },
    async (uri) => {
      const groups = agent.listDiscoveredGroups();
      return {
        contents: [{
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(groups.map(g => ({
            id: Buffer.from(g.groupId).toString('hex'),
            name: g.name,
            selfMd: g.selfMd,
            memberCount: g.memberCount,
          }))),
        }],
      };
    },
  );

  server.resource(
    'state-messages',
    new ResourceTemplate('agent://messages/{groupId}', { list: undefined }),
    { description: 'Recent messages in a specific state' },
    async (uri, variables) => {
      const groupId = Array.isArray(variables.groupId)
        ? variables.groupId[0]
        : variables.groupId;
      const messages = agent.getMessages({ groupId: groupId as string, limit: 50 });
      return {
        contents: [{
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(messages.map(m => ({
            id: m.id,
            senderPublicKey: m.senderPublicKey
              ? Buffer.from(m.senderPublicKey).toString('hex')
              : undefined,
            content: m.content,
            timestamp: m.timestamp,
          }))),
        }],
      };
    },
  );
}
