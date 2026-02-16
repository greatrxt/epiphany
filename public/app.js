// --- Utilities ---

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function timeAgo(ts) {
  if (!ts) return "\u2014";
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

async function api(path, opts) {
  const res = await fetch(`/api${path}`, opts);
  return res.json();
}

// --- Improved Markdown Renderer ---

const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico"];
const VIDEO_EXTS = [".mp4", ".webm", ".mov", ".avi", ".mkv"];

function getFileExt(filepath) {
  const dot = filepath.lastIndexOf(".");
  return dot >= 0 ? filepath.slice(dot).toLowerCase() : "";
}

function renderMarkdown(text) {
  if (!text) return "";

  // Extract code blocks first to protect them from other transformations
  const codeBlocks = [];
  let processed = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang, code) => {
    const i = codeBlocks.length;
    codeBlocks.push(
      `<pre><code class="lang-${lang || "text"}">${escapeHtml(code.trim())}</code></pre>`
    );
    return `\x00CB${i}\x00`;
  });

  // Process [FILE]: lines into media elements
  const fileBlocks = [];
  processed = processed.replace(/^\[FILE\]:\s*(.+)$/gm, (_m, fp) => {
    const filepath = fp.trim();
    const ext = getFileExt(filepath);
    const src = `/api/files?path=${encodeURIComponent(filepath)}`;
    const i = fileBlocks.length;
    let html;
    if (IMAGE_EXTS.includes(ext)) {
      html = `<div class="media-block"><img src="${src}" alt="${escapeHtml(filepath)}" class="inline-image" onclick="this.classList.toggle('expanded')"><div class="media-caption">${escapeHtml(filepath)}</div></div>`;
    } else if (VIDEO_EXTS.includes(ext)) {
      html = `<div class="media-block"><video controls class="inline-video" src="${src}"></video><div class="media-caption">${escapeHtml(filepath)}</div></div>`;
    } else {
      html = `<div class="media-block"><a href="${src}" target="_blank" class="file-download">\u2B07 ${escapeHtml(filepath.split("/").pop())}</a></div>`;
    }
    fileBlocks.push(html);
    return `\x00FB${i}\x00`;
  });

  // Now escape HTML in the remaining text
  processed = escapeHtml(processed);

  // Inline code (before other inline patterns)
  processed = processed.replace(/`([^`]+)`/g, "<code>$1</code>");

  // Images ![alt](url) — before links
  processed = processed.replace(
    /!\[([^\]]*)\]\(([^)]+)\)/g,
    '<img src="$2" alt="$1" class="md-image">'
  );

  // Links [text](url)
  processed = processed.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener">$1</a>'
  );

  // Bold
  processed = processed.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

  // Italic
  processed = processed.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>");

  // Process lines for block-level elements
  const lines = processed.split("\n");
  const result = [];
  let inList = false;
  let listType = null;

  for (const line of lines) {
    // Code block placeholder
    const cbMatch = line.match(/^\x00CB(\d+)\x00$/);
    if (cbMatch) {
      if (inList) { result.push(listType === "ul" ? "</ul>" : "</ol>"); inList = false; }
      result.push(codeBlocks[parseInt(cbMatch[1])]);
      continue;
    }

    // File block placeholder
    const fbMatch = line.match(/^\x00FB(\d+)\x00$/);
    if (fbMatch) {
      if (inList) { result.push(listType === "ul" ? "</ul>" : "</ol>"); inList = false; }
      result.push(fileBlocks[parseInt(fbMatch[1])]);
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      if (inList) { result.push(listType === "ul" ? "</ul>" : "</ol>"); inList = false; }
      result.push("<hr>");
      continue;
    }

    // Headers
    const headerMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headerMatch) {
      if (inList) { result.push(listType === "ul" ? "</ul>" : "</ol>"); inList = false; }
      const level = headerMatch[1].length;
      result.push(`<h${level}>${headerMatch[2]}</h${level}>`);
      continue;
    }

    // Unordered list
    const ulMatch = line.match(/^[-*]\s+(.+)$/);
    if (ulMatch) {
      if (!inList || listType !== "ul") {
        if (inList) result.push(listType === "ul" ? "</ul>" : "</ol>");
        result.push("<ul>");
        inList = true;
        listType = "ul";
      }
      result.push(`<li>${ulMatch[1]}</li>`);
      continue;
    }

    // Ordered list
    const olMatch = line.match(/^\d+\.\s+(.+)$/);
    if (olMatch) {
      if (!inList || listType !== "ol") {
        if (inList) result.push(listType === "ul" ? "</ul>" : "</ol>");
        result.push("<ol>");
        inList = true;
        listType = "ol";
      }
      result.push(`<li>${olMatch[1]}</li>`);
      continue;
    }

    // Close list if we hit a non-list line
    if (inList && line.trim() !== "") {
      result.push(listType === "ul" ? "</ul>" : "</ol>");
      inList = false;
    }

    result.push(line);
  }

  if (inList) result.push(listType === "ul" ? "</ul>" : "</ol>");

  // Join and wrap non-block text in paragraphs
  let html = result.join("\n");
  html = html
    .split(/\n{2,}/)
    .map((p) => {
      const trimmed = p.trim();
      if (!trimmed) return "";
      if (/^<(pre|h[1-6]|ul|ol|hr|div|table|blockquote)/.test(trimmed)) return trimmed;
      return `<p>${trimmed.replace(/\n/g, "<br>")}</p>`;
    })
    .join("");

  return html;
}

// --- Global SSE ---

let globalSSE = null;
let permissionCount = 0;
let sseReconnectTimer = null;

function connectGlobalSSE() {
  if (globalSSE) {
    globalSSE.close();
    globalSSE = null;
  }
  if (sseReconnectTimer) {
    clearTimeout(sseReconnectTimer);
    sseReconnectTimer = null;
  }

  globalSSE = new EventSource("/api/events");

  globalSSE.addEventListener("session-update", (e) => {
    const data = JSON.parse(e.data);
    const route = getRoute();
    // Refresh sessions list if on sessions page
    if (route === "/sessions") renderSessions();
    // Refresh session detail if viewing this session
    const detailMatch = route.match(/^\/sessions\/(.+)$/);
    if (detailMatch && detailMatch[1] === data.sessionId) {
      renderSessionDetail(data.sessionId);
    }
    // Refresh status page
    if (route === "/") refreshStatusData();
  });

  globalSSE.addEventListener("schedule-update", () => {
    if (getRoute() === "/schedules") renderSchedules();
  });

  globalSSE.addEventListener("permission-request", () => {
    permissionCount++;
    updatePermissionBadge();
    const route = getRoute();
    if (route === "/permissions") renderPermissions();
  });

  globalSSE.addEventListener("permission-resolved", () => {
    permissionCount = Math.max(0, permissionCount - 1);
    updatePermissionBadge();
    const route = getRoute();
    if (route === "/permissions") renderPermissions();
  });

  globalSSE.onerror = () => {
    globalSSE.close();
    globalSSE = null;
    // Reconnect after 3s
    sseReconnectTimer = setTimeout(connectGlobalSSE, 3000);
  };
}

function updatePermissionBadge() {
  const badge = document.getElementById("perm-badge");
  if (!badge) return;
  if (permissionCount > 0) {
    badge.textContent = permissionCount;
    badge.style.display = "inline-block";
  } else {
    badge.style.display = "none";
  }
}

// Load initial permission count
async function loadPermissionCount() {
  try {
    const perms = await api("/permissions");
    permissionCount = perms.length;
    updatePermissionBadge();
  } catch {}
}

// --- API helpers ---

let channelNames = {};

async function loadChannelNames() {
  try {
    channelNames = await api("/channels");
  } catch {}
}

function channelLabel(id) {
  if (!id) return "\u2014";
  const name = channelNames[id];
  return name ? `#${name}` : id;
}

const $app = document.getElementById("app");

// --- Router ---

const routes = {
  "/": renderStatus,
  "/sessions": renderSessions,
  "/chat": renderChat,
  "/projects": renderProjects,
  "/permissions": renderPermissions,
  "/schedules": renderSchedules,
};

function getRoute() {
  return location.hash.slice(1) || "/";
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
window.addEventListener("load", async () => {
  connectGlobalSSE();
  loadPermissionCount();
  await loadChannelNames();
  navigate();
});

// --- Status View (live uptime) ---

let statusUptimeBase = null;
let statusFetchedAt = null;
let statusTicker = null;

async function renderStatus() {
  $app.innerHTML = "<h1>Status</h1><div class='card'>Loading...</div>";
  const data = await api("/status");

  statusUptimeBase = data.uptime;
  statusFetchedAt = Date.now();

  $app.innerHTML = `
    <h1>Status</h1>
    <div class="card">
      <div class="stat">
        <div class="stat-value">${data.slackSessions}</div>
        <div class="stat-label">Slack Sessions</div>
      </div>
      <div class="stat">
        <div class="stat-value" id="history-count">${data.historySessions}</div>
        <div class="stat-label">History Records</div>
      </div>
      <div class="stat">
        <div class="stat-value" id="uptime-display">${formatUptime(data.uptime)}</div>
        <div class="stat-label">Uptime</div>
      </div>
    </div>
    <button class="btn" id="ping-btn">Ping</button>
    <span id="ping-result"></span>
  `;

  // Live uptime ticker
  if (statusTicker) clearInterval(statusTicker);
  statusTicker = setInterval(() => {
    const el = document.getElementById("uptime-display");
    if (!el) { clearInterval(statusTicker); return; }
    const elapsed = Math.floor((Date.now() - statusFetchedAt) / 1000);
    el.textContent = formatUptime(statusUptimeBase + elapsed);
  }, 1000);

  document.getElementById("ping-btn").onclick = async () => {
    const t0 = Date.now();
    await api("/status");
    document.getElementById("ping-result").textContent = ` ${Date.now() - t0}ms`;
  };
}

async function refreshStatusData() {
  // Called by SSE events to update counts without full re-render
  if (getRoute() !== "/") return;
  try {
    const data = await api("/status");
    statusUptimeBase = data.uptime;
    statusFetchedAt = Date.now();
    const histEl = document.getElementById("history-count");
    if (histEl) histEl.textContent = data.historySessions;
  } catch {}
}

// --- Sessions View (auto-refreshing) ---

async function renderSessions() {
  const existing = $app.querySelector("table");
  if (!existing) {
    $app.innerHTML = "<h1>Sessions</h1><div class='card'>Loading...</div>";
  }

  const sessions = await api("/sessions");

  if (sessions.length === 0) {
    $app.innerHTML =
      '<h1>Sessions</h1><div class="empty">No sessions yet. Send a message via Slack or use the Chat tab.</div>';
    return;
  }

  const rows = sessions
    .map(
      (s) => `
    <tr>
      <td><a href="#/sessions/${s.sessionId}">${s.sessionId.slice(0, 8)}...</a></td>
      <td><span class="badge badge-${s.source || "slack"}">${s.source || "slack"}</span></td>
      <td>${channelLabel(s.channelId)}</td>
      <td>${s.project ? s.project.split("/").pop() : "\u2014"}</td>
      <td>${s.messageCount}</td>
      <td class="timestamp">${timeAgo(s.lastActive)}</td>
      <td><button class="btn btn-danger btn-sm" data-delete-session="${s.sessionId}">Delete</button></td>
    </tr>`
    )
    .join("");

  $app.innerHTML = `
    <h1>Sessions</h1>
    <table>
      <thead><tr><th>Session</th><th>Source</th><th>Channel</th><th>Project</th><th>Messages</th><th>Last Active</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;

  document.querySelectorAll("[data-delete-session]").forEach((btn) => {
    btn.onclick = async () => {
      const sid = btn.dataset.deleteSession;
      if (!confirm("Delete this session and its history?")) return;
      await api(`/sessions/${sid}`, { method: "DELETE" });
      renderSessions();
    };
  });
}

// --- Session Detail (with media rendering) ---

async function renderSessionDetail(sessionId) {
  $app.innerHTML = "<h1>Session</h1><div class='card'>Loading...</div>";
  const messages = await api(`/sessions/${sessionId}/history`);

  const back =
    '<a href="#/sessions" style="color:var(--accent);font-size:13px;">&larr; Back to sessions</a>';

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

// --- Chat View (with SSE reconnection + media) ---

let chatEventSource = null;
let chatSessionId = null;

async function renderChat() {
  const sessions = await api("/sessions");
  const projects = await api("/projects");

  const sessionOpts = sessions
    .map(
      (s) =>
        `<option value="${s.sessionId}">${s.sessionId.slice(0, 8)}... (${s.source}, ${s.messageCount} msgs)</option>`
    )
    .join("");

  const projectOpts = projects
    .map(
      (p) =>
        `<option value="${p.path}">${p.path.split("/").pop()} \u2014 ${p.path}</option>`
    )
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

    // Connect SSE for this chat session
    connectChatSSE($messages);
  }
}

function connectChatSSE($messages) {
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
      // SSE connection error — try to reconnect
      if (chatEventSource) chatEventSource.close();
      chatEventSource = null;
      // Only reconnect if we're still on the chat page
      if (getRoute() === "/chat" && chatSessionId) {
        setTimeout(() => {
          const el = document.getElementById("chat-messages");
          if (el) connectChatSSE(el);
        }, 2000);
      }
    }
  });

  chatEventSource.addEventListener("done", () => {
    removeThinking();
    if (chatEventSource) {
      chatEventSource.close();
      chatEventSource = null;
    }
  });
}

function removeThinking() {
  const el = document.getElementById("thinking-indicator");
  if (el) el.remove();
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

// --- Permissions View ---

async function renderPermissions() {
  $app.innerHTML = "<h1>Permissions</h1><div class='card'>Loading...</div>";
  const perms = await api("/permissions");

  permissionCount = perms.length;
  updatePermissionBadge();

  if (perms.length === 0) {
    $app.innerHTML =
      '<h1>Permissions</h1><div class="empty">No pending permission requests.</div>';
    return;
  }

  const cards = perms
    .map((p) => {
      const denialLines = p.denials
        .map((d) => {
          if (d.tool_name === "Bash" && d.tool_input?.command) {
            return `<code>${escapeHtml(d.tool_input.command)}</code>`;
          }
          return `Tool: <code>${escapeHtml(d.tool_name)}</code>`;
        })
        .join("<br>");

      return `
      <div class="permission-card">
        <div class="permission-header">
          <span class="permission-icon">\uD83D\uDD12</span>
          <span class="permission-title">Permission Request</span>
          <span class="badge badge-slack">${channelLabel(p.channel) || "unknown"}</span>
        </div>
        <div class="permission-detail">
          <div class="permission-label">Claude wants to run:</div>
          <div class="permission-denials">${denialLines}</div>
          ${p.prompt ? `<div class="permission-label" style="margin-top:8px;">Original prompt:</div><div class="permission-prompt">${escapeHtml(p.prompt.slice(0, 200))}${p.prompt.length > 200 ? "..." : ""}</div>` : ""}
          <div class="permission-meta">Session: ${p.sessionId ? p.sessionId.slice(0, 8) + "..." : "\u2014"}</div>
        </div>
        <div class="permission-actions">
          <button class="btn btn-primary btn-allow" data-action-id="${p.actionId}">Allow & Retry</button>
          <button class="btn btn-danger btn-deny" data-action-id="${p.actionId}">Deny</button>
        </div>
      </div>`;
    })
    .join("");

  $app.innerHTML = `<h1>Permissions</h1>${cards}`;

  // Wire up buttons
  document.querySelectorAll(".btn-allow").forEach((btn) => {
    btn.onclick = async () => {
      btn.disabled = true;
      btn.textContent = "Allowing...";
      try {
        await api(`/permissions/${btn.dataset.actionId}/allow`, { method: "POST" });
      } catch {}
      renderPermissions();
    };
  });

  document.querySelectorAll(".btn-deny").forEach((btn) => {
    btn.onclick = async () => {
      btn.disabled = true;
      btn.textContent = "Denying...";
      try {
        await api(`/permissions/${btn.dataset.actionId}/deny`, { method: "POST" });
      } catch {}
      renderPermissions();
    };
  });
}

// --- Projects View ---

async function renderProjects() {
  $app.innerHTML = "<h1>Projects</h1><div class='card'>Loading...</div>";
  const projectsList = await api("/projects");

  const rows = projectsList
    .map(
      (p) => `
    <tr>
      <td>${channelLabel(p.channelId)}</td>
      <td>${p.path}</td>
      <td>${p.setBy || "\u2014"}</td>
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

// --- Schedules View ---

async function renderSchedules() {
  const existing = $app.querySelector("table");
  if (!existing) {
    $app.innerHTML = "<h1>Schedules</h1><div class='card'>Loading...</div>";
  }

  const [schedulesList, projectsList] = await Promise.all([
    api("/schedules"),
    api("/projects"),
  ]);

  const channelOpts = projectsList
    .map(
      (p) =>
        `<option value="${p.channelId}">${channelLabel(p.channelId)} \u2014 ${p.path.split("/").pop()}</option>`
    )
    .join("");

  const rows = schedulesList
    .map(
      (s) => `
    <tr>
      <td><code>${escapeHtml(s.command)}</code>${s.args ? ` <span class="text-muted">${escapeHtml(s.args)}</span>` : ""}</td>
      <td>${channelLabel(s.sourceChannel)}</td>
      <td>${channelLabel(s.outputChannel)}</td>
      <td>${s.intervalMinutes}m</td>
      <td>
        <label class="toggle-switch">
          <input type="checkbox" ${s.enabled ? "checked" : ""} data-toggle-id="${s.id}">
          <span class="toggle-slider"></span>
        </label>
      </td>
      <td class="timestamp">${s.lastRun ? timeAgo(s.lastRun) : "\u2014"}</td>
      <td>
        <button class="btn btn-sm btn-primary" data-run-id="${s.id}">Run Now</button>
        <button class="btn btn-sm btn-danger" data-delete-id="${s.id}">Delete</button>
      </td>
    </tr>`
    )
    .join("");

  $app.innerHTML = `
    <h1>Schedules</h1>
    <div class="card">
      <h2>New Schedule</h2>
      <div class="form-row">
        <select id="sched-source"><option value="">Source channel</option>${channelOpts}</select>
        <input id="sched-output" placeholder="Output channel ID" />
      </div>
      <div class="form-row">
        <input id="sched-command" placeholder="Command name" />
        <input id="sched-args" placeholder="Arguments (optional)" />
        <input id="sched-interval" type="number" placeholder="Interval (min)" value="5" style="width:120px;" />
        <button class="btn btn-primary" id="sched-add">Create</button>
      </div>
    </div>
    ${
      schedulesList.length === 0
        ? '<div class="empty">No scheduled commands yet.</div>'
        : `<table>
            <thead><tr><th>Command</th><th>Source</th><th>Output</th><th>Interval</th><th>Enabled</th><th>Last Run</th><th>Actions</th></tr></thead>
            <tbody>${rows}</tbody>
           </table>`
    }
  `;

  // Create schedule
  document.getElementById("sched-add").onclick = async () => {
    const sourceChannel = document.getElementById("sched-source").value;
    const outputChannel = document.getElementById("sched-output").value.trim();
    const command = document.getElementById("sched-command").value.trim();
    const args = document.getElementById("sched-args").value.trim();
    const intervalMinutes = parseInt(document.getElementById("sched-interval").value, 10) || 5;
    if (!sourceChannel || !outputChannel || !command) {
      alert("Source channel, output channel, and command are required.");
      return;
    }
    const result = await api("/schedules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceChannel, outputChannel, command, args, intervalMinutes }),
    });
    if (result.error) {
      alert(result.error);
    } else {
      renderSchedules();
    }
  };

  // Toggle enabled
  document.querySelectorAll("[data-toggle-id]").forEach((input) => {
    input.onchange = async () => {
      await api(`/schedules/${input.dataset.toggleId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: input.checked }),
      });
    };
  });

  // Run now
  document.querySelectorAll("[data-run-id]").forEach((btn) => {
    btn.onclick = async () => {
      btn.disabled = true;
      btn.textContent = "Running...";
      await api(`/schedules/${btn.dataset.runId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lastRun: null }),
      });
      // Schedule will be picked up on next tick; for immediate feedback, re-render
      setTimeout(renderSchedules, 2000);
    };
  });

  // Delete
  document.querySelectorAll("[data-delete-id]").forEach((btn) => {
    btn.onclick = async () => {
      await api(`/schedules/${btn.dataset.deleteId}`, { method: "DELETE" });
      renderSchedules();
    };
  });
}
