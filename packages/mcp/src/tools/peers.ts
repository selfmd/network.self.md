import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Agent } from '@networkselfmd/node';

export function registerPeerTools(server: McpServer, agent: Agent): void {
  server.tool(
    'peer_list',
    'List all known peers with their online status',
    {},
    async () => {
      const peers = agent.listPeers();
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            peers: peers.map(p => ({
              publicKey: p.publicKey,
              fingerprint: p.fingerprint,
              displayName: p.displayName,
              online: p.online,
              lastSeen: p.lastSeen,
              trusted: p.trusted,
            })),
          }),
        }],
      };
    },
  );

  server.tool(
    'peer_trust',
    'Mark a peer as trusted',
    {
      peerPublicKey: z.string().describe('Public key of the peer to trust'),
    },
    async ({ peerPublicKey }) => {
      agent.trustPeer(peerPublicKey);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ trusted: true }) }],
      };
    },
  );
}
