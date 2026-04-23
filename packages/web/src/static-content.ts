/**
 * Embedded static HTML for the TTYA visitor chat page.
 * Served inline to avoid file-copy issues with TypeScript compilation.
 */

export function getChatHTML(fingerprint: string): string {
  // JSON.stringify + replace </script> to prevent XSS when embedding in <script>
  const safeFingerprint = JSON.stringify(fingerprint).replace(/<\//g, '<\\/');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TTYA</title>
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

html, body {
  height: 100%;
  background: #0a0a0a;
  color: #e0e0e0;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  font-size: 14px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}

#app {
  max-width: 640px;
  margin: 0 auto;
  height: 100%;
  display: flex;
  flex-direction: column;
  position: relative;
}

/* Status bar */
#status-bar {
  padding: 12px 16px;
  text-align: center;
  font-size: 12px;
  letter-spacing: 0.03em;
  border-bottom: 1px solid #1a1a1a;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}

#status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #555;
  flex-shrink: 0;
}

#status-dot.connecting { background: #b08030; }
#status-dot.pending { background: #b08030; animation: pulse 2s ease-in-out infinite; }
#status-dot.approved { background: #30a050; }
#status-dot.rejected { background: #a03030; }
#status-dot.disconnected { background: #555; }

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

#status-text {
  color: #888;
}

/* Messages area */
#messages {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  scroll-behavior: smooth;
}

#messages::-webkit-scrollbar { width: 4px; }
#messages::-webkit-scrollbar-track { background: transparent; }
#messages::-webkit-scrollbar-thumb { background: #222; border-radius: 2px; }

.msg {
  max-width: 85%;
  padding: 10px 14px;
  border-radius: 16px;
  word-wrap: break-word;
  white-space: pre-wrap;
  font-size: 14px;
  line-height: 1.45;
  animation: fadeIn 0.15s ease-out;
}

@keyframes fadeIn {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}

.msg.visitor {
  align-self: flex-end;
  background: #1a3a5c;
  color: #d8e8f8;
  border-bottom-right-radius: 4px;
}

.msg.agent {
  align-self: flex-start;
  background: #1a1a2e;
  color: #d0d0e8;
  border-bottom-left-radius: 4px;
}

.msg.system {
  align-self: center;
  background: transparent;
  color: #555;
  font-size: 12px;
  padding: 4px 0;
}

/* Empty state */
#empty-state {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #333;
  font-size: 13px;
  text-align: center;
  padding: 40px;
  line-height: 1.6;
}

/* Input area */
#input-area {
  padding: 12px 16px;
  border-top: 1px solid #1a1a1a;
  flex-shrink: 0;
  background: #0a0a0a;
}

#input-row {
  display: flex;
  gap: 8px;
  align-items: flex-end;
}

#msg-input {
  flex: 1;
  padding: 10px 14px;
  background: #111;
  border: 1px solid #222;
  border-radius: 20px;
  color: #e0e0e0;
  font-family: inherit;
  font-size: 14px;
  line-height: 1.4;
  resize: none;
  outline: none;
  max-height: 120px;
  transition: border-color 0.15s;
}

#msg-input:focus {
  border-color: #334;
}

#msg-input::placeholder {
  color: #444;
}

#send-btn {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: none;
  background: #1a3a5c;
  color: #d8e8f8;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: background 0.15s, opacity 0.15s;
}

#send-btn:hover { background: #244a6c; }
#send-btn:disabled { opacity: 0.3; cursor: default; }

#send-btn svg {
  width: 16px;
  height: 16px;
}

/* Footer */
#footer {
  padding: 8px 16px;
  text-align: center;
  font-size: 10px;
  color: #282828;
  flex-shrink: 0;
}
</style>
</head>
<body>
<div id="app">
  <div id="status-bar">
    <span id="status-dot" class="connecting"></span>
    <span id="status-text">Connecting...</span>
  </div>

  <div id="messages">
    <div id="empty-state">Send a message to start the conversation.</div>
  </div>

  <div id="input-area">
    <div id="input-row">
      <textarea id="msg-input" rows="1" placeholder="Type a message..." autocomplete="off"></textarea>
      <button id="send-btn" disabled aria-label="Send">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="22" y1="2" x2="11" y2="13"></line>
          <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
        </svg>
      </button>
    </div>
  </div>

  <div id="footer">ttya</div>
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
      setStatus('approved', 'Connected');
      sendBtn.disabled = false;
    };

    ws.onmessage = function(ev) {
      try {
        var msg = JSON.parse(ev.data);
        if (msg.type === 'status') {
          if (msg.status === 'pending') {
            setStatus('pending', 'Waiting for approval...');
          } else if (msg.status === 'approved') {
            setStatus('approved', 'Connected');
            sendBtn.disabled = false;
          } else if (msg.status === 'rejected') {
            setStatus('rejected', 'Request declined');
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
      setStatus('disconnected', 'Disconnected');
      sendBtn.disabled = true;
      // Reconnect after a delay
      setTimeout(function() {
        if (status !== 'rejected') {
          setStatus('connecting', 'Reconnecting...');
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

  // Auto-resize textarea
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
