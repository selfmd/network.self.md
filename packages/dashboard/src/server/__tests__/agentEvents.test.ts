import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { attachAgentLogging } from '../agentEvents.js';

describe('attachAgentLogging', () => {
  it('keeps expected peer timeouts from crashing the dashboard process', () => {
    const agent = new EventEmitter();
    const warnings: string[] = [];

    attachAgentLogging(agent, {
      log: () => undefined,
      warn: (message?: any) => {
        warnings.push(String(message));
      },
    });

    const timeout = Object.assign(new Error('connection timed out'), { code: 'ETIMEDOUT' });

    expect(() => agent.emit('error', timeout)).not.toThrow();
    expect(warnings).toEqual(['Network warning ETIMEDOUT: connection timed out']);
  });
});
