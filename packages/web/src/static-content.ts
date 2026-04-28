/**
 * Embedded static HTML for the TTYA visitor chat page.
 * Served inline to avoid file-copy issues with TypeScript compilation.
 */

function escapeHTML(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function getChatHTML(fingerprint: string): string {
  // JSON.stringify + replace </script> to prevent XSS when embedding in <script>
  const safeFingerprint = JSON.stringify(fingerprint).replace(/<\//g, '<\\/');
  const htmlFingerprint = escapeHTML(fingerprint);
  const titleFingerprint = escapeHTML(fingerprint.slice(0, 12));

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TTYA — ${titleFingerprint}</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Fira+Code:wght@300;400;500;600&display=swap');

*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

:root {
  --bg: #0b0d10;
  --panel: rgba(15, 15, 18, 0.86);
  --line: rgba(255, 255, 255, 0.075);
  --line-strong: rgba(255, 255, 255, 0.14);
  --text: rgba(248, 252, 255, 0.92);
  --muted: rgba(214, 226, 232, 0.58);
  --faint: rgba(214, 226, 232, 0.34);
  --green: #41e98d;
  --purple: #b4a0ff;
  --cyan: #00bcd4;
  --warn: #febc2e;
  --danger: #ff5f57;
  --r-lg: 14px;
  --r-md: 10px;
  --shadow: 0 24px 80px rgba(0, 0, 0, 0.45);
}

html, body {
  height: 100%;
  background:
    radial-gradient(circle at 12% 8%, rgba(65, 233, 141, 0.12), transparent 26rem),
    radial-gradient(circle at 86% 18%, rgba(180, 160, 255, 0.13), transparent 24rem),
    radial-gradient(circle at 72% 86%, rgba(0, 188, 212, 0.10), transparent 28rem),
    var(--bg);
  color: var(--text);
  font-family: 'Fira Code', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 13px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}

#app {
  max-width: 720px;
  margin: 0 auto;
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 18px 18px 12px;
  gap: 14px;
}

/* Header */
#header {
  border: 1px solid var(--line);
  background: linear-gradient(180deg, var(--panel), rgba(10, 11, 14, 0.92));
  border-radius: var(--r-lg);
  padding: 14px 16px;
  box-shadow: var(--shadow);
  display: flex;
  align-items: center;
  gap: 12px;
  flex-shrink: 0;
  position: relative;
  overflow: hidden;
}

#header::after {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: linear-gradient(180deg, rgba(255,255,255,.03), transparent 44%);
}

.brand { display: inline-flex; align-items: center; gap: 7px; text-decoration: none; letter-spacing: -0.04em; color: var(--text); }
.brand-mark { color: var(--green); border: 1px solid rgba(65,233,141,.35); padding: 2px 6px; border-radius: 999px; font-size: 12px; }
.brand b { font-weight: 600; }
.brand .ext { color: var(--muted); }

.header-sep { width: 1px; height: 20px; background: var(--line-strong); }

.agent-info { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; }
.agent-fp { color: var(--green); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

#status-pill {
  display: flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--line-strong);
  border-radius: 999px;
  padding: 4px 10px;
  font-size: 11px;
  color: var(--muted);
  flex-shrink: 0;
}

#status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--faint);
  flex-shrink: 0;
}

#status-dot.connecting { background: var(--warn); }
#status-dot.pending { background: var(--warn); animation: pulse 2s ease-in-out infinite; }
#status-dot.approved { background: var(--green); box-shadow: 0 0 12px rgba(65,233,141,.4); }
#status-dot.rejected { background: var(--danger); }
#status-dot.disconnected { background: var(--faint); }

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

/* Chat area */
#chat-card {
  flex: 1;
  border: 1px solid var(--line);
  background: linear-gradient(180deg, var(--panel), rgba(10, 11, 14, 0.92));
  border-radius: var(--r-lg);
  box-shadow: var(--shadow);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  position: relative;
  min-height: 0;
}

#chat-card::after {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: linear-gradient(180deg, rgba(255,255,255,.03), transparent 44%);
}

#messages {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  scroll-behavior: smooth;
  position: relative;
  z-index: 1;
}

#messages::-webkit-scrollbar { width: 4px; }
#messages::-webkit-scrollbar-track { background: transparent; }
#messages::-webkit-scrollbar-thumb { background: rgba(255,255,255,.1); border-radius: 2px; }

.msg {
  max-width: 80%;
  padding: 10px 14px;
  border-radius: var(--r-md);
  word-wrap: break-word;
  white-space: pre-wrap;
  font-size: 13px;
  line-height: 1.5;
  animation: fadeIn 0.2s ease-out;
}

@keyframes fadeIn {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}

.msg.visitor {
  align-self: flex-end;
  background: rgba(65, 233, 141, 0.12);
  border: 1px solid rgba(65, 233, 141, 0.2);
  color: var(--text);
}

.msg.agent {
  align-self: flex-start;
  background: rgba(180, 160, 255, 0.1);
  border: 1px solid rgba(180, 160, 255, 0.18);
  color: var(--text);
}

.msg.system {
  align-self: center;
  background: transparent;
  border: none;
  color: var(--faint);
  font-size: 11px;
  padding: 4px 0;
}

#empty-state {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--faint);
  font-size: 12px;
  text-align: center;
  padding: 40px;
  line-height: 1.7;
}

/* Input area */
#input-area {
  padding: 12px 16px;
  border-top: 1px solid var(--line);
  flex-shrink: 0;
  position: relative;
  z-index: 1;
}

#input-row {
  display: flex;
  gap: 10px;
  align-items: flex-end;
}

#msg-input {
  flex: 1;
  padding: 10px 14px;
  background: rgba(255,255,255,.035);
  border: 1px solid var(--line-strong);
  border-radius: var(--r-md);
  color: var(--text);
  font-family: inherit;
  font-size: 13px;
  line-height: 1.45;
  resize: none;
  outline: none;
  max-height: 120px;
  transition: border-color 0.15s;
}

#msg-input:focus { border-color: rgba(65, 233, 141, 0.35); }
#msg-input::placeholder { color: var(--faint); }

#send-btn {
  padding: 9px 16px;
  border-radius: 999px;
  border: 1px solid rgba(65, 233, 141, 0.45);
  background: var(--green);
  color: var(--bg);
  cursor: pointer;
  font-family: inherit;
  font-size: 12px;
  font-weight: 500;
  flex-shrink: 0;
  transition: transform 0.16s ease, filter 0.16s ease, opacity 0.16s ease;
}

#send-btn:hover:not(:disabled) { transform: translateY(-1px); filter: brightness(1.08); }
#send-btn:disabled { opacity: 0.3; cursor: default; }

/* Footer */
#footer {
  text-align: center;
  font-size: 10px;
  color: var(--faint);
  flex-shrink: 0;
}

#footer a { color: var(--muted); text-decoration: none; }
#footer a:hover { color: var(--green); }

@media (max-width: 600px) {
  #app { padding: 10px 10px 8px; gap: 10px; }
  #header { flex-wrap: wrap; padding: 10px 12px; }
  .agent-fp { font-size: 11px; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; }
}
</style>
</head>
<body>
<div id="app">
  <div id="header">
    <span class="brand">
      <span class="brand-mark">self</span><b>network</b><span class="ext">.md</span>
    </span>
    <span class="header-sep"></span>
    <span class="agent-info">
      <span class="agent-fp" title="${htmlFingerprint}">${htmlFingerprint}</span>
    </span>
    <span id="status-pill">
      <span id="status-dot" class="connecting"></span>
      <span id="status-text">connecting</span>
    </span>
  </div>

  <div id="chat-card">
    <div id="messages">
      <div id="empty-state">send a message to start the conversation.<br>the agent will be notified.</div>
    </div>

    <div id="input-area">
      <div id="input-row">
        <textarea id="msg-input" rows="1" placeholder="type a message..." autocomplete="off"></textarea>
        <button id="send-btn" disabled>send</button>
      </div>
    </div>
  </div>

  <div id="footer">
    <a href="https://github.com/selfmd/network.self.md" target="_blank" rel="noopener">ttya</a> — encrypted p2p, relay stores nothing
  </div>
</div>

<script>
(function() {
  var fp = ${safeFingerprint};
  var ws = null;
  var status = 'connecting';
  var hasMessages = false;

  var messagesEl = document.getElementById('messages');
  var emptyEl = document.getElementById('empty-state');
  var inputEl = document.getElementById('msg-input');
  var sendBtn = document.getElementById('send-btn');
  var statusDot = document.getElementById('status-dot');
  var statusText = document.getElementById('status-text');

  function setStatus(s, text) {
    status = s;
    statusDot.className = s;
    statusText.textContent = text || s;
    sendBtn.disabled = (s === 'rejected' || s === 'disconnected');
  }

  function addMessage(content, type) {
    if (!hasMessages) {
      emptyEl.style.display = 'none';
      hasMessages = true;
    }
    var el = document.createElement('div');
    el.className = 'msg ' + type;
    el.textContent = content;
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function connect() {
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + location.host + '/ws/' + fp);

    ws.onopen = function() {
      setStatus('approved', 'connected');
      sendBtn.disabled = false;
    };

    ws.onmessage = function(ev) {
      try {
        var msg = JSON.parse(ev.data);
        if (msg.type === 'status') {
          if (msg.status === 'pending') {
            setStatus('pending', 'waiting for approval');
          } else if (msg.status === 'approved') {
            setStatus('approved', 'connected');
            sendBtn.disabled = false;
          } else if (msg.status === 'rejected') {
            setStatus('rejected', 'declined');
            sendBtn.disabled = true;
          }
        } else if (msg.type === 'message') {
          addMessage(msg.content, 'agent');
        } else if (msg.type === 'error') {
          addMessage(msg.message, 'system');
        }
      } catch(e) {}
    };

    ws.onclose = function() {
      setStatus('disconnected', 'disconnected');
      sendBtn.disabled = true;
      setTimeout(function() {
        if (status !== 'rejected') {
          setStatus('connecting', 'reconnecting');
          connect();
        }
      }, 3000);
    };

    ws.onerror = function() {};
  }

  function send() {
    var content = inputEl.value.trim();
    if (!content || !ws || ws.readyState !== 1) return;
    if (status === 'rejected') return;

    ws.send(JSON.stringify({ type: 'message', content: content }));
    addMessage(content, 'visitor');
    inputEl.value = '';
    inputEl.style.height = 'auto';
  }

  sendBtn.addEventListener('click', send);

  inputEl.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  inputEl.addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 120) + 'px';
  });

  connect();
})();
</script>
</body>
</html>`;
}
