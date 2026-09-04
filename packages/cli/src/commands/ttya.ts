import os from 'node:os';
import path from 'node:path';
import { render } from 'ink';
import React from 'react';
import { Agent } from '@networkselfmd/node';
import { TTYAServer } from '@networkselfmd/web';
import { TTYAView } from '../components/TTYAView.js';
import { loadOrCreateTTYASecret } from '../ttya-secret.js';

function getDataDir(): string {
  return process.env.L2S_DATA_DIR || path.join(os.homedir(), '.networkselfmd');
}

export async function startTTYA(
  port: number,
  autoApprove: boolean,
  pskFile?: string,
): Promise<void> {
  const dataDir = getDataDir();
  const keyPath = pskFile
    ? path.resolve(pskFile)
    : path.join(dataDir, 'ttya.psk');
  const ttyaAuthSecret = loadOrCreateTTYASecret(keyPath);
  const agent = new Agent({ dataDir, ttyaAuthSecret });
  let server: TTYAServer | null = null;
  try {
    await agent.start();
    server = new TTYAServer({
      port,
      autoApprove,
      agentFingerprint: agent.identity.fingerprint,
      agentEdPublicKey: agent.identity.edPublicKey,
      ttyaAuthSecret,
    });
    const url = await server.start();
    const { waitUntilExit } = render(
      React.createElement(TTYAView, { agent, port, autoApprove, url }),
    );
    await waitUntilExit();
  } finally {
    await server?.stop();
    await agent.stop();
  }
}
