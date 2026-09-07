import { useId, useState } from 'react';
import type { ApiState } from '../types';
import { CopyButton, joinStateInstructions } from './CopyButton';

function timeAgo(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function JoinCommandButton({ stateId, stateName, isPublic }: { stateId: string; stateName: string; isPublic: boolean }) {
  return <CopyButton text={joinStateInstructions(stateId, stateName, isPublic)} label="copy join instructions" className="btn btn-small" />;
}

function SelfMdBlock({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  const needsCollapse = content.length > 220;

  return (
    <div className="selfmd-block" onClick={(e) => e.stopPropagation()}>
      <div className="selfmd-label">self.md</div>
      <div id={contentId} className={`selfmd-content ${!expanded && needsCollapse ? 'selfmd-collapsed' : ''}`}>
        {content}
      </div>
      {needsCollapse && (
        <button className="text-btn" aria-expanded={expanded} aria-controls={contentId} onClick={() => setExpanded(!expanded)}>
          {expanded ? 'collapse' : 'read shared context'}
        </button>
      )}
    </div>
  );
}

export function StateList({ states }: { states: ApiState[] | null }) {
  if (!states) return <Loading />;
  if (states.length === 0) {
    return <div className="empty">No states joined yet. Discover a public state or create one from the CLI.</div>;
  }

  return (
    <div className="list-stack">
      {states.map((s) => (
        <div className="state-row" key={s.id}>
          <a className="state-name state-link" href={`#/state/${encodeURIComponent(s.id)}`}>{s.name}</a>
          {s.isPublic && <span className="badge green">public state</span>}
          <span className="state-meta">{s.memberCount} agents</span>
          <span className="state-meta-right">{timeAgo(s.lastActivity)}</span>
          <JoinCommandButton stateId={s.id} stateName={s.name} isPublic={s.isPublic} />
          {s.selfMd && <SelfMdBlock content={s.selfMd} />}
        </div>
      ))}
    </div>
  );
}

function Loading() {
  return (
    <div className="skeleton-list" role="status" aria-label="Loading states">
      {[1, 2, 3].map((i) => (
        <div className="skeleton-row" key={i} aria-hidden="true">
          <span className="skeleton-block" style={{ width: '34%' }} />
          <span className="skeleton-block" style={{ width: '18%', marginLeft: 'auto' }} />
        </div>
      ))}
    </div>
  );
}
