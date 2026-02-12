const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const PROJECTS_PATH = path.join(DATA_DIR, "projects.json");

let projects = {};
let writeQueued = false;

function load() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(PROJECTS_PATH)) {
      projects = JSON.parse(fs.readFileSync(PROJECTS_PATH, "utf-8"));
    }
  } catch (err) {
    console.error("Failed to load projects, starting fresh:", err.message);
    projects = {};
  }
}

function save() {
  if (writeQueued) return;
  writeQueued = true;
  process.nextTick(() => {
    writeQueued = false;
    try {
      fs.writeFileSync(PROJECTS_PATH, JSON.stringify(projects, null, 2));
    } catch (err) {
      console.error("Failed to save projects:", err.message);
    }
  });
}

function set(channelId, dirPath, userId) {
  const resolved = path.resolve(dirPath);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`Not a valid directory: ${resolved}`);
  }
  const now = new Date().toISOString();
  projects[channelId] = {
    path: resolved,
    setBy: userId || null,
    createdAt: projects[channelId]?.createdAt || now,
    lastUsed: now,
  };
  save();
}

function get(channelId) {
  const entry = projects[channelId];
  if (entry) {
    entry.lastUsed = new Date().toISOString();
    save();
  }
  return entry?.path || null;
}

function remove(channelId) {
  delete projects[channelId];
  save();
}

function all() {
  return { ...projects };
}

load();

module.exports = { set, get, remove, all };
