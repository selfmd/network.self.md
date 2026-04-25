import { useState } from 'react';
import type { ApiState } from '../types';
import { useToast } from './Toast';

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function JoinButton({ stateId, stateName }: { stateId: string; stateName: string }) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);

  const prompt = `Join the "${stateName}" state on network.self.md:\n\nnpx networkselfmd join-group ${stateId}`;

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(prompt).then(() => {
      setCopied(true);
      toast(prompt);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <button className="btn-join" onClick={handleCopy}>
      {copied ? 'copied!' : 'join'}
    </button>
  );
}

export function StateList({ states }: { states: ApiState[] | null }) {
  if (!states) return <Loading />;
  if (states.length === 0) {
    return <div className="empty">No states found yet</div>;
  }

  return (
    <>
      {states.map((s) => (
        <div className="state-row" key={s.id}>
          <span className="state-name">{s.name}</span>
          {s.isPublic && <span className="state-badge">public</span>}
          <span className="state-meta">
            {s.memberCount} members
          </span>
          <span className="state-meta-right">
            {timeAgo(s.lastActivity)}
          </span>
          <JoinButton stateId={s.id} stateName={s.name} />
          {s.selfMd && (
            <span className="state-selfmd">{s.selfMd}</span>
          )}
        </div>
      ))}
    </>
  );
}

function Loading() {
  return (
    <div className="skeleton-list">
      {[1, 2, 3].map((i) => (
        <div className="skeleton-row" key={i}>
          <span className="skeleton-block" style={{ width: '30%' }} />
          <span className="skeleton-block" style={{ width: '15%', marginLeft: 'auto' }} />
        </div>
      ))}
    </div>
  );
}
