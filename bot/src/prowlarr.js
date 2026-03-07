const axios = require("axios");

const prowlarr = axios.create({
  baseURL: process.env.PROWLARR_URL || "http://prowlarr:9696",
  headers: {
    "X-Api-Key": process.env.PROWLARR_API_KEY,
  },
});

/**
 * Search for books on Prowlarr
 * @param {string} query - Search query
 * @returns {Promise<Array>} - Array of results
 */
async function searchBooks(query) {
  try {
    const { data } = await prowlarr.get("/api/v1/search", {
      params: {
        query,
        type: "book",
      },
    });

    // Sort by seeders (best sources first) and limit to 10
    return data
      .sort((a, b) => (b.seeders || 0) - (a.seeders || 0))
      .slice(0, 10)
      .map((result) => ({
        title: result.title,
        size: formatSize(result.size),
        seeders: result.seeders || 0,
        leechers: result.leechers || 0,
        indexer: result.indexer,
        downloadUrl: result.downloadUrl,
        infoUrl: result.infoUrl,
        guid: result.guid,
      }));
  } catch (error) {
    console.error("Prowlarr search error:", error.message);
    throw new Error("Erreur lors de la recherche sur Prowlarr");
  }
}

/**
 * Get download link for a specific result
 * @param {string} guid - Result GUID
 * @returns {Promise<string>} - Download URL
 */
async function getDownloadLink(guid) {
  try {
    const { data } = await prowlarr.get("/api/v1/search", {
      params: { query: guid },
    });
    const result = data.find((r) => r.guid === guid);
    return result?.downloadUrl || null;
  } catch (error) {
    console.error("Prowlarr download error:", error.message);
    throw new Error("Erreur lors de la récupération du lien");
  }
}

function formatSize(bytes) {
  if (!bytes) return "N/A";
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${sizes[i]}`;
}

module.exports = { searchBooks, getDownloadLink };
