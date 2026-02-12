const path = require("path");
const { v4: uuidv4 } = require("uuid");

const DASHBOARD_CONTEXT = [
  "You are being used through a web dashboard interface.",
  "The user is chatting with you from a local web UI.",
  "Your responses will be displayed in a web chat interface (markdown formatting works).",
  "You cannot open files, URLs, or images in a browser/viewer for the user.",
  "If the user asks to see something, output the content as text in your response.",
].join(" ");

// In-memory SSE connections: sessionId -> Set<Response>
const sseClients = new Map();

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

function create({ sessions, projects, history, claude }) {
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

    for (const [channelId, entry] of Object.entries(allSessions)) {
      const sid = entry.sessionId;
      seen.add(sid);
      const h = historyMap[sid] || {};
      const projectEntry = projects.all()[channelId];
      merged.push({
        sessionId: sid,
        channelId,
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
            sendSSE(sessionId, "error", { error: text, sessionId: resolvedSessionId });
          } else {
            history.append(resolvedSessionId, {
              role: "assistant",
              text,
              source: "dashboard",
            });
            sendSSE(sessionId, "message", { text, sessionId: resolvedSessionId });
          }
          sendSSE(sessionId, "done", { sessionId: resolvedSessionId });
        } else if (event.type === "error") {
          history.append(sessionId, {
            role: "error",
            text: event.error,
            source: "dashboard",
          });
          sendSSE(sessionId, "error", { error: event.error, sessionId });
          sendSSE(sessionId, "done", { sessionId });
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

module.exports = { create };
