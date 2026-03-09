const fs = require("fs");
const path = require("path");
const os = require("os");

const PREFS_DIR = process.env.PREFS_DIR || path.join(process.cwd(), "data");
const PREFS_FILE = path.join(PREFS_DIR, "prefs.json");

const MAX_HISTORY = 20;
const MAX_FAVORITES = 50;

const DEFAULT_PREFS = {
  format: "epub",
  email: null,
  kindleEmail: null,
  delivery: "telegram", // "telegram" | "email" | "kindle"
  onboarded: false,
  history: [],
  favorites: [],
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

function addToHistory(userId, entry) {
  const key = String(userId);
  const prefs = getUserPrefs(userId);
  const item = { title: entry.title, author: entry.author || "", ext: entry.ext, source: entry.source, date: new Date().toISOString() };
  prefs.history = [item, ...prefs.history.slice(0, MAX_HISTORY - 1)];
  prefsCache[key] = prefs;
  savePrefs();
}

function addToFavorites(userId, entry) {
  const key = String(userId);
  const prefs = getUserPrefs(userId);
  // Avoid duplicates by title+ext
  const exists = prefs.favorites.some((f) => f.title === entry.title && f.ext === entry.ext);
  if (exists) return false;
  const item = { title: entry.title, author: entry.author || "", ext: entry.ext, source: entry.source, md5: entry.md5 || null, downloadUrl: entry.downloadUrl || null };
  prefs.favorites = [item, ...prefs.favorites.slice(0, MAX_FAVORITES - 1)];
  prefsCache[key] = prefs;
  savePrefs();
  return true;
}

function removeFromFavorites(userId, index) {
  const key = String(userId);
  const prefs = getUserPrefs(userId);
  if (index >= 0 && index < prefs.favorites.length) {
    prefs.favorites.splice(index, 1);
    prefsCache[key] = prefs;
    savePrefs();
    return true;
  }
  return false;
}

// Load on startup
loadPrefs();
console.log(`Prefs loaded: ${Object.keys(prefsCache).length} user(s)`);

module.exports = { getUserPrefs, setUserPrefs, deleteUserPrefs, addToHistory, addToFavorites, removeFromFavorites, DEFAULT_PREFS };
