const fs = require("fs");
const os = require("os");
const path = require("path");
const { URL } = require("url");
const net = require("net");
const annaArchive = require("./annaArchive");
const { grab } = require("./prowlarr");
const { waitForFile } = require("./watcher");

const VALID_CONTENT_TYPES = new Set([
  "application/epub+zip",
  "application/pdf",
  "application/x-mobipocket-ebook",
  "application/octet-stream",
]);
const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
};

function isSafeUrl(url) {
  return annaArchive.isSafeUrl(url);
}

function sanitizeExt(ext) {
  return annaArchive.sanitizeExt(ext);
}

async function downloadResult(result, progressCallback, maxBytes = 0) {
  const { source } = result;

  if (source === "anna") {
    return annaArchive.download(result.md5, result.ext, progressCallback, maxBytes);
  }

  if (source === "prowlarr") {
    if (result.is_torrent) {
      return downloadTorrent(result);
    }
    return downloadDirect(result.downloadUrl, result.ext, progressCallback, maxBytes);
  }

  throw new Error(`Unknown source: ${source}`);
}

async function downloadDirect(url, ext, progressCallback, maxBytes = 0) {
  if (!isSafeUrl(url)) throw new Error("URL rejected (SSRF protection)");
  ext = sanitizeExt(ext);

  const resp = await fetch(url, {
    headers: HEADERS,
    signal: AbortSignal.timeout(60000),
    redirect: "follow",
  });

  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

  const ctype = (resp.headers.get("content-type") || "").split(";")[0].trim();
  if (ctype && !VALID_CONTENT_TYPES.has(ctype)) {
    throw new Error(`Unexpected content-type: ${ctype}`);
  }

  const total = parseInt(resp.headers.get("content-length") || "0");
  let downloaded = 0;
  let lastReport = 0;
  let lastPct = -1;
  const suffix = ext ? `.${ext}` : ".epub";
  const tmpPath = path.join(
    os.tmpdir(),
    `bookbot_${Date.now()}_${Math.random().toString(36).slice(2)}${suffix}`
  );

  try {
    const fileStream = fs.createWriteStream(tmpPath);
    const reader = resp.body.getReader();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      fileStream.write(value);
      downloaded += value.length;

      if (maxBytes && downloaded > maxBytes) {
        fileStream.close();
        fs.unlinkSync(tmpPath);
        throw new Error(`File too large (>${Math.floor(maxBytes / 1024 / 1024)} MB)`);
      }

      if (progressCallback) {
        const now = Date.now();
        const pct = total ? Math.floor((downloaded / total) * 100) : 0;
        if (now - lastReport >= 2000 && pct !== lastPct) {
          lastReport = now;
          lastPct = pct;
          try {
            await progressCallback(downloaded, total);
          } catch {}
        }
      }
    }

    await new Promise((resolve, reject) => {
      fileStream.on("finish", resolve);
      fileStream.on("error", reject);
      fileStream.end();
    });

    return tmpPath;
  } catch (e) {
    try { fs.unlinkSync(tmpPath); } catch {}
    throw e;
  }
}

async function downloadTorrent(result) {
  const downloadPath = process.env.BOOKS_DOWNLOAD_PATH || "/downloads/books";
  const timeoutMinutes = parseInt(process.env.DOWNLOAD_TIMEOUT_MINUTES || "15");

  await grab(result.indexer_id, result.guid);
  return waitForFile(result.title, downloadPath, timeoutMinutes);
}

module.exports = { downloadResult };
