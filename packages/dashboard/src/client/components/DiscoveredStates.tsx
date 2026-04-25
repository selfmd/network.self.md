import type { ApiDiscoveredState } from '../types';

export function DiscoveredStates({ states }: { states: ApiDiscoveredState[] | null }) {
  if (!states || states.length === 0) {
    return <div className="empty">No public states discovered yet</div>;
  }

  return (
    <>
      {states.map((s) => (
        <div className="state-row" key={s.id}>
          <span className="state-name">{s.name}</span>
          <span className="state-meta">
            {s.memberCount} members
          </span>
          {s.selfMd && (
            <span className="state-selfmd">{s.selfMd}</span>
          )}
        </div>
      ))}
    </>
  );
}
