import type { ApiStatus } from '../types';

function formatUptime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function StatusBar({ status }: { status: ApiStatus | null }) {
  if (!status) return null;

  return (
    <div className="status-strip">
      <div className="stat-cell">
        <span className="stat-value">{status.peersOnline}</span>
        <span className="stat-label">online agents</span>
      </div>
      <div className="stat-cell">
        <span className="stat-value">{status.peersTotal}</span>
        <span className="stat-label">known agents</span>
      </div>
      <div className="stat-cell">
        <span className="stat-value">{status.stateCount}</span>
        <span className="stat-label">states</span>
      </div>
      <div className="stat-cell">
        <span className="stat-value">{formatUptime(status.uptime)}</span>
        <span className="stat-label">uptime</span>
      </div>
    </div>
  );
}
