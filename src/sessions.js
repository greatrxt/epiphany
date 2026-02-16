const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const SESSIONS_PATH = path.join(DATA_DIR, "sessions.json");

let sessions = {};
let writeQueued = false;

function makeKey(channelId, threadTs) {
  return threadTs ? `${channelId}:${threadTs}` : channelId;
}

function parseKey(key) {
  const idx = key.indexOf(":");
  if (idx === -1) return { channelId: key, threadTs: null };
  return { channelId: key.slice(0, idx), threadTs: key.slice(idx + 1) };
}

function load() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(SESSIONS_PATH)) {
      sessions = JSON.parse(fs.readFileSync(SESSIONS_PATH, "utf-8"));

      // Migrate old entries: plain channelId keys without channelId/threadTs fields
      for (const [key, entry] of Object.entries(sessions)) {
        if (!entry.channelId) {
          const { channelId, threadTs } = parseKey(key);
          entry.channelId = channelId;
          entry.threadTs = threadTs;
        }
      }
    }
  } catch (err) {
    console.error("Failed to load sessions, starting fresh:", err.message);
    sessions = {};
  }
}

function save() {
  if (writeQueued) return;
  writeQueued = true;
  process.nextTick(() => {
    writeQueued = false;
    try {
      fs.writeFileSync(SESSIONS_PATH, JSON.stringify(sessions, null, 2));
    } catch (err) {
      console.error("Failed to save sessions:", err.message);
    }
  });
}

function set(channelId, threadTs, sessionId) {
  const key = makeKey(channelId, threadTs);
  const now = new Date().toISOString();
  sessions[key] = {
    sessionId,
    channelId,
    threadTs: threadTs || null,
    createdAt: sessions[key]?.createdAt || now,
    lastUsed: now,
  };
  save();
}

function get(channelId, threadTs) {
  const key = makeKey(channelId, threadTs);
  const entry = sessions[key];
  if (entry) {
    entry.lastUsed = new Date().toISOString();
    save();
  }
  return entry?.sessionId || null;
}

function clear(channelId, threadTs) {
  const key = makeKey(channelId, threadTs);
  delete sessions[key];
  save();
}

function all() {
  return { ...sessions };
}

function getByChannel(channelId) {
  const results = {};
  for (const [key, entry] of Object.entries(sessions)) {
    const parsed = parseKey(key);
    if (parsed.channelId === channelId) {
      results[key] = entry;
    }
  }
  return results;
}

function getBySessionId(sessionId) {
  const results = [];
  for (const [key, entry] of Object.entries(sessions)) {
    if (entry.sessionId === sessionId) {
      results.push({ key, ...entry });
    }
  }
  return results;
}

load();

module.exports = { set, get, clear, all, getByChannel, getBySessionId, makeKey, parseKey };
