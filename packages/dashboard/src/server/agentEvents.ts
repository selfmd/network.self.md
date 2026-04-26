interface AgentEventEmitter {
  on(event: string | symbol, listener: (...args: any[]) => void): unknown;
}

type Logger = Pick<Console, 'log' | 'warn'>;

function messageFor(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function codeFor(err: unknown): string {
  if (!err || typeof err !== 'object' || !('code' in err)) return '';
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && code.length > 0 ? ` ${code}` : '';
}

export function attachAgentLogging(agent: AgentEventEmitter, logger: Logger = console): void {
  // P2P links can fail during normal churn. Without an error listener, Node treats
  // EventEmitter 'error' as fatal and kills the dashboard on a single peer timeout.
  agent.on('error', (err: unknown) => {
    logger.warn(`Network warning${codeFor(err)}: ${messageFor(err)}`);
  });

  agent.on('peer:connected', (info: any) => {
    logger.log(`Peer connected: ${info.displayName ?? info.fingerprint}`);
  });

  agent.on('peer:disconnected', (info: any) => {
    logger.log(`Peer disconnected: ${info.fingerprint}`);
  });

  agent.on('network:announce', (data: any) => {
    logger.log(`Received announce from ${data.peerFingerprint}: ${data.groups.length} states`);
  });
}
