const fs = require("fs");
const path = require("path");

const BOOK_EXTENSIONS = new Set([".epub", ".pdf", ".mobi", ".azw3", ".azw", ".fb2"]);

function normalize(text) {
  const cleaned = text.toLowerCase().replace(/[^\w\s]/g, " ");
  return new Set(cleaned.split(/\s+/).filter((w) => w.length > 3));
}

function matches(filename, titleWords) {
  const fileWords = normalize(path.parse(filename).name);
  if (!titleWords.size) return false;
  let overlap = 0;
  for (const w of titleWords) {
    if (fileWords.has(w)) overlap++;
  }
  return overlap >= Math.max(1, Math.floor(titleWords.size / 2));
}

function isBookFile(filename) {
  return BOOK_EXTENSIONS.has(path.extname(filename).toLowerCase());
}

async function waitForFile(title, downloadPath, timeoutMinutes = 15) {
  const titleWords = normalize(title);
  const timeoutMs = timeoutMinutes * 60 * 1000;

  let existing;
  try {
    existing = new Set(fs.readdirSync(downloadPath));
  } catch {
    existing = new Set();
  }

  console.log(
    `Watching ${downloadPath} for "${title}" (timeout=${timeoutMinutes}min, keywords=${[...titleWords].join(",")})`
  );

  return new Promise((resolve, reject) => {
    let watcher;
    let pollInterval;
    const timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error(`File not found for "${title}" in ${downloadPath} after ${timeoutMinutes} minutes.`));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timeoutId);
      if (watcher) { try { watcher.close(); } catch {} }
      if (pollInterval) clearInterval(pollInterval);
    }

    function checkNewFiles() {
      let current;
      try {
        current = new Set(fs.readdirSync(downloadPath));
      } catch {
        return;
      }

      for (const fname of current) {
        if (existing.has(fname)) continue;
        if (!isBookFile(fname)) continue;
        if (matches(fname, titleWords)) {
          const fullPath = path.join(downloadPath, fname);
          console.log(`Found matching file: ${fullPath}`);
          cleanup();
          resolve(fullPath);
          return;
        }
      }
    }

    // Try fs.watch first, with polling fallback
    try {
      fs.mkdirSync(downloadPath, { recursive: true });
      watcher = fs.watch(downloadPath, (eventType, filename) => {
        if (eventType === "rename" && filename && isBookFile(filename) && !existing.has(filename)) {
          if (matches(filename, titleWords)) {
            const fullPath = path.join(downloadPath, filename);
            console.log(`Found matching file (watch): ${fullPath}`);
            cleanup();
            resolve(fullPath);
          }
        }
      });
      watcher.on("error", () => {
        // Fallback to polling on watch error
        if (watcher) { try { watcher.close(); } catch {} watcher = null; }
      });
    } catch {
      // fs.watch not available, polling only
    }

    // Polling fallback (every 10s) in case fs.watch misses events
    pollInterval = setInterval(checkNewFiles, 10000);
  });
}

module.exports = { waitForFile };
