import type { ApiActivity } from '../types';

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function ActivityFeed({ activity }: { activity: ApiActivity[] | null }) {
  if (!activity || activity.length === 0) {
    return <div className="empty">No activity yet</div>;
  }

  return (
    <>
      {activity.slice(0, 20).map((a, i) => (
        <div className="row" key={`${a.timestamp}-${i}`}>
          <span className="activity-time">{formatTime(a.timestamp)}</span>
          <span className="activity-actor">{a.actorName ?? a.actor?.slice(0, 8) ?? '?'}</span>
          <span className="activity-detail">
            {a.type === 'message' && a.target ? `\u2192 ${a.target}: message` : a.type}
          </span>
        </div>
      ))}
    </>
  );
}
