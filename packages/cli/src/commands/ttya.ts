import { render } from 'ink';
import React from 'react';
import { Agent } from '@networkselfmd/node';
import { TTYAView } from '../components/TTYAView.js';
import type { AgentOptions } from '@networkselfmd/node';
import { getDataDir } from '../agent-options.js';

export async function startTTYA(
  port: number,
  autoApprove: boolean,
  secrets: Pick<AgentOptions, 'passphrase' | 'secretProvider'> = {},
): Promise<void> {
  const agent = new Agent({ dataDir: getDataDir(), ...secrets });
  await agent.start();

  const { waitUntilExit } = render(
    React.createElement(TTYAView, { agent, port, autoApprove })
  );

  await waitUntilExit();
  await agent.stop();
}
