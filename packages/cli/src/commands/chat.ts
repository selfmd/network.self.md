import { render } from 'ink';
import React from 'react';
import { Agent } from '@networkselfmd/node';
import { ChatView } from '../components/ChatView.js';
import type { AgentOptions } from '@networkselfmd/node';
import { getDataDir } from '../agent-options.js';

export async function startChat(
  groupId: string,
  secrets: Pick<AgentOptions, 'passphrase' | 'secretProvider'> = {},
): Promise<void> {
  const agent = new Agent({ dataDir: getDataDir(), ...secrets });
  await agent.start();

  const { waitUntilExit } = render(
    React.createElement(ChatView, { agent, groupId })
  );

  await waitUntilExit();
  await agent.stop();
}
