import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import type { Agent } from '@networkselfmd/node';

interface StatusBarProps {
  agent: Agent;
  groupId: string;
  groupName?: string;
}

export const StatusBar: React.FC<StatusBarProps> = ({ agent, groupId, groupName }) => {
  const [peerCount, setPeerCount] = useState(0);

  useEffect(() => {
    const updatePeers = () => {
      try {
        const peers = agent.listPeers();
        setPeerCount(peers.filter((p) => p.online).length);
      } catch {
        // Peer listing may fail during startup
      }
    };

    updatePeers();

    const onConnect = () => {
      updatePeers();
    };
    const onDisconnect = () => {
      updatePeers();
    };

    agent.on('peer:connected', onConnect);
    agent.on('peer:disconnected', onDisconnect);

    return () => {
      agent.off('peer:connected', onConnect);
      agent.off('peer:disconnected', onDisconnect);
    };
  }, [agent]);

  const identity = agent.identity;
  const shortFingerprint = identity.fingerprint.slice(0, 8);

  return (
    <Box borderStyle="single" paddingX={1} justifyContent="space-between">
      <Text color="cyan" bold>
        Group: {groupName || groupId.slice(0, 12)}
      </Text>
      <Text>
        <Text color="green">{peerCount} peers</Text>
        <Text color="gray"> | </Text>
        <Text color="yellow">{shortFingerprint}</Text>
      </Text>
    </Box>
  );
};
