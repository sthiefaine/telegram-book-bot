const axios = require("axios");

const prowlarr = axios.create({
  baseURL: process.env.PROWLARR_URL || "http://prowlarr:9696",
  headers: {
    "X-Api-Key": process.env.PROWLARR_API_KEY,
  },
  timeout: 20000,
});

function guessExt(item) {
  const title = (item.title || "").toLowerCase();
  for (const ext of ["epub", "pdf", "mobi", "azw3"]) {
    if (title.includes(ext)) return ext;
  }
  return "epub";
}

function formatSize(bytes) {
  if (!bytes) return "N/A";
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${sizes[i]}`;
}

async function searchBooks(query) {
  if (!process.env.PROWLARR_URL) return [];

  try {
    const { data } = await prowlarr.get("/api/v1/search", {
      params: {
        query,
        "categories[]": ["7000", "7020"],
        type: "search",
      },
    });

    return data.map((item) => {
      const dlUrl = item.downloadUrl || "";
      const magnet = item.magnetUrl || "";
      const isTorrent =
        dlUrl.endsWith(".torrent") ||
        !!magnet ||
        (item.downloadProtocol || "").toLowerCase() === "torrent";

      return {
        source: "prowlarr",
        title: item.title || "",
        author: "",
        ext: guessExt(item),
        sizeBytes: item.size || 0,
        size: formatSize(item.size),
        seeders: item.seeders || 0,
        leechers: item.leechers || 0,
        indexer: item.indexer,
        indexerId: item.indexerId || 0,
        guid: item.guid || "",
        downloadUrl: dlUrl,
        infoUrl: item.infoUrl,
        magnetUrl: magnet,
        isTorrent,
      };
    });
  } catch (error) {
    console.error("Prowlarr search error:", error.message);
    return [];
  }
}

async function grab(indexerId, guid) {
  try {
    const resp = await prowlarr.post("/api/v1/download", {
      guid,
      indexerId,
    });
    console.log(`Prowlarr grab successful for guid=${guid}`);
    return resp.data;
  } catch (error) {
    console.error("Prowlarr grab failed:", error.message);
    throw error;
  }
}

module.exports = { searchBooks, grab, formatSize };
