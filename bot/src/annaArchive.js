const fs = require("fs");
const os = require("os");
const path = require("path");
const { URL } = require("url");
const net = require("net");

let cheerio;
try {
  cheerio = require("cheerio");
} catch {
  cheerio = null;
}

let BASE_URL = (process.env.ANNA_ARCHIVE_URL || "").replace(/\/+$/, "");
const ANNA_MIRRORS = [
  "https://annas-archive.gd",
  "https://annas-archive.gl",
  "https://annas-archive.vg",
  "https://annas-archive.pk",
];
const URL_CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutes
let lastUrlCheck = 0;

const MD5_RE = /^[a-f0-9]{32}$/;
const MAX_HTML_SIZE = 5 * 1024 * 1024;
const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
};

async function resolveAnnaUrl() {
  const now = Date.now();
  if (BASE_URL && now - lastUrlCheck < URL_CHECK_INTERVAL) return;
  lastUrlCheck = now;

  // Test current URL first, then try mirrors
  const urlsToTry = BASE_URL
    ? [BASE_URL, ...ANNA_MIRRORS.filter((u) => u !== BASE_URL)]
    : ANNA_MIRRORS;

  for (const url of urlsToTry) {
    try {
      const resp = await fetch(`${url}/`, {
        method: "HEAD",
        headers: HEADERS,
        signal: AbortSignal.timeout(5000),
        redirect: "follow",
      });
      if (resp.ok || resp.status === 301 || resp.status === 302) {
        if (url !== BASE_URL) {
          console.log(`Anna's Archive URL updated: ${BASE_URL || "(none)"} → ${url}`);
          BASE_URL = url;
        }
        return;
      }
    } catch {
      // try next mirror
    }
  }
  console.warn("All Anna's Archive mirrors unreachable");
}

function sanitizeExt(ext) {
  const cleaned = (ext || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 10);
  return cleaned || "epub";
}

function isSafeUrl(url) {
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) return false;
    const host = parsed.hostname;
    if (!host || host === "localhost") return false;
    if (net.isIP(host)) {
      // Block private/loopback IPs
      const parts = host.split(".").map(Number);
      if (parts[0] === 127) return false;
      if (parts[0] === 10) return false;
      if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return false;
      if (parts[0] === 192 && parts[1] === 168) return false;
      if (parts[0] === 0) return false;
      if (host === "::1" || host === "0:0:0:0:0:0:0:1") return false;
    }
    return true;
  } catch {
    return false;
  }
}

function isTrustedUrl(url) {
  if (BASE_URL && url.startsWith(BASE_URL)) return true;
  return isSafeUrl(url);
}

function redactUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.search) parsed.search = "[redacted]";
    return parsed.toString();
  } catch {
    return "[url]";
  }
}

function parseSizeFromText(text) {
  const m = text.match(/([\d.,]+)\s*(MB|KB|GB|Mo|Ko|Go)/i);
  if (!m) return 0;
  const value = parseFloat(m[1].replace(",", "."));
  const unit = m[2].toUpperCase();
  if (unit === "KB" || unit === "KO") return Math.floor(value * 1024);
  if (unit === "MB" || unit === "MO") return Math.floor(value * 1024 * 1024);
  if (unit === "GB" || unit === "GO") return Math.floor(value * 1024 * 1024 * 1024);
  return 0;
}

async function search(query) {
  await resolveAnnaUrl();
  if (!BASE_URL) return [];

  const params = new URLSearchParams({
    q: query,
    lang: "",
    content: "book_any",
    ext: "epub,pdf,mobi",
    page: "1",
  });

  try {
    const resp = await fetch(`${BASE_URL}/search.json?${params}`, {
      headers: HEADERS,
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    return parseJson(data);
  } catch (e) {
    console.warn(`Anna's Archive JSON API failed: ${e.message}, trying HTML fallback`);
    return searchHtml(query);
  }
}

function parseJson(data) {
  const results = [];
  for (const item of data) {
    try {
      const md5 = item.md5 || (item.file && item.file.md5);
      if (!md5 || !MD5_RE.test(md5)) continue;
      const ext = (item.file && item.file.extension) || item.extension || "";
      const size = (item.file && item.file.filesize) || item.filesize || 0;
      results.push({
        source: "anna",
        title: item.title || "",
        author: item.author || "",
        ext: sanitizeExt(ext),
        sizeBytes: parseInt(size) || 0,
        md5,
        downloadUrl: `https://libgen.rocks/get.php?md5=${md5}`,
        isTorrent: false,
      });
    } catch (e) {
      // skip item
    }
  }
  return results;
}

async function searchHtml(query) {
  if (!cheerio) return [];
  try {
    const params = new URLSearchParams({
      q: query,
      lang: "",
      content: "book_any",
      ext: "epub,pdf,mobi",
    });
    const resp = await fetch(`${BASE_URL}/search?${params}`, {
      headers: HEADERS,
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) return [];
    const html = await resp.text();
    const $ = cheerio.load(html);
    const seenMd5 = new Map();

    $('a[href^="/md5/"]').each((_, el) => {
      const href = $(el).attr("href") || "";
      const md5 = href.split("/md5/").pop().split("?")[0].trim();
      if (!md5 || !MD5_RE.test(md5)) return;
      const text = $(el).text().trim();
      if (!text) return;

      if (seenMd5.has(md5)) {
        if (text.length > seenMd5.get(md5).title.length) {
          seenMd5.get(md5).title = text.slice(0, 120);
        }
        return;
      }

      let ext = "epub";
      for (const e of ["epub", "pdf", "mobi"]) {
        if (text.toLowerCase().includes(e)) { ext = e; break; }
      }

      seenMd5.set(md5, {
        source: "anna",
        title: text.slice(0, 120),
        author: "",
        ext: sanitizeExt(ext),
        sizeBytes: parseSizeFromText(text),
        md5,
        downloadUrl: `https://libgen.rocks/get.php?md5=${md5}`,
        isTorrent: false,
      });
      if (seenMd5.size >= 10) return false;
    });

    return Array.from(seenMd5.values());
  } catch (e) {
    console.error(`Anna's Archive HTML fallback failed: ${e.message}`);
    return [];
  }
}

function extractDownloadLink(html, sourceUrl) {
  if (!cheerio) return null;
  const $ = cheerio.load(html);
  for (const el of $("a[href]").toArray()) {
    const href = $(el).attr("href") || "";
    if (!href) continue;
    const lower = href.toLowerCase();
    if ([".epub", ".pdf", ".mobi", ".azw3", ".fb2"].some((ext) => lower.endsWith(ext))) {
      return href.startsWith("http") ? href : new URL(href, sourceUrl).toString();
    }
    if (lower.includes("get.php") && lower.includes("md5")) {
      return href.startsWith("http") ? href : new URL(href, sourceUrl).toString();
    }
  }
  return null;
}

async function getDownloadLinks(md5) {
  if (!cheerio) return [`${BASE_URL}/slow_download/${md5}/0/0`];

  const pageUrl = `${BASE_URL}/md5/${md5}`;
  try {
    const resp = await fetch(pageUrl, {
      headers: HEADERS,
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const html = await resp.text();
    const $ = cheerio.load(html);
    const links = [];

    $("a[href]").each((_, el) => {
      const href = $(el).attr("href") || "";
      const text = $(el).text().toLowerCase();
      const hasKeyword = ["download", "télécharger", "get", "mirror", "libgen", "lol"].some(
        (kw) => text.includes(kw)
      );
      if (
        href.startsWith("http") &&
        href.toLowerCase().includes(md5.toLowerCase()) &&
        isSafeUrl(href)
      ) {
        if (hasKeyword || true) links.push(href);
      }
    });

    links.push(`${BASE_URL}/slow_download/${md5}/0/0`);
    console.log(`Found ${links.length} download links for md5=${md5}`);
    return links;
  } catch (e) {
    console.warn(`Could not scrape book page for md5=${md5}: ${e.message}`);
    return [`${BASE_URL}/slow_download/${md5}/0/0`];
  }
}

async function streamToFile(url, ext, progressCallback, maxBytes) {
  if (!isTrustedUrl(url)) return null;

  try {
    const resp = await fetch(url, {
      headers: HEADERS,
      signal: AbortSignal.timeout(90000),
      redirect: "follow",
    });
    if (!resp.ok) return null;

    // Check Content-Length before streaming
    const contentLength = parseInt(resp.headers.get("content-length") || "0");
    if (maxBytes && contentLength > maxBytes) {
      console.log(`Skipping ${redactUrl(url)}: Content-Length ${contentLength} exceeds max ${maxBytes}`);
      return null;
    }

    const ctype = (resp.headers.get("content-type") || "").split(";")[0].trim();

    if (ctype.includes("text/html")) {
      // Read HTML to find real link
      const html = await resp.text();
      if (html.length > MAX_HTML_SIZE) return null;
      const realUrl = extractDownloadLink(html, url);
      if (realUrl && isSafeUrl(realUrl)) {
        console.log(`Found real link in HTML: ${redactUrl(realUrl)}`);
        return streamToFile(realUrl, ext, progressCallback, maxBytes);
      }
      return null;
    }

    return await saveResponseToFile(resp, ext, progressCallback, maxBytes);
  } catch (e) {
    console.warn(`Stream failed for ${redactUrl(url)}: ${e.message}`);
    return null;
  }
}

async function saveResponseToFile(resp, ext, progressCallback, maxBytes) {
  const total = parseInt(resp.headers.get("content-length") || "0");
  let downloaded = 0;
  let lastReport = 0;
  let lastPct = -1;
  const suffix = ext ? `.${ext}` : ".epub";
  const tmpPath = path.join(os.tmpdir(), `bookbot_${Date.now()}_${Math.random().toString(36).slice(2)}${suffix}`);

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

    if (downloaded < 1024) {
      fs.unlinkSync(tmpPath);
      return null;
    }

    return tmpPath;
  } catch (e) {
    try { fs.unlinkSync(tmpPath); } catch {}
    throw e;
  }
}

async function download(md5, ext, progressCallback, maxBytes = 0) {
  ext = sanitizeExt(ext);
  const links = await getDownloadLinks(md5);

  for (const url of links) {
    if (url.includes(".onion") || !isTrustedUrl(url)) continue;
    console.log(`Trying download URL: ${redactUrl(url)}`);
    try {
      const result = await streamToFile(url, ext, progressCallback, maxBytes);
      if (result) {
        console.log(`Downloaded from ${redactUrl(url)}`);
        return result;
      }
    } catch (e) {
      console.warn(`URL ${redactUrl(url)} failed: ${e.message}`);
    }
  }

  throw new Error(`All mirrors failed for md5=${md5}`);
}

module.exports = { search, download, sanitizeExt, isSafeUrl };
