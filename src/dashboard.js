const path = require("path");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");

const DASHBOARD_CONTEXT = [
  "You are being used through a web dashboard interface.",
  "The user is chatting with you from a local web UI.",
  "Your responses will be displayed in a web chat interface (markdown formatting works).",
  "You cannot open files, URLs, or images in a browser/viewer for the user.",
  "If the user asks to see something, output the content as text in your response.",
].join(" ");

// Per-session SSE connections (for chat streaming)
const sseClients = new Map();

// Global SSE connections (for dashboard-wide live events)
const globalSSEClients = new Set();

function sendSSE(sessionId, event, data) {
  const clients = sseClients.get(sessionId);
  if (!clients) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {}
  }
}

function broadcastEvent(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of globalSSEClients) {
    try {
      res.write(payload);
    } catch {}
  }
}

const MIME_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".avi": "video/x-msvideo",
  ".mkv": "video/x-matroska",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".json": "application/json",
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
};

// Build allowedTools patterns from permission denials (mirrors index.js logic)
function buildAllowedTools(denials) {
  const tools = new Set();
  for (const denial of denials) {
    const name = denial.tool_name;
    if (name === "Bash" && denial.tool_input?.command) {
      const program = denial.tool_input.command.split(/\s+/)[0];
      tools.add(`Bash(${program}:*)`);
    } else {
      tools.add(name);
    }
  }
  return [...tools];
}

function create({ sessions, projects, history, claude, pendingPermissions, schedules, slackClient }) {
  // Use Express from @slack/bolt's dependency tree
  let express;
  try {
    express = require("express");
  } catch {
    // Resolve from @slack/bolt's node_modules
    const boltPath = require.resolve("@slack/bolt");
    const boltDir = path.dirname(boltPath);
    express = require(path.join(boltDir, "..", "express"));
  }

  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, "..", "public")));

  const startTime = Date.now();

  // --- Global SSE endpoint ---
  app.get("/api/events", (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write("\n");

    globalSSEClients.add(res);

    // Heartbeat every 15s
    const heartbeat = setInterval(() => {
      try {
        res.write(": heartbeat\n\n");
      } catch {}
    }, 15000);

    req.on("close", () => {
      globalSSEClients.delete(res);
      clearInterval(heartbeat);
    });
  });

  // --- File serving ---
  app.get("/api/files", (req, res) => {
    const filePath = req.query.path;
    if (!filePath) {
      return res.status(400).json({ error: "path query parameter required" });
    }

    try {
      const resolved = path.resolve(filePath);
      const stat = fs.statSync(resolved);
      if (!stat.isFile()) {
        return res.status(400).json({ error: "not a regular file" });
      }

      const ext = path.extname(resolved).toLowerCase();
      const mime = MIME_TYPES[ext] || "application/octet-stream";
      res.setHeader("Content-Type", mime);
      res.setHeader("Content-Length", stat.size);
      fs.createReadStream(resolved).pipe(res);
    } catch (err) {
      if (err.code === "ENOENT") {
        return res.status(404).json({ error: "file not found" });
      }
      res.status(500).json({ error: err.message });
    }
  });

  // --- API Routes ---

  app.get("/api/status", (_req, res) => {
    const allSessions = sessions.all();
    const historyList = history.listSessions();
    res.json({
      uptime: Math.floor((Date.now() - startTime) / 1000),
      slackSessions: Object.keys(allSessions).length,
      historySessions: historyList.length,
    });
  });

  // Channel name cache (fetched from Slack once, refreshed on demand)
  let channelCache = null;
  let channelCacheTime = 0;

  app.get("/api/channels", async (_req, res) => {
    const now = Date.now();
    // Cache for 5 minutes
    if (channelCache && now - channelCacheTime < 300_000) {
      return res.json(channelCache);
    }
    if (!slackClient) {
      return res.json({});
    }
    try {
      const result = await slackClient.conversations.list({
        types: "public_channel,private_channel",
        limit: 200,
        exclude_archived: true,
      });
      const map = {};
      for (const ch of result.channels || []) {
        map[ch.id] = ch.name;
      }
      channelCache = map;
      channelCacheTime = now;
      res.json(map);
    } catch (err) {
      console.error("Failed to fetch channels:", err.message);
      res.json(channelCache || {});
    }
  });

  app.get("/api/sessions", (_req, res) => {
    const allSessions = sessions.all();
    const historyList = history.listSessions();
    const historyMap = {};
    for (const h of historyList) {
      historyMap[h.sessionId] = h;
    }

    // Merge Slack sessions with history metadata
    const merged = [];
    const seen = new Set();

    for (const [key, entry] of Object.entries(allSessions)) {
      const sid = entry.sessionId;
      seen.add(sid);
      const h = historyMap[sid] || {};
      const channelId = entry.channelId || sessions.parseKey(key).channelId;
      const projectEntry = projects.all()[channelId];
      merged.push({
        sessionId: sid,
        channelId,
        threadTs: entry.threadTs || null,
        source: h.source || "slack",
        project: projectEntry ? projectEntry.path : null,
        messageCount: h.messageCount || 0,
        lastActive: h.lastActive || entry.lastUsed,
        createdAt: entry.createdAt,
      });
    }

    // Add history-only sessions (dashboard sessions)
    for (const h of historyList) {
      if (seen.has(h.sessionId)) continue;
      merged.push({
        sessionId: h.sessionId,
        channelId: null,
        source: h.source || "dashboard",
        project: null,
        messageCount: h.messageCount,
        lastActive: h.lastActive,
        createdAt: h.lastActive,
      });
    }

    merged.sort((a, b) => {
      const ta = a.lastActive || a.createdAt || "";
      const tb = b.lastActive || b.createdAt || "";
      return tb.localeCompare(ta);
    });

    res.json(merged);
  });

  app.get("/api/sessions/:id/history", (req, res) => {
    const messages = history.getSession(req.params.id);
    res.json(messages);
  });

  app.delete("/api/sessions/:id", (req, res) => {
    const sessionId = req.params.id;
    // Remove from channel-session mappings using reverse lookup
    const matches = sessions.getBySessionId(sessionId);
    for (const match of matches) {
      sessions.clear(match.channelId, match.threadTs);
    }
    // Remove history
    history.clear(sessionId);
    broadcastEvent("session-update", { sessionId, deleted: true });
    res.json({ ok: true });
  });

  app.get("/api/projects", (_req, res) => {
    const all = projects.all();
    const list = Object.entries(all).map(([channelId, entry]) => ({
      channelId,
      ...entry,
    }));
    res.json(list);
  });

  app.post("/api/projects", (req, res) => {
    const { channelId, path: dirPath } = req.body;
    if (!channelId || !dirPath) {
      return res.status(400).json({ error: "channelId and path are required" });
    }
    try {
      projects.set(channelId, dirPath);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.delete("/api/projects/:channelId", (req, res) => {
    projects.remove(req.params.channelId);
    res.json({ ok: true });
  });

  // --- Permissions API ---

  app.get("/api/permissions", (_req, res) => {
    const list = [];
    if (pendingPermissions) {
      for (const [actionId, data] of pendingPermissions) {
        list.push({
          actionId,
          channel: data.channel,
          sessionId: data.sessionId,
          denials: data.denials,
          prompt: data.prompt,
        });
      }
    }
    res.json(list);
  });

  app.post("/api/permissions/:actionId/allow", async (req, res) => {
    const { actionId } = req.params;
    if (!pendingPermissions) {
      return res.status(500).json({ error: "permissions not configured" });
    }

    const pending = pendingPermissions.get(actionId);
    if (!pending) {
      return res
        .status(404)
        .json({ error: "Permission request not found or expired" });
    }

    pendingPermissions.delete(actionId);
    const { prompt, sessionId, denials, channel, cwd: pendingCwd } = pending;
    const allowedTools = buildAllowedTools(denials);
    const cwd = pendingCwd || (channel ? projects.get(channel) : undefined);

    try {
      const result = await claude.run({
        prompt: prompt || "Please retry the previously denied operations.",
        resume: sessionId,
        allowedTools,
        cwd,
      });

      if (result.sessionId && result.response) {
        history.append(result.sessionId, {
          role: result.error ? "error" : "assistant",
          text: result.response,
          source: "dashboard-approved",
        });
      }

      broadcastEvent("permission-resolved", {
        actionId,
        status: "allowed",
      });
      broadcastEvent("session-update", {
        sessionId: result.sessionId || sessionId,
      });

      res.json({ ok: true, sessionId: result.sessionId });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/permissions/:actionId/deny", (req, res) => {
    const { actionId } = req.params;
    if (!pendingPermissions) {
      return res.status(500).json({ error: "permissions not configured" });
    }

    const pending = pendingPermissions.get(actionId);
    if (!pending) {
      return res
        .status(404)
        .json({ error: "Permission request not found or expired" });
    }

    pendingPermissions.delete(actionId);
    broadcastEvent("permission-resolved", { actionId, status: "denied" });
    res.json({ ok: true });
  });

  // --- Schedules API ---

  app.get("/api/schedules", (_req, res) => {
    const all = schedules.all();
    const list = Object.entries(all).map(([id, s]) => ({ id, ...s }));
    res.json(list);
  });

  app.post("/api/schedules", (req, res) => {
    const { sourceChannel, outputChannel, command, args, intervalMinutes, enabled } = req.body;
    if (!sourceChannel || !outputChannel || !command) {
      return res.status(400).json({ error: "sourceChannel, outputChannel, and command are required" });
    }
    const id = uuidv4();
    const schedule = {
      sourceChannel,
      outputChannel,
      command,
      args: args || "",
      intervalMinutes: intervalMinutes || 5,
      enabled: enabled !== false,
      lastRun: null,
    };
    schedules.set(id, schedule);
    broadcastEvent("schedule-update", { id, schedule });
    res.json({ id, ...schedule });
  });

  app.put("/api/schedules/:id", (req, res) => {
    const existing = schedules.get(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: "Schedule not found" });
    }
    const updated = { ...existing, ...req.body };
    delete updated.id;
    schedules.set(req.params.id, updated);
    broadcastEvent("schedule-update", { id: req.params.id, schedule: updated });
    res.json({ id: req.params.id, ...updated });
  });

  app.delete("/api/schedules/:id", (req, res) => {
    schedules.remove(req.params.id);
    broadcastEvent("schedule-update", { id: req.params.id, deleted: true });
    res.json({ ok: true });
  });

  // --- Direct Chat ---

  app.post("/api/chat", (req, res) => {
    const { prompt, sessionId: existingSessionId, cwd } = req.body;
    if (!prompt) {
      return res.status(400).json({ error: "prompt is required" });
    }

    const sessionId = existingSessionId || uuidv4();
    const isResume = !!existingSessionId;

    // Log user message
    history.append(sessionId, {
      role: "user",
      text: prompt,
      source: "dashboard",
    });

    // Send sessionId immediately
    res.json({ sessionId });

    // Broadcast that sessions list should refresh
    broadcastEvent("session-update", { sessionId });

    // Spawn Claude in background with streaming
    const runOpts = {
      prompt,
      context: DASHBOARD_CONTEXT,
      onEvent: (event) => {
        if (event.type === "assistant") {
          // Partial text from assistant
          sendSSE(sessionId, "thinking", { sessionId });
        } else if (event.type === "result") {
          const text = event.result || "";
          const resolvedSessionId = event.session_id || sessionId;

          if (event.is_error) {
            history.append(resolvedSessionId, {
              role: "error",
              text,
              source: "dashboard",
            });
            sendSSE(sessionId, "error", {
              error: text,
              sessionId: resolvedSessionId,
            });
          } else {
            history.append(resolvedSessionId, {
              role: "assistant",
              text,
              source: "dashboard",
            });
            sendSSE(sessionId, "message", {
              text,
              sessionId: resolvedSessionId,
            });
          }
          sendSSE(sessionId, "done", { sessionId: resolvedSessionId });
          broadcastEvent("session-update", { sessionId: resolvedSessionId });
        } else if (event.type === "error") {
          history.append(sessionId, {
            role: "error",
            text: event.error,
            source: "dashboard",
          });
          sendSSE(sessionId, "error", { error: event.error, sessionId });
          sendSSE(sessionId, "done", { sessionId });
          broadcastEvent("session-update", { sessionId });
        }
      },
    };

    if (isResume) {
      runOpts.resume = existingSessionId;
    } else {
      runOpts.sessionId = sessionId;
    }

    if (cwd) runOpts.cwd = cwd;

    claude.runStreaming(runOpts);
  });

  app.get("/api/chat/:sessionId/stream", (req, res) => {
    const { sessionId } = req.params;

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write("\n");

    if (!sseClients.has(sessionId)) {
      sseClients.set(sessionId, new Set());
    }
    sseClients.get(sessionId).add(res);

    req.on("close", () => {
      const clients = sseClients.get(sessionId);
      if (clients) {
        clients.delete(res);
        if (clients.size === 0) sseClients.delete(sessionId);
      }
    });
  });

  // SPA fallback (Express 5 requires named wildcard)
  app.get("/{*path}", (_req, res) => {
    res.sendFile(path.join(__dirname, "..", "public", "index.html"));
  });

  return app;
}

module.exports = { create, broadcastEvent };
