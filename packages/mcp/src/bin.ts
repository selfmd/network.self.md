#!/usr/bin/env node
import { resolve } from 'path';
import { homedir } from 'os';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Agent } from '@networkselfmd/node';
import { createServer } from './server.js';

const dataDir = process.env.L2S_DATA_DIR || resolve(homedir(), '.networkselfmd');

const agent = new Agent({ dataDir });

// The network layer can emit transient connection errors (for example ETIMEDOUT
// from a peer stream). Without an error listener, Node treats EventEmitter
// "error" events as fatal and kills the MCP stdio process, leaving Hermes with
// ClosedResourceError for every subsequent tool call. Keep the MCP server alive
// and report the diagnostic on stderr, which is safe for stdio MCP.
agent.on('error', (err) => {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  console.error(`[networkselfmd:mcp] agent error (non-fatal): ${message}`);
});

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
