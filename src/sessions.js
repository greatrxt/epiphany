const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const SESSIONS_PATH = path.join(DATA_DIR, "sessions.json");

let sessions = {};
let writeQueued = false;

function load() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(SESSIONS_PATH)) {
      sessions = JSON.parse(fs.readFileSync(SESSIONS_PATH, "utf-8"));
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

function set(channelId, sessionId) {
  const now = new Date().toISOString();
  sessions[channelId] = {
    sessionId,
    createdAt: sessions[channelId]?.createdAt || now,
    lastUsed: now,
  };
  save();
}

function get(channelId) {
  const entry = sessions[channelId];
  if (entry) {
    entry.lastUsed = new Date().toISOString();
    save();
  }
  return entry?.sessionId || null;
}

function clear(channelId) {
  delete sessions[channelId];
  save();
}

function all() {
  return { ...sessions };
}

load();

module.exports = { set, get, clear, all };
