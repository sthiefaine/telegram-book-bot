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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  let elapsed = 0;
  const pollInterval = 5000;

  while (elapsed < timeoutMs) {
    await sleep(pollInterval);
    elapsed += pollInterval;

    let current;
    try {
      current = new Set(fs.readdirSync(downloadPath));
    } catch {
      continue;
    }

    for (const fname of current) {
      if (existing.has(fname)) continue;
      const ext = path.extname(fname).toLowerCase();
      if (!BOOK_EXTENSIONS.has(ext)) continue;
      if (matches(fname, titleWords)) {
        const fullPath = path.join(downloadPath, fname);
        console.log(`Found matching file: ${fullPath}`);
        return fullPath;
      }
    }
  }

  throw new Error(
    `File not found for "${title}" in ${downloadPath} after ${timeoutMinutes} minutes.`
  );
}

module.exports = { waitForFile };
