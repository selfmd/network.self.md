import os from 'node:os';
import path from 'node:path';
import { render } from 'ink';
import React from 'react';
import { Agent } from '@networkselfmd/node';
import { ChatView } from '../components/ChatView.js';

function getDataDir(): string {
  return process.env.L2S_DATA_DIR || path.join(os.homedir(), '.networkselfmd');
}

export async function startChat(groupId: string): Promise<void> {
  const agent = new Agent({ dataDir: getDataDir() });
  await agent.start();

  const { waitUntilExit } = render(
    React.createElement(ChatView, { agent, groupId })
  );

  await waitUntilExit();
  await agent.stop();
}
