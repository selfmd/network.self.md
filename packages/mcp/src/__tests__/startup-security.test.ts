import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

import { mcpAgentOptions } from '../config.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe('MCP protected startup', () => {
  it('expands the home directory in the documented MCP configuration', () => {
    expect(mcpAgentOptions({ L2S_DATA_DIR: '~/.networkselfmd' }).dataDir)
      .toBe(join(homedir(), '.networkselfmd'));
    expect(mcpAgentOptions({ L2S_DATA_DIR: '~' }).dataDir).toBe(homedir());
  });

  it('passes L2S_PASSPHRASE_FILE through to Agent', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'nsmd-mcp-startup-'));
    dirs.push(dataDir);
    const secretPath = join(dataDir, 'secret');
    writeFileSync(secretPath, 'mcp-provider-passphrase\n', { mode: 0o600 });

    const options = mcpAgentOptions({
      L2S_DATA_DIR: dataDir,
      L2S_PASSPHRASE_FILE: secretPath,
      L2S_PASSPHRASE: 'obsolete-fallback-passphrase',
    });
    expect(options.dataDir).toBe(dataDir);
    expect(options.passphrase).toBeUndefined();
    expect(await options.secretProvider!()).toBe('mcp-provider-passphrase');
  });

  it('passes a direct service passphrase through to Agent options', () => {
    const options = mcpAgentOptions({ L2S_PASSPHRASE: 'mcp-direct-passphrase' });
    expect(options.passphrase).toBe('mcp-direct-passphrase');
    expect(options.secretProvider).toBeUndefined();
  });
});
