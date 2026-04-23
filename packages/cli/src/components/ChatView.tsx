import React, { useState, useEffect, useCallback } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import TextInput from 'ink-text-input';
import type { Agent } from '@networkselfmd/node';
import { StatusBar } from './StatusBar.js';

interface ChatMessage {
  id: string;
  sender: string;
  content: string;
  timestamp: number;
}

interface ChatViewProps {
  agent: Agent;
  groupId: string;
}

function groupIdHex(groupId: Uint8Array): string {
  return Buffer.from(groupId).toString('hex');
}

export const ChatView: React.FC<ChatViewProps> = ({ agent, groupId }) => {
  const { exit } = useApp();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [groupName, setGroupName] = useState<string>('');
  const [memberCount, setMemberCount] = useState<number>(0);
  const [scrollOffset, setScrollOffset] = useState(0);

  const maxVisibleMessages = 20;

  // Load initial messages and group info
  useEffect(() => {
    const load = () => {
      try {
        const groups = agent.listGroups();
        const group = groups.find((g) => groupIdHex(g.groupId) === groupId);
        if (group) {
          setGroupName(group.name);
          setMemberCount(group.memberCount ?? 0);
        }
      } catch {
        // Group info may not be available yet
      }

      try {
        const history = agent.getMessages({ groupId, limit: 50 });
        setMessages(
          history.map((m) => ({
            id: m.id,
            sender: m.senderPublicKey
              ? Buffer.from(m.senderPublicKey).toString('hex').slice(0, 8)
              : 'unknown',
            content: m.content,
            timestamp: m.timestamp,
          }))
        );
      } catch {
        // Messages may not be available yet
      }
    };

    load();
  }, [agent, groupId]);

  // Listen for new messages
  useEffect(() => {
    const onMessage = (msg: { groupId?: Uint8Array; senderFingerprint?: string; content: string; timestamp: number }) => {
      const msgGroupId = msg.groupId ? groupIdHex(msg.groupId) : undefined;
      if (msgGroupId === groupId) {
        setMessages((prev) => [
          ...prev,
          {
            id: `msg-${Date.now()}-${Math.random()}`,
            sender: msg.senderFingerprint?.slice(0, 8) ?? 'unknown',
            content: msg.content,
            timestamp: msg.timestamp,
          },
        ]);
        setScrollOffset(0); // Auto-scroll to bottom on new message
      }
    };

    agent.on('group:message', onMessage);
    return () => {
      agent.off('group:message', onMessage);
    };
  }, [agent, groupId]);

  // Handle scroll
  useInput((_input, key) => {
    if (key.upArrow) {
      setScrollOffset((prev) => Math.min(prev + 1, Math.max(0, messages.length - maxVisibleMessages)));
    }
    if (key.downArrow) {
      setScrollOffset((prev) => Math.max(0, prev - 1));
    }
  });

  const handleSubmit = useCallback(
    async (value: string) => {
      const trimmed = value.trim();
      if (!trimmed) return;

      setInput('');

      // Handle slash commands
      if (trimmed === '/quit') {
        exit();
        return;
      }

      if (trimmed === '/members') {
        try {
          const groups = agent.listGroups();
          const group = groups.find((g) => groupIdHex(g.groupId) === groupId);
          const info = group
            ? `Group "${group.name}" — ${group.memberCount ?? '?'} members`
            : `Group ${groupId}`;

          setMessages((prev) => [
            ...prev,
            {
              id: `system-${Date.now()}`,
              sender: 'system',
              content: info,
              timestamp: Date.now(),
            },
          ]);
        } catch {
          // ignore
        }
        return;
      }

      if (trimmed === '/groups') {
        try {
          const groups = agent.listGroups();
          const list = groups
            .map((g) => `  ${groupIdHex(g.groupId).slice(0, 12)}  ${g.name}`)
            .join('\n');

          setMessages((prev) => [
            ...prev,
            {
              id: `system-${Date.now()}`,
              sender: 'system',
              content: `Groups:\n${list}`,
              timestamp: Date.now(),
            },
          ]);
        } catch {
          // ignore
        }
        return;
      }

      // Send message
      try {
        await agent.sendGroupMessage(groupId, trimmed);
      } catch {
        setMessages((prev) => [
          ...prev,
          {
            id: `error-${Date.now()}`,
            sender: 'system',
            content: 'Failed to send message',
            timestamp: Date.now(),
          },
        ]);
      }
    },
    [agent, groupId, exit]
  );

  const formatTime = (ts: number): string => {
    const d = new Date(ts);
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
  };

  // Compute visible messages with scroll
  const start = Math.max(0, messages.length - maxVisibleMessages - scrollOffset);
  const end = messages.length - scrollOffset;
  const visibleMessages = messages.slice(Math.max(0, start), Math.max(0, end));

  return (
    <Box flexDirection="column" height={maxVisibleMessages + 6}>
      <StatusBar
        agent={agent}
        groupId={groupId}
        groupName={groupName ? `${groupName} (${memberCount} members)` : undefined}
      />

      <Box flexDirection="column" flexGrow={1} paddingX={1}>
        {visibleMessages.map((msg) => (
          <Box key={msg.id}>
            <Text color="gray">[{formatTime(msg.timestamp)}] </Text>
            <Text color={msg.sender === 'system' ? 'yellow' : msg.sender === 'you' ? 'green' : 'cyan'} bold>
              {msg.sender}
            </Text>
            <Text>: {msg.content}</Text>
          </Box>
        ))}
        {messages.length === 0 && (
          <Text color="gray">No messages yet. Type a message below to get started.</Text>
        )}
      </Box>

      <Box borderStyle="single" paddingX={1}>
        <Text color="green">&gt; </Text>
        <TextInput
          value={input}
          onChange={setInput}
          onSubmit={handleSubmit}
          placeholder="type message here... (/quit to exit)"
        />
      </Box>
    </Box>
  );
};
