// --- Markdown renderer (simple regex-based) ---
function renderMarkdown(text) {
  if (!text) return "";
  let html = escapeHtml(text);

  // Code blocks (``` ... ```)
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang, code) => {
    return `<pre><code class="lang-${lang}">${code.trim()}</code></pre>`;
  });

  // Inline code
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");

  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

  // Italic
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");

  // Line breaks into paragraphs
  html = html
    .split(/\n{2,}/)
    .map((p) => {
      if (p.startsWith("<pre>")) return p;
      return `<p>${p.replace(/\n/g, "<br>")}</p>`;
    })
    .join("");

  return html;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function timeAgo(ts) {
  if (!ts) return "—";
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function formatUptime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// --- API helpers ---
async function api(path, opts) {
  const res = await fetch(`/api${path}`, opts);
  return res.json();
}

// --- Router ---
const $app = document.getElementById("app");
const routes = {
  "/": renderStatus,
  "/sessions": renderSessions,
  "/chat": renderChat,
  "/projects": renderProjects,
};

function getRoute() {
  const hash = location.hash.slice(1) || "/";
  return hash;
}

function navigate() {
  const route = getRoute();

  // Update active nav link
  document.querySelectorAll(".nav-link").forEach((el) => {
    const r = el.dataset.route;
    el.classList.toggle("active", route === r || (r !== "/" && route.startsWith(r)));
  });

  // Session detail route
  const sessionMatch = route.match(/^\/sessions\/(.+)$/);
  if (sessionMatch) {
    renderSessionDetail(sessionMatch[1]);
    return;
  }

  const handler = routes[route];
  if (handler) {
    handler();
  } else {
    $app.innerHTML = '<div class="empty">Page not found</div>';
  }
}

window.addEventListener("hashchange", navigate);
window.addEventListener("load", navigate);

// --- Views ---

async function renderStatus() {
  $app.innerHTML = "<h1>Status</h1><div class='card'>Loading...</div>";
  const data = await api("/status");
  $app.innerHTML = `
    <h1>Status</h1>
    <div class="card">
      <div class="stat">
        <div class="stat-value">${data.slackSessions}</div>
        <div class="stat-label">Slack Sessions</div>
      </div>
      <div class="stat">
        <div class="stat-value">${data.historySessions}</div>
        <div class="stat-label">History Records</div>
      </div>
      <div class="stat">
        <div class="stat-value">${formatUptime(data.uptime)}</div>
        <div class="stat-label">Uptime</div>
      </div>
    </div>
    <button class="btn" id="ping-btn">Ping</button>
    <span id="ping-result"></span>
  `;
  document.getElementById("ping-btn").onclick = async () => {
    const t0 = Date.now();
    await api("/status");
    document.getElementById("ping-result").textContent = ` ${Date.now() - t0}ms`;
  };
}

async function renderSessions() {
  $app.innerHTML = "<h1>Sessions</h1><div class='card'>Loading...</div>";
  const sessions = await api("/sessions");

  if (sessions.length === 0) {
    $app.innerHTML = '<h1>Sessions</h1><div class="empty">No sessions yet. Send a message via Slack or use the Chat tab.</div>';
    return;
  }

  const rows = sessions
    .map(
      (s) => `
    <tr>
      <td><a href="#/sessions/${s.sessionId}">${s.sessionId.slice(0, 8)}...</a></td>
      <td><span class="badge badge-${s.source || "slack"}">${s.source || "slack"}</span></td>
      <td>${s.channelId || "—"}</td>
      <td>${s.project ? s.project.split("/").pop() : "—"}</td>
      <td>${s.messageCount}</td>
      <td class="timestamp">${timeAgo(s.lastActive)}</td>
    </tr>`
    )
    .join("");

  $app.innerHTML = `
    <h1>Sessions</h1>
    <table>
      <thead><tr><th>Session</th><th>Source</th><th>Channel</th><th>Project</th><th>Messages</th><th>Last Active</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

async function renderSessionDetail(sessionId) {
  $app.innerHTML = "<h1>Session</h1><div class='card'>Loading...</div>";
  const messages = await api(`/sessions/${sessionId}/history`);

  const back = '<a href="#/sessions" style="color:var(--accent);font-size:13px;">&larr; Back to sessions</a>';

  if (messages.length === 0) {
    $app.innerHTML = `${back}<h1>Session ${sessionId.slice(0, 8)}...</h1><div class="empty">No messages in history for this session.</div>`;
    return;
  }

  const msgHtml = messages
    .map(
      (m) => `
    <div class="message ${m.role}">
      <div class="message-role">${m.role} <span class="timestamp">${new Date(m.timestamp).toLocaleTimeString()}</span></div>
      <div class="message-body">${renderMarkdown(m.text)}</div>
    </div>`
    )
    .join("");

  $app.innerHTML = `
    ${back}
    <h1>Session ${sessionId.slice(0, 8)}...</h1>
    <div class="chat-messages" style="max-height:calc(100vh - 140px);overflow-y:auto;">
      ${msgHtml}
    </div>
  `;
}

// --- Chat view ---
let chatEventSource = null;
let chatSessionId = null;

async function renderChat() {
  const sessions = await api("/sessions");
  const projects = await api("/projects");

  const sessionOpts = sessions
    .map((s) => `<option value="${s.sessionId}">${s.sessionId.slice(0, 8)}... (${s.source}, ${s.messageCount} msgs)</option>`)
    .join("");

  const projectOpts = projects
    .map((p) => `<option value="${p.path}">${p.path.split("/").pop()} — ${p.path}</option>`)
    .join("");

  $app.innerHTML = `
    <div class="chat-container">
      <div class="chat-header">
        <select id="chat-session">
          <option value="">New session</option>
          ${sessionOpts}
        </select>
        <select id="chat-project">
          <option value="">No project</option>
          ${projectOpts}
        </select>
      </div>
      <div class="chat-messages" id="chat-messages"></div>
      <div class="chat-input-bar">
        <textarea id="chat-input" placeholder="Send a message to Claude..." rows="1"></textarea>
        <button class="btn btn-primary" id="chat-send">Send</button>
      </div>
    </div>
  `;

  const $messages = document.getElementById("chat-messages");
  const $input = document.getElementById("chat-input");
  const $send = document.getElementById("chat-send");
  const $session = document.getElementById("chat-session");
  const $project = document.getElementById("chat-project");

  // If resuming, load history
  if (chatSessionId) {
    $session.value = chatSessionId;
    await loadChatHistory($messages, chatSessionId);
  }

  $session.onchange = async () => {
    chatSessionId = $session.value || null;
    if (chatSessionId) {
      await loadChatHistory($messages, chatSessionId);
    } else {
      $messages.innerHTML = "";
    }
  };

  // Auto-resize textarea
  $input.addEventListener("input", () => {
    $input.style.height = "auto";
    $input.style.height = Math.min($input.scrollHeight, 120) + "px";
  });

  // Send on Enter (Shift+Enter for newline)
  $input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendChat();
    }
  });

  $send.onclick = sendChat;

  async function sendChat() {
    const prompt = $input.value.trim();
    if (!prompt) return;

    $input.value = "";
    $input.style.height = "auto";

    // Show user message
    appendMessage($messages, "user", prompt);

    // Send to API
    const body = { prompt };
    if (chatSessionId) body.sessionId = chatSessionId;
    const cwd = $project.value;
    if (cwd) body.cwd = cwd;

    const result = await api("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    chatSessionId = result.sessionId;

    // Update session dropdown
    if (!$session.querySelector(`option[value="${chatSessionId}"]`)) {
      const opt = document.createElement("option");
      opt.value = chatSessionId;
      opt.textContent = `${chatSessionId.slice(0, 8)}... (dashboard, new)`;
      $session.appendChild(opt);
    }
    $session.value = chatSessionId;

    // Show thinking indicator
    const thinkingEl = document.createElement("div");
    thinkingEl.className = "thinking";
    thinkingEl.id = "thinking-indicator";
    thinkingEl.textContent = "Claude is thinking";
    $messages.appendChild(thinkingEl);
    scrollToBottom($messages);

    // Connect SSE
    if (chatEventSource) chatEventSource.close();
    chatEventSource = new EventSource(`/api/chat/${chatSessionId}/stream`);

    chatEventSource.addEventListener("thinking", () => {
      // Keep showing thinking indicator
    });

    chatEventSource.addEventListener("message", (e) => {
      removeThinking();
      const data = JSON.parse(e.data);
      appendMessage($messages, "assistant", data.text);
      if (data.sessionId) chatSessionId = data.sessionId;
    });

    chatEventSource.addEventListener("error", (e) => {
      removeThinking();
      try {
        const data = JSON.parse(e.data);
        appendMessage($messages, "error", data.error || "Unknown error");
      } catch {
        // SSE connection error, not a Claude error
      }
    });

    chatEventSource.addEventListener("done", () => {
      removeThinking();
      if (chatEventSource) {
        chatEventSource.close();
        chatEventSource = null;
      }
    });

    function removeThinking() {
      const el = document.getElementById("thinking-indicator");
      if (el) el.remove();
    }
  }
}

async function loadChatHistory($container, sessionId) {
  const messages = await api(`/sessions/${sessionId}/history`);
  $container.innerHTML = "";
  for (const m of messages) {
    appendMessage($container, m.role, m.text);
  }
}

function appendMessage($container, role, text) {
  const div = document.createElement("div");
  div.className = `message ${role}`;
  div.innerHTML = `
    <div class="message-role">${role}</div>
    <div class="message-body">${renderMarkdown(text)}</div>
  `;
  $container.appendChild(div);
  scrollToBottom($container);
}

function scrollToBottom(el) {
  el.scrollTop = el.scrollHeight;
}

// --- Projects view ---
async function renderProjects() {
  $app.innerHTML = "<h1>Projects</h1><div class='card'>Loading...</div>";
  const projectsList = await api("/projects");

  const rows = projectsList
    .map(
      (p) => `
    <tr>
      <td>${p.channelId}</td>
      <td>${p.path}</td>
      <td>${p.setBy || "—"}</td>
      <td class="timestamp">${timeAgo(p.lastUsed)}</td>
      <td><button class="btn btn-danger btn-sm" data-channel="${p.channelId}">Remove</button></td>
    </tr>`
    )
    .join("");

  $app.innerHTML = `
    <h1>Projects</h1>
    <div class="card">
      <h2>Add Binding</h2>
      <div class="form-row">
        <input id="proj-channel" placeholder="Channel ID" />
        <input id="proj-path" placeholder="/path/to/project" />
        <button class="btn btn-primary" id="proj-add">Add</button>
      </div>
    </div>
    ${
      projectsList.length === 0
        ? '<div class="empty">No project bindings.</div>'
        : `<table>
            <thead><tr><th>Channel</th><th>Path</th><th>Set By</th><th>Last Used</th><th></th></tr></thead>
            <tbody>${rows}</tbody>
           </table>`
    }
  `;

  document.getElementById("proj-add").onclick = async () => {
    const channelId = document.getElementById("proj-channel").value.trim();
    const dirPath = document.getElementById("proj-path").value.trim();
    if (!channelId || !dirPath) return;
    const result = await api("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channelId, path: dirPath }),
    });
    if (result.error) {
      alert(result.error);
    } else {
      renderProjects();
    }
  };

  // Remove buttons
  document.querySelectorAll("[data-channel]").forEach((btn) => {
    btn.onclick = async () => {
      const channelId = btn.dataset.channel;
      await api(`/projects/${channelId}`, { method: "DELETE" });
      renderProjects();
    };
  });
}
