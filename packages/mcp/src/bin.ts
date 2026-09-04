#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Agent } from '@networkselfmd/node';
import { createServer } from './server.js';
import { mcpAgentOptions } from './config.js';

const agent = new Agent(mcpAgentOptions());

const server = createServer(agent);

async function main() {
  await agent.start();

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('Failed to start MCP server:', err);
  process.exit(1);
});
