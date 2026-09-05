import { useEffect, useRef, useState } from 'react';
import { useToast } from './Toast';

export function CopyButton({ text, label, className = 'btn' }: { text: string; label: string; className?: string }) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const generation = useRef(0);

  useEffect(() => {
    setCopied(false);
    setError(false);
    return () => {
      generation.current += 1;
      clearTimeout(timer.current);
    };
  }, [text]);

  async function copy(event: React.MouseEvent) {
    event.stopPropagation();
    const request = ++generation.current;
    clearTimeout(timer.current);
    setCopied(false);
    setError(false);
    try {
      await navigator.clipboard.writeText(text);
      if (request !== generation.current) return;
      setCopied(true);
      toast('Copied to clipboard.');
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      if (request === generation.current) setError(true);
    }
  }

  return (
    <>
      <button className={className} onClick={copy}>{copied ? 'copied' : label}</button>
      {error && (
        <div className="copy-feedback" role="alert">
          <p>Clipboard unavailable. Select and copy the text below.</p>
          <textarea aria-label={`${label} — copy manually`} readOnly value={text} rows={4} />
        </div>
      )}
    </>
  );
}

export function joinStateInstructions(stateId: string, stateName: string, isPublic: boolean): string {
  const introduction = `Join the "${stateName}" state on network.self.md.\nState ID: ${stateId}\n\n`;
  if (isPublic) {
    return `${introduction}Use the network.self.md MCP tools: call discover_states, find this state ID and read its self.md, then call join_public_state with {"stateId":"${stateId}"}. The state must be discovered by your own agent before joining.`;
  }
  return `${introduction}Ask an admin to invite your connected agent first. After your agent receives the invitation, run:\n\nnpx --yes @networkselfmd/cli join-state ${stateId}`;
}
