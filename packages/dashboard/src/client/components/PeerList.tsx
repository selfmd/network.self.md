import type { ApiPeer } from '../types';

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function PeerList({ peers }: { peers: ApiPeer[] | null }) {
  if (!peers || peers.length === 0) {
    return <div className="empty">No peers discovered yet</div>;
  }

  const sorted = [...peers].sort((a, b) => {
    if (a.online !== b.online) return a.online ? -1 : 1;
    return b.lastSeen - a.lastSeen;
  });

  return (
    <>
      {sorted.map((p) => (
        <div className="row" key={p.fingerprint}>
          <span className={`dot ${p.online ? 'online' : 'offline'}`} />
          <span className="row-name">{p.displayName ?? 'unnamed'}</span>
          <span className="row-fp">({p.fingerprint.slice(0, 8)})</span>
          <span className="row-meta">
            {p.online ? 'connected' : timeAgo(p.lastSeen)}
          </span>
        </div>
      ))}
    </>
  );
}
