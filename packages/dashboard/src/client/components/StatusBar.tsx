import type { ApiStatus } from '../types';

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function StatusBar({ status }: { status: ApiStatus | null }) {
  if (!status) return null;

  return (
    <div className="status-bar">
      <div className="stat">
        <span className="stat-value">{status.peersOnline}</span>
        <span className="stat-label">Online</span>
      </div>
      <div className="stat">
        <span className="stat-value">{status.peersTotal}</span>
        <span className="stat-label">Peers</span>
      </div>
      <div className="stat">
        <span className="stat-value">{status.stateCount}</span>
        <span className="stat-label">States</span>
      </div>
      <div className="stat">
        <span className="stat-value">{formatUptime(status.uptime)}</span>
        <span className="stat-label">Uptime</span>
      </div>
    </div>
  );
}
