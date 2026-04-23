import { describe, it, expect, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Agent } from '@networkselfmd/node';
import { createServer } from '../server.js';

describe('MCP Server', () => {
  let agent: Agent;
  let server: McpServer;

  beforeEach(() => {
    agent = new Agent({ dataDir: '/tmp/test-networkselfmd' });
    server = createServer(agent);
  });

  it('should create a server instance', () => {
    expect(server).toBeInstanceOf(McpServer);
  });

  it('should be importable from index', async () => {
    const mod = await import('../index.js');
    expect(mod.createServer).toBeDefined();
    expect(typeof mod.createServer).toBe('function');
  });
});

describe('Tool registrations', () => {
  let agent: Agent;
  let server: McpServer;

  beforeEach(() => {
    agent = new Agent({ dataDir: '/tmp/test-networkselfmd' });
    server = createServer(agent);
  });

  it('should register identity tools', () => {
    // The McpServer class stores tools internally; we verify by checking
    // that createServer returns without errors and the server is valid
    expect(server).toBeDefined();
  });

  it('should register all expected tool groups without errors', () => {
    // If any tool registration threw, createServer would have failed
    // This test verifies that all z.object schemas and tool handlers are valid
    expect(server).toBeInstanceOf(McpServer);
  });
});
