const fs = require("fs");
const path = require("path");
const os = require("os");

const PREFS_DIR = process.env.PREFS_DIR || path.join(process.cwd(), "data");
const PREFS_FILE = path.join(PREFS_DIR, "prefs.json");

const DEFAULT_PREFS = {
  format: "epub",
  email: null,
  kindleEmail: null,
  delivery: "telegram", // "telegram" | "email" | "kindle"
  onboarded: false,
};

let prefsCache = {};

function loadPrefs() {
  try {
    if (!fs.existsSync(PREFS_DIR)) {
      fs.mkdirSync(PREFS_DIR, { recursive: true });
    }
    if (fs.existsSync(PREFS_FILE)) {
      const data = fs.readFileSync(PREFS_FILE, "utf8");
      prefsCache = JSON.parse(data);
    }
  } catch (e) {
    console.error("Failed to load prefs:", e.message);
    prefsCache = {};
  }
}

function savePrefs() {
  try {
    if (!fs.existsSync(PREFS_DIR)) {
      fs.mkdirSync(PREFS_DIR, { recursive: true });
    }
    const tmpFile = path.join(PREFS_DIR, `prefs_${Date.now()}.tmp`);
    fs.writeFileSync(tmpFile, JSON.stringify(prefsCache, null, 2));
    fs.renameSync(tmpFile, PREFS_FILE);
  } catch (e) {
    console.error("Failed to save prefs:", e.message);
  }
}

function getUserPrefs(userId) {
  const key = String(userId);
  if (!prefsCache[key]) {
    prefsCache[key] = { ...DEFAULT_PREFS };
  }
  return { ...DEFAULT_PREFS, ...prefsCache[key] };
}

function setUserPrefs(userId, updates) {
  const key = String(userId);
  prefsCache[key] = { ...getUserPrefs(userId), ...updates };
  savePrefs();
  return prefsCache[key];
}

function deleteUserPrefs(userId) {
  delete prefsCache[String(userId)];
  savePrefs();
}

// Load on startup
loadPrefs();
console.log(`Prefs loaded: ${Object.keys(prefsCache).length} user(s)`);

module.exports = { getUserPrefs, setUserPrefs, deleteUserPrefs, DEFAULT_PREFS };
