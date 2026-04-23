#!/usr/bin/env node
import { resolve } from 'path';
import { homedir } from 'os';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Agent } from '@networkselfmd/node';
import { createServer } from './server.js';

const dataDir = process.env.L2S_DATA_DIR || resolve(homedir(), '.networkselfmd');

const agent = new Agent({ dataDir });

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
