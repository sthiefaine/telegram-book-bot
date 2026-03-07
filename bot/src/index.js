require("dotenv").config();
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Telegraf, Markup } = require("telegraf");
const { searchBooks } = require("./prowlarr");
const annaArchive = require("./annaArchive");
const { downloadResult } = require("./downloader");

// Config
const MAX_RESULTS = 10;
const MAX_QUERY_LENGTH = 200;
const RATE_LIMIT_SECONDS = 5;
const LOCAL_API_SERVER = (process.env.LOCAL_API_SERVER || "").replace(/\/+$/, "");
const MAX_FILE_SIZE = LOCAL_API_SERVER ? 400 * 1024 * 1024 : 50 * 1024 * 1024;

// Whitelist
const ALLOWED_USER_IDS = new Set();
for (const uid of (process.env.ALLOWED_USER_IDS || "").split(",")) {
  const trimmed = uid.trim();
  if (trimmed) {
    const num = parseInt(trimmed);
    if (!isNaN(num)) ALLOWED_USER_IDS.add(num);
    else console.warn(`ALLOWED_USER_IDS: ignoring non-numeric value "${trimmed}"`);
  }
}

// Bot setup
const botOptions = {};
if (LOCAL_API_SERVER) {
  botOptions.telegram = {
    apiRoot: LOCAL_API_SERVER,
  };
  console.log(`Local Bot API mode: ${LOCAL_API_SERVER} (limit ${Math.floor(MAX_FILE_SIZE / 1024 / 1024)} MB)`);
}

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN, botOptions);

// Per-user state
const userState = new Map();

function getUserState(userId) {
  if (!userState.has(userId)) {
    userState.set(userId, { results: [], lastSearchAt: 0, activeDlAbort: null });
  }
  return userState.get(userId);
}

// Whitelist middleware
bot.use((ctx, next) => {
  if (ALLOWED_USER_IDS.size === 0) return next();
  const uid = ctx.from?.id;
  if (uid && ALLOWED_USER_IDS.has(uid)) return next();
});

function fmtSize(bytes) {
  if (!bytes) return "?";
  if (bytes < 1024 * 1024) return `${Math.floor(bytes / 1024)} Ko`;
  return `${(bytes / 1024 / 1024).toFixed(1)} Mo`;
}

function progressBar(pct) {
  const filled = Math.floor(pct / 10);
  return "▰".repeat(filled) + "▱".repeat(10 - filled);
}

// /start
bot.start((ctx) => {
  ctx.reply(
    "👋 Bonjour ! Envoie-moi le titre d'un livre et je le chercherai pour toi.\n\n" +
    "Je cherche sur Anna's Archive et Prowlarr. " +
    "Tu pourras ensuite choisir le résultat à télécharger."
  );
});

// /help
bot.help((ctx) => {
  ctx.reply(
    "📖 Commandes disponibles :\n\n" +
    "/start - Message de bienvenue\n" +
    "/help - Afficher cette aide\n\n" +
    "Envoie simplement le titre d'un livre pour lancer une recherche."
  );
});

// Search handler
async function handleSearch(ctx) {
  const query = ctx.message.text.replace(/^\/search\s*/, "").trim();
  if (!query) {
    return ctx.reply("❌ Envoie-moi le titre d'un livre à rechercher.");
  }

  if (query.length > MAX_QUERY_LENGTH) {
    return ctx.reply(`❌ Requête trop longue (max ${MAX_QUERY_LENGTH} caractères).`);
  }

  const state = getUserState(ctx.from.id);
  const now = Date.now() / 1000;
  if (now - state.lastSearchAt < RATE_LIMIT_SECONDS) {
    return ctx.reply(`⏳ Attends ${RATE_LIMIT_SECONDS} secondes entre deux recherches.`);
  }
  state.lastSearchAt = now;

  const searchMsg = await ctx.reply("🔍 Recherche en cours...");

  try {
    // Search Anna's Archive and Prowlarr in parallel
    const [aaResults, prResults] = await Promise.all([
      safeSearch(() => annaArchive.search(query), "Anna's Archive"),
      safeSearch(() => searchBooks(query), "Prowlarr"),
    ]);

    console.log(`=== Results for "${query}" ===`);
    console.log(`Anna's Archive (${aaResults.length}), Prowlarr (${prResults.length})`);

    // Merge: epub first, direct before torrents
    const direct = [...aaResults, ...prResults].filter((r) => !r.is_torrent);
    const torrents = prResults.filter((r) => r.is_torrent);

    direct.sort((a, b) => {
      const extA = a.ext === "epub" ? 0 : 1;
      const extB = b.ext === "epub" ? 0 : 1;
      if (extA !== extB) return extA - extB;
      const torA = a.is_torrent ? 1 : 0;
      const torB = b.is_torrent ? 1 : 0;
      return torA - torB;
    });

    const allResults = [...direct, ...torrents];

    // Filter oversized
    const filtered = allResults.filter((r) => !(r.size_bytes > MAX_FILE_SIZE));

    // Deduplicate by normalized title (first 35 chars)
    const seenTitles = new Set();
    const results = [];
    for (const r of filtered) {
      const norm = (r.title || "").replace(/[^\w]/g, "").toLowerCase().slice(0, 35);
      if (norm && seenTitles.has(norm)) continue;
      if (norm) seenTitles.add(norm);
      results.push(r);
      if (results.length >= MAX_RESULTS) break;
    }

    if (results.length === 0) {
      return ctx.telegram.editMessageText(
        ctx.chat.id,
        searchMsg.message_id,
        undefined,
        `😕 Aucun résultat trouvé pour « ${query} ».\nEssaie un autre titre ou orthographe.`
      );
    }

    state.results = results;

    // Check epub availability
    const hasEpub = results.some((r) => r.ext === "epub");
    const nonEpubResults = results.filter((r) => r.ext !== "epub");

    // If no epub, ask confirmation
    if (!hasEpub && nonEpubResults.length > 0) {
      const exts = [...new Set(nonEpubResults.map((r) => (r.ext || "?").toUpperCase()))];
      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback(`✅ Oui, envoie-moi en ${exts.join(", ")}`, "confirm_non_epub")],
        [Markup.button.callback("❌ Non, annuler", "cancel_search")],
      ]);
      return ctx.telegram.editMessageText(
        ctx.chat.id,
        searchMsg.message_id,
        undefined,
        `📚 Pas d'epub disponible pour « ${query} ».\n` +
        `J'ai trouvé ${results.length} résultat(s) en ${exts.join(", ")}. Ça ira ?`,
        keyboard
      );
    }

    // Build buttons
    const buttons = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.ext !== "epub" && hasEpub) continue;
      const icon = r.is_torrent ? "🌀" : "📥";
      const titleShort = r.title.length > 45 ? r.title.slice(0, 45) + "…" : r.title;
      let label = `${icon} ${titleShort}`;
      if (r.author) label += ` – ${r.author.slice(0, 20)}`;
      buttons.push([Markup.button.callback(label, `dl_${i}`)]);
    }

    const n = buttons.length;
    const keyboard = Markup.inlineKeyboard(buttons);

    await ctx.telegram.editMessageText(
      ctx.chat.id,
      searchMsg.message_id,
      undefined,
      `📚 ${n} résultat${n > 1 ? "s" : ""} trouvé${n > 1 ? "s" : ""} :`,
      keyboard
    );
  } catch (error) {
    console.error("Search error:", error);
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      searchMsg.message_id,
      undefined,
      "❌ Erreur lors de la recherche."
    );
  }
}

async function safeSearch(fn, name) {
  try {
    return await fn();
  } catch (e) {
    console.warn(`${name} search error: ${e.message}`);
    return [];
  }
}

// /search command
bot.command("search", handleSearch);

// Plain text = search
bot.on("text", (ctx) => {
  if (ctx.message.text.startsWith("/")) return;
  return handleSearch(ctx);
});

// Confirm non-epub
bot.action("confirm_non_epub", async (ctx) => {
  await ctx.answerCbQuery();
  const state = getUserState(ctx.from.id);
  const results = state.results;
  if (!results.length) {
    return ctx.editMessageText("❌ Résultat expiré, refais une recherche.");
  }

  const buttons = results.map((r, i) => {
    const icon = r.is_torrent ? "🌀" : "📥";
    const titleShort = (r.title || "?").slice(0, 40);
    const ext = (r.ext || "?").toUpperCase();
    const size = fmtSize(r.size_bytes);
    return [Markup.button.callback(`${icon} ${titleShort} — ${ext} — ${size}`, `dl_${i}`)];
  });

  await ctx.editMessageText("📚 Choisis un résultat :", Markup.inlineKeyboard(buttons));
});

// Cancel search
bot.action("cancel_search", async (ctx) => {
  await ctx.answerCbQuery();
  const state = getUserState(ctx.from.id);
  state.results = [];
  await ctx.editMessageText("🔍 Recherche annulée. Envoie un nouveau titre quand tu veux !");
});

// Cancel download
bot.action("cancel_dl", async (ctx) => {
  await ctx.answerCbQuery();
  const state = getUserState(ctx.from.id);
  if (state.activeDlAbort) {
    state.activeDlAbort.abort();
    state.activeDlAbort = null;
    await ctx.editMessageText("⛔ Téléchargement annulé.");
  } else {
    await ctx.editMessageText("⛔ Aucun téléchargement en cours.");
  }
});

// Download handler
bot.action(/dl_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const index = parseInt(ctx.match[1]);
  const state = getUserState(ctx.from.id);
  const results = state.results;

  if (!results.length || index >= results.length) {
    return ctx.editMessageText("❌ Résultat expiré, refais une recherche.");
  }

  const cancelKb = Markup.inlineKeyboard([
    [Markup.button.callback("⛔ Annuler", "cancel_dl")],
  ]);

  const abortController = new AbortController();
  state.activeDlAbort = abortController;

  let filePath = null;

  try {
    for (let i = index; i < results.length; i++) {
      if (abortController.signal.aborted) return;

      const result = results[i];
      const title = result.title || "livre";
      const ext = result.ext || "epub";

      if (i > index) {
        console.log(`Auto-retry on result ${i}: "${title}"`);
        await ctx.editMessageText(`🔄 Essai du résultat suivant : « ${title} »...`, cancelKb);
      }

      if (result.is_torrent) {
        await ctx.editMessageText(
          `🌀 Envoi vers le client torrent pour « ${title} »...\n⏳ Surveillance du dossier...`,
          cancelKb
        );
      } else {
        await ctx.editMessageText("⏳ Recherche du fichier...", cancelKb);
      }

      const onProgress = async (downloaded, total) => {
        if (abortController.signal.aborted) return;
        try {
          if (total) {
            const pct = Math.min(Math.floor((downloaded / total) * 100), 99);
            await ctx.editMessageText(
              `⬇️ « ${title} »\n${progressBar(pct)} ${pct}%  (${fmtSize(downloaded)} / ${fmtSize(total)})`,
              cancelKb
            );
          } else {
            await ctx.editMessageText(
              `⬇️ « ${title} »\n${fmtSize(downloaded)} téléchargés…`,
              cancelKb
            );
          }
        } catch {}
      };

      try {
        filePath = await downloadResult(
          result,
          result.is_torrent ? null : onProgress,
          MAX_FILE_SIZE
        );
      } catch (e) {
        console.warn(`Result ${i} failed (${e.message}), skipping`);
        filePath = null;
        continue;
      }

      if (!filePath) continue;

      // Check file size
      try {
        const stats = fs.statSync(filePath);
        if (stats.size > MAX_FILE_SIZE) {
          console.log(`Result ${i} too large (${fmtSize(stats.size)}), skipping`);
          try { fs.unlinkSync(filePath); } catch {}
          filePath = null;
          continue;
        }
      } catch {
        filePath = null;
        continue;
      }

      // Send the file
      const safeTitle = title.replace(/[^\w\s\-]/g, "").trim().slice(0, 60) || "livre";
      const filename = `${safeTitle}.${ext}`;

      await ctx.editMessageText(`📤 Envoi de « ${title} »...`);

      try {
        await ctx.replyWithDocument(
          { source: filePath, filename },
          { caption: `📖 ${title}` }
        );
        await ctx.editMessageText("✅ Envoyé ! Bonne lecture 📖");
      } finally {
        if (filePath && filePath.startsWith(os.tmpdir())) {
          try { fs.unlinkSync(filePath); } catch {}
        }
        filePath = null;
      }

      state.activeDlAbort = null;
      return;
    }

    await ctx.editMessageText(
      "😕 Aucun résultat disponible dans la limite de taille.\nRefais une recherche."
    );
  } catch (e) {
    if (abortController.signal.aborted) return;
    console.error("Download error:", e);
    try {
      await ctx.editMessageText("❌ Erreur lors du téléchargement. Réessaie.");
    } catch {}
  } finally {
    state.activeDlAbort = null;
    if (filePath && filePath.startsWith(os.tmpdir())) {
      try { fs.unlinkSync(filePath); } catch {}
    }
  }
});

// Cleanup orphaned temp files on startup
function cleanupTempFiles() {
  try {
    const tmpDir = os.tmpdir();
    const files = fs.readdirSync(tmpDir).filter((f) => f.startsWith("bookbot_"));
    for (const f of files) {
      try { fs.unlinkSync(path.join(tmpDir, f)); } catch {}
    }
    if (files.length) console.log(`Cleaned up ${files.length} orphaned temp file(s)`);
  } catch {}
}

// Error handling
bot.catch((err, ctx) => {
  console.error(`Bot error for ${ctx.updateType}:`, err);
});

// Start
cleanupTempFiles();
console.log("Bot starting...");
bot.launch({ dropPendingUpdates: true }).then(() => {
  console.log("🤖 Bot started successfully!");
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
