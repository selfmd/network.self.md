import os from 'node:os';
import path from 'node:path';
import { render } from 'ink';
import React from 'react';
import { Agent } from '@networkselfmd/node';
import { TTYAView } from '../components/TTYAView.js';

function getDataDir(): string {
  return process.env.L2S_DATA_DIR || path.join(os.homedir(), '.networkselfmd');
}

export async function startTTYA(port: number, autoApprove: boolean): Promise<void> {
  const agent = new Agent({ dataDir: getDataDir() });
  await agent.start();

  const { waitUntilExit } = render(
    React.createElement(TTYAView, { agent, port, autoApprove })
  );

  await waitUntilExit();
  await agent.stop();
}
