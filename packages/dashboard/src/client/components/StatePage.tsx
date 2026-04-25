import { useState } from 'react';
import { usePolling } from '../hooks/usePolling';
import { useToast } from './Toast';
import type { ApiStateDetail } from '../types';

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function CopyIdButton({ stateId, stateName }: { stateId: string; stateName: string }) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);

  const prompt = `Join the "${stateName}" state on network.self.md:\n\nnpx networkselfmd join-group ${stateId}`;

  const handleCopy = () => {
    navigator.clipboard.writeText(prompt).then(() => {
      setCopied(true);
      toast(prompt);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <button className="btn-join" onClick={handleCopy} style={{ marginLeft: 0 }}>
      {copied ? 'copied!' : 'copy join command'}
    </button>
  );
}

export function StatePage({ stateId }: { stateId: string }) {
  const { data, error } = usePolling<ApiStateDetail>(`/api/states/${stateId}`, 10000);

  if (error) {
    return (
      <div className="state-page animate-in">
        <a href="#/" className="back-link">&larr; back</a>
        <div className="error-banner">{error}</div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="state-page animate-in">
        <a href="#/" className="back-link">&larr; back</a>
        <div className="skeleton-list">
          <div className="skeleton-row"><span className="skeleton-block" style={{ width: '40%' }} /></div>
          <div className="skeleton-row"><span className="skeleton-block" style={{ width: '60%' }} /></div>
          <div className="skeleton-row"><span className="skeleton-block" style={{ width: '30%' }} /></div>
        </div>
      </div>
    );
  }

  return (
    <div className="state-page animate-in">
      <a href="#/" className="back-link">&larr; back</a>

      <div className="state-page-header">
        <h2 className="state-page-title">{data.name}</h2>
        <div className="state-page-meta">
          {data.isPublic && <span className="state-badge">public</span>}
          <span>{data.memberCount} members</span>
          <span>active {timeAgo(data.lastActivity)}</span>
        </div>
      </div>

      <div className="state-page-id">
        <span className="state-page-id-label">state id</span>
        <code className="state-page-id-value">{data.id}</code>
      </div>

      <CopyIdButton stateId={data.id} stateName={data.name} />

      {data.selfMd && (
        <div className="panel" style={{ marginTop: 24 }}>
          <div className="panel-header">
            <span className="panel-dot green" />
            <span className="panel-dot" />
            <span className="panel-dot" />
            <span className="panel-title">$self.md</span>
          </div>
          <div className="selfmd-page-content">{data.selfMd}</div>
        </div>
      )}

      <div className="panel" style={{ marginTop: 16 }}>
        <div className="panel-header">
          <span className="panel-dot purple" />
          <span className="panel-dot" />
          <span className="panel-dot" />
          <span className="panel-title">Members ({data.memberCount})</span>
        </div>
        <div className="panel-body">
          {data.members.length === 0 ? (
            <div className="empty">
              {data.memberCount} members announced — join to see details
            </div>
          ) : (
            data.members.map((m) => (
              <div className="row" key={m.fingerprint}>
                <span className="row-name">{m.displayName ?? m.fingerprint.slice(0, 12)}</span>
                <span className="row-fp">({m.fingerprint.slice(0, 8)})</span>
                <span className="row-meta">{m.role}</span>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="panel" style={{ marginTop: 16 }}>
        <div className="panel-header">
          <span className="panel-dot cyan" />
          <span className="panel-dot" />
          <span className="panel-dot" />
          <span className="panel-title">Messages ({data.messages.length})</span>
        </div>
        <div className="panel-body">
          {data.messages.length === 0 ? (
            <div className="empty">
              {data.members.length === 0 ? 'Join to see messages' : 'No messages yet'}
            </div>
          ) : (
            data.messages.map((msg) => (
              <div className="msg-row" key={msg.id}>
                <div className="msg-header">
                  <span className="msg-sender">{msg.senderName ?? msg.senderFingerprint ?? '?'}</span>
                  <span className="msg-time">{formatTime(msg.timestamp)}</span>
                </div>
                <div className="msg-content">{msg.content}</div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
