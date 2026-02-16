const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");

const HISTORY_DIR = path.join(__dirname, "..", "data", "history");

// In-memory cache so consecutive appends see each other's data
const cache = new Map();
const writeQueued = new Set();

function ensureDir() {
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
}

function sessionPath(sessionId) {
  return path.join(HISTORY_DIR, `${sessionId}.json`);
}

function readSession(sessionId) {
  if (cache.has(sessionId)) return cache.get(sessionId);
  const fp = sessionPath(sessionId);
  let messages = [];
  try {
    if (fs.existsSync(fp)) {
      messages = JSON.parse(fs.readFileSync(fp, "utf-8"));
    }
  } catch (err) {
    console.error(`Failed to read history for ${sessionId}:`, err.message);
  }
  cache.set(sessionId, messages);
  return messages;
}

function saveSession(sessionId) {
  if (writeQueued.has(sessionId)) return;
  writeQueued.add(sessionId);
  process.nextTick(() => {
    writeQueued.delete(sessionId);
    const messages = cache.get(sessionId) || [];
    try {
      ensureDir();
      fs.writeFileSync(sessionPath(sessionId), JSON.stringify(messages, null, 2));
    } catch (err) {
      console.error(`Failed to save history for ${sessionId}:`, err.message);
    }
  });
}

function append(sessionId, { role, text, source, channel, threadTs }) {
  const messages = readSession(sessionId);
  messages.push({
    id: uuidv4(),
    sessionId,
    timestamp: new Date().toISOString(),
    role,
    text,
    source: source || "slack",
    channel: channel || null,
    threadTs: threadTs || null,
  });
  saveSession(sessionId);
}

function getSession(sessionId) {
  return [...readSession(sessionId)];
}

function listSessions() {
  ensureDir();
  const files = fs.readdirSync(HISTORY_DIR).filter((f) => f.endsWith(".json"));
  return files.map((f) => {
    const sessionId = f.replace(".json", "");
    const messages = readSession(sessionId);
    const last = messages[messages.length - 1];
    return {
      sessionId,
      messageCount: messages.length,
      lastActive: last ? last.timestamp : null,
      source: last ? last.source : null,
    };
  });
}

function clear(sessionId) {
  cache.delete(sessionId);
  const fp = sessionPath(sessionId);
  try {
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  } catch (err) {
    console.error(`Failed to clear history for ${sessionId}:`, err.message);
  }
}

module.exports = { append, getSession, listSessions, clear };
