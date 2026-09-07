import React, { useState, useEffect } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import type { Agent } from '@networkselfmd/node';

interface TTYARequest {
  visitorId: string;
  content?: string;
  ipHash: string;
  timestamp: number;
  status: 'pending' | 'approved' | 'rejected';
}

interface TTYAConversation {
  id: string;
  visitorName: string;
  startedAt: number;
}

interface TTYAViewProps {
  agent: Agent;
  port: number;
  autoApprove: boolean;
  url: string;
}

export const TTYAView: React.FC<TTYAViewProps> = ({
  agent,
  port,
  autoApprove,
  url,
}) => {
  const { exit } = useApp();
  const [requests, setRequests] = useState<TTYARequest[]>([]);
  const [conversations, setConversations] = useState<TTYAConversation[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    const onRequest = (request: TTYARequest) => {
      if (request.status !== 'pending') return;
      if (autoApprove) {
        agent.approveTTYAVisitor(request.visitorId);
        setConversations((prev) => [
          ...prev,
          {
            id: request.visitorId,
            visitorName: request.visitorId,
            startedAt: Date.now(),
          },
        ]);
      } else {
        setRequests((prev) =>
          prev.some((item) => item.visitorId === request.visitorId)
            ? prev
            : [...prev, request],
        );
      }
    };

    agent.on('ttya:request', onRequest);
    for (const visitor of agent.getPendingTTYAVisitors()) {
      onRequest(visitor);
    }

    return () => {
      agent.off('ttya:request', onRequest);
    };
  }, [agent, autoApprove]);

  useInput((input, key) => {
    if (input === 'q') {
      exit();
      return;
    }

    if (requests.length === 0) return;

    if (key.upArrow) {
      setSelectedIndex((prev) => Math.max(0, prev - 1));
    }
    if (key.downArrow) {
      setSelectedIndex((prev) => Math.min(requests.length - 1, prev + 1));
    }

    // Approve with 'a'
    if (input === 'a' && requests[selectedIndex]) {
      const request = requests[selectedIndex]!;
      agent.approveTTYAVisitor(request.visitorId);
      setConversations((prev) => [
        ...prev,
        {
          id: request.visitorId,
          visitorName: request.visitorId,
          startedAt: Date.now(),
        },
      ]);
      setRequests((prev) => prev.filter((_, i) => i !== selectedIndex));
      setSelectedIndex((prev) =>
        Math.min(prev, Math.max(0, requests.length - 2)),
      );
    }

    // Reject with 'r'
    if (input === 'r' && requests[selectedIndex]) {
      const request = requests[selectedIndex]!;
      agent.rejectTTYAVisitor(request.visitorId);
      setRequests((prev) => prev.filter((_, i) => i !== selectedIndex));
      setSelectedIndex((prev) =>
        Math.min(prev, Math.max(0, requests.length - 2)),
      );
    }
  });

  return (
    <Box flexDirection="column" padding={1}>
      <Box borderStyle="single" paddingX={1}>
        <Text bold color="cyan">
          TTYA Server — port {port}
        </Text>
        <Text color="gray"> | </Text>
        <Text color={autoApprove ? 'green' : 'yellow'}>
          {autoApprove ? 'Auto-approve ON' : 'Manual approval'}
        </Text>
      </Box>
      <Text color="gray">{url}</Text>

      <Box flexDirection="column" marginTop={1}>
        <Text bold underline>
          Pending Requests ({requests.length})
        </Text>
        {requests.length === 0 ? (
          <Text color="gray">No pending requests</Text>
        ) : (
          requests.map((req, i) => (
            <Box key={req.visitorId}>
              <Text color={i === selectedIndex ? 'green' : undefined}>
                {i === selectedIndex ? '> ' : '  '}
                {req.visitorId} ({req.ipHash.slice(0, 8)}) —{' '}
                {new Date(req.timestamp).toLocaleTimeString()}
              </Text>
            </Box>
          ))
        )}
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Text bold underline>
          Active Conversations ({conversations.length})
        </Text>
        {conversations.length === 0 ? (
          <Text color="gray">No active conversations</Text>
        ) : (
          conversations.map((conv) => (
            <Box key={conv.id}>
              <Text>
                {'  '}
                <Text color="green">{conv.visitorName}</Text> — started{' '}
                {new Date(conv.startedAt).toLocaleTimeString()}
              </Text>
            </Box>
          ))
        )}
      </Box>

      <Box marginTop={1}>
        <Text color="gray">[a] approve [r] reject [↑/↓] navigate [q] quit</Text>
      </Box>
    </Box>
  );
};
