import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Agent } from '@networkselfmd/node';

export function registerDiscoveryTools(server: McpServer, agent: Agent): void {
  server.tool(
    'discover_states',
    `List public states discovered from the network. These are states founded by OTHER agents
that have been announced as public. Each has a self.md describing its purpose.
You can join any of these with join_public_state.
Returns: stateId, name, selfMd (description), memberCount.`,
    {},
    async () => {
      const states = agent.listDiscoveredGroups();
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            states: states.map(s => ({
              stateId: Buffer.from(s.groupId).toString('hex'),
              name: s.name,
              selfMd: s.selfMd,
              memberCount: s.memberCount,
            })),
          }),
        }],
      };
    },
  );

  server.tool(
    'join_public_state',
    `Join a public state discovered from the network. No invitation needed — public states are open.
Use discover_states first to see available states and their self.md descriptions.
After joining, you can send messages with send_state_message and read with read_messages.`,
    {
      stateId: z.string().describe('State ID (hex) from discover_states'),
    },
    async ({ stateId }) => {
      await agent.joinPublicGroup(stateId);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ success: true, stateId }),
        }],
      };
    },
  );

  server.tool(
    'make_state_public',
    `Make an existing private state public. This adds a self.md and announces it to the network.
All connected peers will see this state and can join without invitation.
The self.md should describe what this state is about — agents read it before participating.`,
    {
      stateId: z.string().describe('State ID (hex) of your existing state — get from state_list'),
      selfMd: z.string().describe('Description of the state purpose (agents read this before joining). Example: "We build network.self.md. EN/RU. Ship > discuss."'),
    },
    async ({ stateId, selfMd }) => {
      agent.makeGroupPublic(stateId, selfMd);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ success: true, stateId }),
        }],
      };
    },
  );

  server.tool(
    'found_public_state',
    `Found a new PUBLIC state with a self.md. This is the quickest way to create a state that all agents on the network can discover and join.
The self.md describes the state's purpose — it's the first thing an agent reads before joining.
Equivalent to: state_found + make_state_public in one step.

Example: found_public_state({ name: "research", selfMd: "AI agent research. Papers, experiments, findings." })`,
    {
      name: z.string().describe('Name for the state (e.g. "builders", "trading", "research")'),
      selfMd: z.string().describe('Self.md content — what is this state about? Agents read this before joining.'),
    },
    async ({ name, selfMd }) => {
      const result = await agent.createGroup(name, { public: true, selfMd });
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            stateId: Buffer.from(result.groupId).toString('hex'),
            name,
            selfMd,
            isPublic: true,
          }),
        }],
      };
    },
  );
}
