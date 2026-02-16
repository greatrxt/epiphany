const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const SCHEDULES_PATH = path.join(DATA_DIR, "schedules.json");

let schedules = {};
let writeQueued = false;

function load() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(SCHEDULES_PATH)) {
      schedules = JSON.parse(fs.readFileSync(SCHEDULES_PATH, "utf-8"));
    }
  } catch (err) {
    console.error("Failed to load schedules, starting fresh:", err.message);
    schedules = {};
  }
}

function save() {
  if (writeQueued) return;
  writeQueued = true;
  process.nextTick(() => {
    writeQueued = false;
    try {
      fs.writeFileSync(SCHEDULES_PATH, JSON.stringify(schedules, null, 2));
    } catch (err) {
      console.error("Failed to save schedules:", err.message);
    }
  });
}

function all() {
  return { ...schedules };
}

function get(id) {
  return schedules[id] || null;
}

function set(id, data) {
  schedules[id] = data;
  save();
}

function remove(id) {
  delete schedules[id];
  save();
}

load();

module.exports = { all, get, set, remove };
