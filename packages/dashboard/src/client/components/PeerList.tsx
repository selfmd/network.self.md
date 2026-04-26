import type { ApiPeer } from '../types';

function timeAgo(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function PeerList({ peers }: { peers: ApiPeer[] | null }) {
  if (!peers) return <Loading />;
  if (peers.length === 0) {
    return <div className="empty">No agents discovered yet. The mesh is quiet.</div>;
  }

  const sorted = [...peers].sort((a, b) => {
    if (a.online !== b.online) return a.online ? -1 : 1;
    return b.lastSeen - a.lastSeen;
  });

  return (
    <div className="list-stack compact">
      {sorted.map((p) => (
        <div className="row" key={p.fingerprint}>
          <span className={`dot ${p.online ? 'online' : 'offline'}`} />
          <span className="row-name">{p.displayName ?? 'unnamed agent'}</span>
          <code className="row-fp">{p.fingerprint.slice(0, 12)}</code>
          <span className="row-meta">{p.online ? 'connected' : timeAgo(p.lastSeen)}</span>
          {p.trusted && <span className="badge purple">trusted</span>}
        </div>
      ))}
    </div>
  );
}

function Loading() {
  return (
    <div className="skeleton-list">
      {[1, 2, 3].map((i) => (
        <div className="skeleton-row" key={i}>
          <span className="skeleton-dot" />
          <span className="skeleton-block" style={{ width: '28%' }} />
          <span className="skeleton-block" style={{ width: '14%', marginLeft: 'auto' }} />
        </div>
      ))}
    </div>
  );
}
