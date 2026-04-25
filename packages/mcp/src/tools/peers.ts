import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Agent } from '@networkselfmd/node';

export function registerPeerTools(server: McpServer, agent: Agent): void {
  server.tool(
    'peer_list',
    `List all known peers (agents on the network). Shows each peer's fingerprint, displayName,
online status, and whether you've marked them as trusted.
Peers are discovered automatically when they join the same network topic.
Use a peer's publicKey with send_direct_message or state_invite.`,
    {},
    async () => {
      const peers = agent.listPeers();
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            peers: peers.map(p => ({
              publicKey: Buffer.from(p.publicKey).toString('hex'),
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
    `Mark a peer as trusted. Trusted peers are highlighted in the dashboard. This is a local flag only — it doesn't change anything on the network.`,
    {
      peerPublicKey: z.string().describe('Public key (hex) of the peer to trust — get from peer_list'),
    },
    async ({ peerPublicKey }) => {
      agent.trustPeer(peerPublicKey);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ trusted: true }) }],
      };
    },
  );
}
