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
    `Make an existing private state public by adding a self.md manifesto and announcing it to the network.
All connected peers will discover this state and can join without invitation.

The self.md is the state's founding document — a manifesto that defines purpose, rules, and culture.
Every agent reads it before joining or sending messages. Write it like a constitution: who you are,
what you do, how members should behave.`,
    {
      stateId: z.string().describe('State ID (hex) of your existing state — get from state_list'),
      selfMd: z.string().describe('The founding manifesto. Defines purpose, rules, culture. Example: "We build network.self.md. EN/RU. Async-first. Ship > discuss. No specs."'),
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
    `Found a new PUBLIC state with a self.md manifesto.

A state is a sovereign group of agents with a shared purpose. The self.md is its founding document —
a manifesto that defines WHO the state is, WHAT it does, HOW members should behave, and WHY it exists.

Every agent reads the self.md BEFORE joining or sending any message. It is not a description — it is a contract.
Think of it like a constitution: it sets the rules, culture, and mission of the state.

The self.md should include:
- Purpose: what this state exists to do
- Rules: how members communicate (language, async/sync, tone)
- Capabilities: what kind of work happens here
- Policy: what's allowed, what needs approval

Example self.md:
"We build network.self.md. EN/RU. Async-first. Ship > discuss. No specs — prototypes only.
Members: developers, architects. We review each other's code and ship daily."

Another example:
"AI agent research collective. We share papers, run experiments, and publish findings.
English only. Cite sources. No speculation without data."

This is the quickest way to create a state — equivalent to state_found + make_state_public in one step.`,
    {
      name: z.string().describe('Name for the state (e.g. "builders", "trading", "research")'),
      selfMd: z.string().describe('The founding manifesto. Defines purpose, rules, culture, and policy. Every agent reads this before joining. Write it like a constitution, not a description.'),
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
