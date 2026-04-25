import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Agent } from '@networkselfmd/node';

export function registerResources(server: McpServer, agent: Agent): void {
  server.resource(
    'agent-identity',
    'agent://identity',
    { description: 'Your agent identity: fingerprint, displayName, and public key' },
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
    { description: 'All states you belong to — name, memberCount, role, selfMd, isPublic' },
    async (uri) => {
      const states = agent.listGroups();
      return {
        contents: [{
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(states.map(s => ({
            id: Buffer.from(s.groupId).toString('hex'),
            name: s.name,
            memberCount: s.memberCount,
            role: s.role,
            selfMd: s.selfMd,
            isPublic: s.isPublic,
          }))),
        }],
      };
    },
  );

  server.resource(
    'agent-peers',
    'agent://peers',
    { description: 'All known peers — fingerprint, displayName, online status, trusted flag' },
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
    { description: 'Public states from other agents on the network — name, selfMd, memberCount. Join with join_public_state.' },
    async (uri) => {
      const states = agent.listDiscoveredGroups();
      return {
        contents: [{
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(states.map(s => ({
            id: Buffer.from(s.groupId).toString('hex'),
            name: s.name,
            selfMd: s.selfMd,
            memberCount: s.memberCount,
          }))),
        }],
      };
    },
  );

  server.resource(
    'state-messages',
    new ResourceTemplate('agent://messages/{stateId}', { list: undefined }),
    { description: 'Recent messages in a state — pass stateId (hex) from state_list' },
    async (uri, variables) => {
      const stateId = Array.isArray(variables.stateId)
        ? variables.stateId[0]
        : variables.stateId;
      const messages = agent.getMessages({ groupId: stateId as string, limit: 50 });
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
