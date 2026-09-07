/**
 * Embedded static HTML for the TTYA visitor chat page.
 * Served inline to avoid file-copy issues with TypeScript compilation.
 */

function escapeHTML(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function getChatHTML(
  fingerprint: string,
  nonces?: { script: string; style: string },
): string {
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
<style${nonces ? ` nonce="${escapeHTML(nonces.style)}"` : ''}>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
:root {
  --paper: #f8f6f0;
  --ink: #0c0d0e;
  --pink: #ff1484;
  --warm: #ebe7dd;
  --line: #c8c5bd;
  --muted: #66655f;
  --body: Arial, Helvetica, sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}
html, body { min-height: 100%; background: var(--paper); color: var(--ink); font: 14px/1.6 var(--body); -webkit-font-smoothing: antialiased; }
::selection { background: var(--pink); color: var(--ink); }
a { color: inherit; text-underline-offset: 4px; }
button, textarea { font: inherit; border-radius: 2px; }
a:focus-visible, button:focus-visible, textarea:focus-visible { outline: 3px solid var(--pink); outline-offset: 4px; }
#app { width: 100%; max-width: 1080px; margin: 0 auto; height: 100dvh; min-height: 480px; display: flex; flex-direction: column; padding: 28px 36px max(20px, env(safe-area-inset-bottom)); gap: 22px; }
#header { display: flex; flex-wrap: wrap; align-items: center; gap: 16px; flex-shrink: 0; padding: 0 0 22px; border-bottom: 1px solid var(--ink); }
.brand { display: inline-flex; align-items: center; gap: 10px; text-decoration: none; white-space: nowrap; }
.brand-mark { padding: 2px 6px; background: var(--ink); color: var(--pink); box-shadow: 2px 2px 0 var(--pink); font: 700 13px/1.7 var(--mono); }
.brand b { font: 900 25px/1.1 var(--body); }
.brand .ext { color: var(--pink); }
.header-sep { width: 1px; height: 25px; background: var(--line); }
.agent-info { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 70px; }
.agent-fp { color: var(--muted); font: 11px/1.6 var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#status-pill { display: flex; align-items: center; gap: 8px; border: 1px solid var(--ink); padding: 7px 10px; font: 10px/1.5 var(--mono); max-width: 100%; }
#status-dot { width: 7px; height: 7px; background: var(--muted); flex-shrink: 0; }
#status-dot.connecting, #status-dot.pending { background: var(--pink); }
#status-dot.approved { background: var(--ink); }
#status-dot.rejected { background: var(--pink); }
#status-dot.disconnected { background: var(--muted); }
#chat-card { flex: 1; display: flex; flex-direction: column; min-height: 0; border: 1px solid var(--ink); background: var(--paper); box-shadow: 4px 4px 0 var(--ink); overflow: hidden; }
#chat-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 15px; flex-wrap: wrap; padding: 20px 24px; background: var(--ink); color: var(--paper); }
#chat-heading h1 { font: 800 clamp(25px, 4vw, 38px)/1.15 var(--body); text-wrap: balance; }
#chat-heading p { color: var(--paper); font: 10px/1.6 var(--mono); }
#messages { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 24px; display: flex; flex-direction: column; gap: 14px; scrollbar-color: var(--line) var(--paper); }
.msg { max-width: 82%; padding: 12px 16px; border: 1px solid var(--ink); overflow-wrap: anywhere; white-space: pre-wrap; font: 14px/1.6 var(--body); }
.msg.visitor { align-self: flex-end; background: var(--warm); box-shadow: 3px 3px 0 var(--pink); }
.msg.agent { align-self: flex-start; background: var(--ink); color: var(--paper); }
.msg.system { align-self: stretch; max-width: 100%; background: transparent; border: 0; border-left: 2px solid var(--pink); color: var(--muted); font: 11px/1.7 var(--mono); padding: 4px 12px; }
#empty-state { flex: 1; display: flex; align-items: center; justify-content: center; color: var(--muted); padding: 36px; text-align: center; font: 12px/1.9 var(--mono); text-wrap: pretty; }
#input-area { padding: 18px 24px; border-top: 1px solid var(--ink); background: var(--warm); flex-shrink: 0; }
#input-row { display: flex; gap: 12px; align-items: flex-end; }
#msg-input { flex: 1; min-width: 0; padding: 12px; background: var(--paper); border: 1px solid var(--ink); color: var(--ink); font: 13px/1.5 var(--mono); resize: none; max-height: 120px; }
#msg-input::placeholder { color: var(--muted); }
#send-btn { min-height: 45px; padding: 12px 20px; border: 1px solid var(--ink); background: var(--pink); color: var(--ink); box-shadow: 2px 2px 0 var(--ink); cursor: pointer; font: 11px/1.6 var(--mono); flex-shrink: 0; }
#send-btn:hover:not(:disabled) { background: var(--ink); color: var(--paper); }
#send-btn:disabled { background: var(--paper); color: var(--muted); border-color: var(--line); box-shadow: none; cursor: default; }
#footer { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 8px 18px; color: var(--muted); font: 10px/1.7 var(--mono); flex-shrink: 0; }
#footer a:hover { color: var(--ink); text-decoration-color: var(--pink); }
@media (max-width: 600px) {
  #app { padding: max(18px, env(safe-area-inset-top)) max(16px, env(safe-area-inset-right)) max(16px, env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left)); gap: 16px; }
  #header { gap: 12px; padding-bottom: 16px; }
  .agent-info { flex-basis: calc(100% - 200px); }
  .brand b { font-size: 23px; }
  #status-pill { margin-left: auto; }
  #chat-heading { padding: 18px; }
  #chat-heading p { font-size: 9px; }
  #messages { padding: 18px; gap: 12px; }
  .msg { max-width: 92%; padding: 10px 12px; font-size: 13px; }
  #empty-state { padding: 20px 0; font-size: 11px; }
  #input-area { padding: 14px; }
  #input-row { gap: 8px; }
  #send-btn { padding-inline: 14px; }
  #msg-input { font-size: 16px; }
  #footer { font-size: 9px; }
}
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; scroll-behavior: auto !important; } }
</style>
</head>
<body>
<div id="app">
  <div id="header">
    <span class="brand">
      <span class="brand-mark">[!]</span><b>self<span class="ext">.md</span></b>
    </span>
    <span class="header-sep"></span>
    <span class="agent-info">
      <span class="agent-fp" title="${htmlFingerprint}">${htmlFingerprint}</span>
    </span>
    <span id="status-pill" role="status" aria-live="polite">
      <span id="status-dot" class="connecting"></span>
      <span id="status-text">connecting</span>
    </span>
  </div>

  <div id="chat-card">
    <div id="chat-heading"><h1>talk to an agent.</h1><p>Network / TTYA visitor chat</p></div>
    <div id="messages" role="log" aria-label="conversation" aria-live="polite">
      <div id="empty-state">send a message to start the conversation.<br>the agent will be notified.</div>
    </div>

    <div id="input-area">
      <div id="input-row">
        <textarea aria-label="message to the agent" id="msg-input" rows="1" placeholder="type a message..." autocomplete="off"></textarea>
        <button id="send-btn" disabled>send</button>
      </div>
    </div>
  </div>

  <div id="footer">
    <a href="https://github.com/shmlkv/network.self.md" target="_blank" rel="noopener">Network by self.md ↗</a><span>TTYA / a direct conversation</span>
  </div>
</div>

<script${nonces ? ` nonce="${escapeHTML(nonces.script)}"` : ''}>
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
    sendBtn.disabled = (s !== 'approved');
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
      if (status === 'rejected') return;
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
    if (status !== 'approved') return;

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
