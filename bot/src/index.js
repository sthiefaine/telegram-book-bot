require("dotenv").config();
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Telegraf, Markup } = require("telegraf");
const { searchBooks } = require("./prowlarr");
const annaArchive = require("./annaArchive");
const { downloadResult } = require("./downloader");
const { getUserPrefs, setUserPrefs } = require("./prefs");
const mailer = require("./mailer");

// Config
const RESULTS_PER_PAGE = 5;
const MAX_QUERY_LENGTH = 200;
const RATE_LIMIT_SECONDS = 5;
const LOCAL_API_SERVER = (process.env.LOCAL_API_SERVER || "").replace(/\/+$/, "");
const MAX_FILE_SIZE = LOCAL_API_SERVER ? 400 * 1024 * 1024 : 50 * 1024 * 1024;
const STATE_TTL = 30 * 60 * 1000; // 30 minutes
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

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
  botOptions.telegram = { apiRoot: LOCAL_API_SERVER };
  console.log(`Local Bot API mode: ${LOCAL_API_SERVER} (limit ${Math.floor(MAX_FILE_SIZE / 1024 / 1024)} MB)`);
}

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN, botOptions);

// Per-user state with TTL
const userState = new Map();

function getUserState(userId) {
  const now = Date.now();
  if (userState.has(userId)) {
    const state = userState.get(userId);
    state.lastActivity = now;
    return state;
  }
  const state = { results: [], allResults: [], lastSearchAt: 0, activeDlAbort: null, page: 0, lastActivity: now };
  userState.set(userId, state);
  return state;
}

// Cleanup inactive user states every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [userId, state] of userState) {
    if (now - state.lastActivity > STATE_TTL) {
      userState.delete(userId);
    }
  }
}, 10 * 60 * 1000);

// Search cache
const searchCache = new Map();

function getCachedSearch(query) {
  const key = query.toLowerCase().trim();
  const cached = searchCache.get(key);
  if (cached && Date.now() - cached.time < CACHE_TTL) {
    console.log(`Cache hit for "${query}"`);
    return cached.results;
  }
  searchCache.delete(key);
  return null;
}

function setCachedSearch(query, results) {
  const key = query.toLowerCase().trim();
  searchCache.set(key, { results, time: Date.now() });
  // Limit cache size
  if (searchCache.size > 200) {
    const oldest = searchCache.keys().next().value;
    searchCache.delete(oldest);
  }
}

// Whitelist middleware — FIX: explicitly return to block unauthorized users
bot.use((ctx, next) => {
  if (ALLOWED_USER_IDS.size === 0) return next();
  const uid = ctx.from?.id;
  if (uid && ALLOWED_USER_IDS.has(uid)) return next();
  return; // Block unauthorized users
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

function sourceTag(result) {
  if (result.source === "anna") return "[AA]";
  if (result.source === "prowlarr") return "[PR]";
  return "";
}

// ─── Onboarding ───

const FORMATS = ["epub", "pdf", "mobi", "azw3"];

function formatPrefsMessage(prefs) {
  const lines = [
    `Format : ${(prefs.format || "epub").toUpperCase()}`,
    `Email : ${prefs.email || "non configure"}`,
    `Kindle : ${prefs.kindleEmail || "non configure"}`,
    `Livraison : ${prefs.delivery === "kindle" ? "Kindle" : prefs.delivery === "email" ? "Email" : "Telegram"}`,
  ];
  return lines.join("\n");
}

async function startOnboarding(ctx) {
  const uid = ctx.from.id;
  const state = getUserState(uid);
  state.onboardingStep = "format";

  await ctx.reply(
    "👋 Bienvenue ! Configurons tes preferences.\n\n" +
    "1/4 — Quel format de livre preferes-tu ?",
    Markup.inlineKeyboard([
      [Markup.button.callback("📗 EPUB", "ob_fmt_epub"), Markup.button.callback("📕 PDF", "ob_fmt_pdf")],
      [Markup.button.callback("📙 MOBI", "ob_fmt_mobi"), Markup.button.callback("📘 AZW3", "ob_fmt_azw3")],
    ])
  );
}

// Onboarding: format choice
for (const fmt of FORMATS) {
  bot.action(`ob_fmt_${fmt}`, async (ctx) => {
    await ctx.answerCbQuery();
    const uid = ctx.from.id;
    const state = getUserState(uid);
    setUserPrefs(uid, { format: fmt });
    state.onboardingStep = "email";

    await ctx.editMessageText(
      `Format : ${fmt.toUpperCase()} ✓\n\n` +
      "2/4 — Veux-tu recevoir les livres par email ?\n" +
      "Envoie ton adresse email ou clique sur Passer.",
      Markup.inlineKeyboard([[Markup.button.callback("⏭ Passer", "ob_skip_email")]])
    );
  });
}

// Onboarding: skip email
bot.action("ob_skip_email", async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  const state = getUserState(uid);
  state.onboardingStep = "kindle";

  await ctx.editMessageText(
    "Email : passe ✓\n\n" +
    "3/4 — As-tu un Kindle ? Envoie ton adresse Kindle\n" +
    "(ex: ton-nom@kindle.com) ou clique sur Passer.\n\n" +
    "Astuce : les vieux Kindle ne supportent pas EPUB,\nutilise MOBI ou AZW3.",
    Markup.inlineKeyboard([[Markup.button.callback("⏭ Passer", "ob_skip_kindle")]])
  );
});

// Onboarding: skip kindle
bot.action("ob_skip_kindle", async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  finishOnboarding(ctx, uid);
});

function finishOnboarding(ctx, uid) {
  const state = getUserState(uid);
  state.onboardingStep = null;
  const prefs = setUserPrefs(uid, { onboarded: true });

  ctx.editMessageText(
    "✅ Configuration terminee !\n\n" +
    formatPrefsMessage(prefs) + "\n\n" +
    "Envoie-moi le titre d'un livre pour commencer.\n" +
    "Tu peux modifier tes preferences avec /settings"
  );
}

// /start
bot.start((ctx) => {
  const prefs = getUserPrefs(ctx.from.id);
  if (!prefs.onboarded) {
    return startOnboarding(ctx);
  }
  ctx.reply(
    "👋 Bon retour ! Envoie-moi le titre d'un livre.\n\n" +
    "Commandes : /settings /help"
  );
});

// /help
bot.help((ctx) => {
  ctx.reply(
    "📖 Commandes :\n\n" +
    "/start - Message de bienvenue\n" +
    "/settings - Modifier tes preferences\n" +
    "/help - Cette aide\n\n" +
    "Envoie un titre de livre pour lancer une recherche."
  );
});

// /settings
bot.command("settings", (ctx) => {
  const prefs = getUserPrefs(ctx.from.id);
  const buttons = [
    [Markup.button.callback(`Format : ${(prefs.format || "epub").toUpperCase()}`, "set_format")],
    [Markup.button.callback(`Email : ${prefs.email || "non configure"}`, "set_email")],
    [Markup.button.callback(`Kindle : ${prefs.kindleEmail || "non configure"}`, "set_kindle")],
    [Markup.button.callback(
      `Livraison : ${prefs.delivery === "kindle" ? "Kindle" : prefs.delivery === "email" ? "Email" : "Telegram"}`,
      "set_delivery"
    )],
  ];
  ctx.reply("⚙️ Tes preferences :", Markup.inlineKeyboard(buttons));
});

// Settings: change format
bot.action("set_format", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText(
    "Choisis ton format prefere :",
    Markup.inlineKeyboard([
      [Markup.button.callback("📗 EPUB", "sf_epub"), Markup.button.callback("📕 PDF", "sf_pdf")],
      [Markup.button.callback("📙 MOBI", "sf_mobi"), Markup.button.callback("📘 AZW3", "sf_azw3")],
    ])
  );
});

for (const fmt of FORMATS) {
  bot.action(`sf_${fmt}`, async (ctx) => {
    await ctx.answerCbQuery();
    setUserPrefs(ctx.from.id, { format: fmt });
    await ctx.editMessageText(`✅ Format mis a jour : ${fmt.toUpperCase()}`);
  });
}

// Settings: change email
bot.action("set_email", async (ctx) => {
  await ctx.answerCbQuery();
  const state = getUserState(ctx.from.id);
  state.onboardingStep = "set_email";
  await ctx.editMessageText(
    "Envoie ton adresse email (ou /cancel pour annuler) :",
    Markup.inlineKeyboard([[Markup.button.callback("🗑 Supprimer", "del_email")]])
  );
});

bot.action("del_email", async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  const state = getUserState(uid);
  state.onboardingStep = null;
  const prefs = getUserPrefs(uid);
  const updates = { email: null };
  if (prefs.delivery === "email") updates.delivery = "telegram";
  setUserPrefs(uid, updates);
  await ctx.editMessageText("✅ Email supprime.");
});

// Settings: change kindle
bot.action("set_kindle", async (ctx) => {
  await ctx.answerCbQuery();
  const state = getUserState(ctx.from.id);
  state.onboardingStep = "set_kindle";
  await ctx.editMessageText(
    "Envoie ton adresse Kindle (ex: ton-nom@kindle.com)\nou /cancel pour annuler :",
    Markup.inlineKeyboard([[Markup.button.callback("🗑 Supprimer", "del_kindle")]])
  );
});

bot.action("del_kindle", async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  const state = getUserState(uid);
  state.onboardingStep = null;
  const prefs = getUserPrefs(uid);
  const updates = { kindleEmail: null };
  if (prefs.delivery === "kindle") updates.delivery = "telegram";
  setUserPrefs(uid, updates);
  await ctx.editMessageText("✅ Kindle supprime.");
});

// Settings: change delivery method
bot.action("set_delivery", async (ctx) => {
  await ctx.answerCbQuery();
  const prefs = getUserPrefs(ctx.from.id);
  const buttons = [[Markup.button.callback("📱 Telegram", "sd_telegram")]];
  if (prefs.email) buttons.push([Markup.button.callback("📧 Email", "sd_email")]);
  if (prefs.kindleEmail) buttons.push([Markup.button.callback("📚 Kindle", "sd_kindle")]);
  await ctx.editMessageText("Choisis ta methode de livraison :", Markup.inlineKeyboard(buttons));
});

for (const method of ["telegram", "email", "kindle"]) {
  bot.action(`sd_${method}`, async (ctx) => {
    await ctx.answerCbQuery();
    setUserPrefs(ctx.from.id, { delivery: method });
    const label = method === "kindle" ? "Kindle" : method === "email" ? "Email" : "Telegram";
    await ctx.editMessageText(`✅ Livraison par ${label}.`);
  });
}

// Cancel settings input
bot.command("cancel", (ctx) => {
  const state = getUserState(ctx.from.id);
  state.onboardingStep = null;
  ctx.reply("Annule.");
});

function buildResultButtons(results, page) {
  const start = page * RESULTS_PER_PAGE;
  const pageResults = results.slice(start, start + RESULTS_PER_PAGE);
  const buttons = [];

  for (let i = 0; i < pageResults.length; i++) {
    const r = pageResults[i];
    const globalIdx = start + i;
    const icon = r.isTorrent ? "🌀" : "📥";
    const tag = sourceTag(r);
    const ext = (r.ext || "?").toUpperCase();
    const titleShort = r.title.length > 35 ? r.title.slice(0, 35) + "…" : r.title;
    let label = `${icon} ${tag} ${titleShort} · ${ext}`;
    if (r.author) label += ` – ${r.author.slice(0, 15)}`;
    buttons.push([Markup.button.callback(label, `dl_${globalIdx}`)]);
  }

  // Pagination buttons
  const navRow = [];
  if (page > 0) {
    navRow.push(Markup.button.callback("⬅️ Précédent", `page_${page - 1}`));
  }
  if (start + RESULTS_PER_PAGE < results.length) {
    navRow.push(Markup.button.callback("➡️ Suivant", `page_${page + 1}`));
  }
  if (navRow.length) buttons.push(navRow);

  return buttons;
}

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
    // Check cache first
    let aaResults, prResults;
    const cached = getCachedSearch(query);
    if (cached) {
      aaResults = cached.aa;
      prResults = cached.pr;
    } else {
      // Search in parallel, track which sources failed
      const aaPromise = safeSearch(() => annaArchive.search(query), "Anna's Archive");
      const prPromise = safeSearch(() => searchBooks(query), "Prowlarr");
      [aaResults, prResults] = await Promise.all([aaPromise, prPromise]);
      setCachedSearch(query, { aa: aaResults, pr: prResults });
    }

    console.log(`=== Results for "${query}" ===`);
    console.log(`Anna's Archive (${aaResults.length}), Prowlarr (${prResults.length})`);

    // Merge: epub first, direct before torrents
    const direct = [...aaResults, ...prResults].filter((r) => !r.isTorrent);
    const torrents = prResults.filter((r) => r.isTorrent);

    direct.sort((a, b) => {
      const extA = a.ext === "epub" ? 0 : 1;
      const extB = b.ext === "epub" ? 0 : 1;
      if (extA !== extB) return extA - extB;
      return (a.isTorrent ? 1 : 0) - (b.isTorrent ? 1 : 0);
    });

    const allMerged = [...direct, ...torrents];

    // Filter oversized
    const filtered = allMerged.filter((r) => !(r.sizeBytes > MAX_FILE_SIZE));

    // Deduplicate by normalized title (first 35 chars)
    const seenTitles = new Set();
    const results = [];
    for (const r of filtered) {
      const norm = (r.title || "").replace(/[^\w]/g, "").toLowerCase().slice(0, 35);
      if (norm && seenTitles.has(norm)) continue;
      if (norm) seenTitles.add(norm);
      results.push(r);
    }

    // Build status message
    let statusParts = [];
    if (aaResults.length === 0 && prResults.length === 0) {
      // both returned nothing
    } else {
      if (aaResults.length === 0) statusParts.push("Anna's Archive : aucun résultat");
      if (prResults.length === 0) statusParts.push("Prowlarr : aucun résultat");
    }

    if (results.length === 0) {
      let msg = `😕 Aucun résultat trouvé pour « ${query} ».`;
      if (statusParts.length) msg += `\n${statusParts.join("\n")}`;
      msg += "\nEssaie un autre titre ou orthographe.";
      return ctx.telegram.editMessageText(ctx.chat.id, searchMsg.message_id, undefined, msg);
    }

    state.allResults = results;
    state.results = results;
    state.page = 0;

    // Check epub availability
    const hasEpub = results.some((r) => r.ext === "epub");

    // If no epub, ask confirmation
    if (!hasEpub) {
      const exts = [...new Set(results.map((r) => (r.ext || "?").toUpperCase()))];
      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback(`✅ Oui, envoie-moi en ${exts.join(", ")}`, "confirm_non_epub")],
        [Markup.button.callback("❌ Non, annuler", "cancel_search")],
      ]);
      return ctx.telegram.editMessageText(
        ctx.chat.id, searchMsg.message_id, undefined,
        `📚 Pas d'epub disponible pour « ${query} ».\n` +
        `J'ai trouvé ${results.length} résultat(s) en ${exts.join(", ")}. Ça ira ?`,
        keyboard
      );
    }

    // Show format filter + results
    const filterRow = [
      Markup.button.callback("📚 Tous", "filter_all"),
      Markup.button.callback("📗 EPUB", "filter_epub"),
      Markup.button.callback("📕 PDF", "filter_pdf"),
      Markup.button.callback("📙 MOBI", "filter_mobi"),
    ];
    const resultButtons = buildResultButtons(results, 0);

    const n = results.length;
    let header = `📚 ${n} résultat${n > 1 ? "s" : ""} trouvé${n > 1 ? "s" : ""} :`;
    if (statusParts.length) header += `\n${statusParts.join(" · ")}`;

    await ctx.telegram.editMessageText(
      ctx.chat.id, searchMsg.message_id, undefined,
      header,
      Markup.inlineKeyboard([filterRow, ...resultButtons])
    );
  } catch (error) {
    console.error("Search error:", error);
    await ctx.telegram.editMessageText(
      ctx.chat.id, searchMsg.message_id, undefined,
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

// Plain text handler — intercept email input during onboarding/settings
bot.on("text", (ctx) => {
  if (ctx.message.text.startsWith("/")) return;

  const uid = ctx.from.id;
  const state = getUserState(uid);
  const text = ctx.message.text.trim();

  // Handle onboarding email input
  if (state.onboardingStep === "email" || state.onboardingStep === "set_email") {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(text)) {
      return ctx.reply("❌ Adresse email invalide. Reessaie ou clique sur Passer.");
    }
    setUserPrefs(uid, { email: text });
    if (state.onboardingStep === "set_email") {
      state.onboardingStep = null;
      return ctx.reply(`✅ Email mis a jour : ${text}`);
    }
    // Continue onboarding to kindle step
    state.onboardingStep = "kindle";
    return ctx.reply(
      `Email : ${text} ✓\n\n` +
      "3/4 — As-tu un Kindle ? Envoie ton adresse Kindle\n" +
      "(ex: ton-nom@kindle.com) ou clique sur Passer.\n\n" +
      "Astuce : les vieux Kindle ne supportent pas EPUB,\nutilise MOBI ou AZW3.",
      Markup.inlineKeyboard([[Markup.button.callback("⏭ Passer", "ob_skip_kindle")]])
    );
  }

  // Handle onboarding/settings kindle input
  if (state.onboardingStep === "kindle" || state.onboardingStep === "set_kindle") {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(text)) {
      return ctx.reply("❌ Adresse email invalide. Reessaie ou clique sur Passer.");
    }
    setUserPrefs(uid, { kindleEmail: text });
    if (state.onboardingStep === "set_kindle") {
      state.onboardingStep = null;
      return ctx.reply(`✅ Kindle mis a jour : ${text}`);
    }
    // Finish onboarding
    state.onboardingStep = null;
    const prefs = setUserPrefs(uid, { onboarded: true });
    return ctx.reply(
      "✅ Configuration terminee !\n\n" +
      formatPrefsMessage(prefs) + "\n\n" +
      "Envoie-moi le titre d'un livre pour commencer.\n" +
      "Tu peux modifier tes preferences avec /settings"
    );
  }

  // Check if user needs onboarding
  const prefs = getUserPrefs(uid);
  if (!prefs.onboarded) {
    return startOnboarding(ctx);
  }

  return handleSearch(ctx);
});

// Format filter handlers
for (const format of ["all", "epub", "pdf", "mobi"]) {
  bot.action(`filter_${format}`, async (ctx) => {
    await ctx.answerCbQuery();
    const state = getUserState(ctx.from.id);
    if (!state.allResults.length) {
      return ctx.editMessageText("❌ Résultat expiré, refais une recherche.");
    }

    if (format === "all") {
      state.results = state.allResults;
    } else {
      state.results = state.allResults.filter((r) => r.ext === format);
    }
    state.page = 0;

    if (state.results.length === 0) {
      return ctx.editMessageText(`😕 Aucun résultat en ${format.toUpperCase()}.`);
    }

    const filterRow = [
      Markup.button.callback(format === "all" ? "📚 ✓Tous" : "📚 Tous", "filter_all"),
      Markup.button.callback(format === "epub" ? "📗 ✓EPUB" : "📗 EPUB", "filter_epub"),
      Markup.button.callback(format === "pdf" ? "📕 ✓PDF" : "📕 PDF", "filter_pdf"),
      Markup.button.callback(format === "mobi" ? "📙 ✓MOBI" : "📙 MOBI", "filter_mobi"),
    ];
    const resultButtons = buildResultButtons(state.results, 0);
    const n = state.results.length;

    await ctx.editMessageText(
      `📚 ${n} résultat${n > 1 ? "s" : ""} (${format.toUpperCase()}) :`,
      Markup.inlineKeyboard([filterRow, ...resultButtons])
    );
  });
}

// Pagination handler
bot.action(/page_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const page = parseInt(ctx.match[1]);
  const state = getUserState(ctx.from.id);
  if (!state.results.length) {
    return ctx.editMessageText("❌ Résultat expiré, refais une recherche.");
  }

  state.page = page;
  const resultButtons = buildResultButtons(state.results, page);
  const total = state.results.length;
  const start = page * RESULTS_PER_PAGE + 1;
  const end = Math.min((page + 1) * RESULTS_PER_PAGE, total);

  await ctx.editMessageText(
    `📚 Résultats ${start}-${end} sur ${total} :`,
    Markup.inlineKeyboard(resultButtons)
  );
});

// Confirm non-epub
bot.action("confirm_non_epub", async (ctx) => {
  await ctx.answerCbQuery();
  const state = getUserState(ctx.from.id);
  if (!state.results.length) {
    return ctx.editMessageText("❌ Résultat expiré, refais une recherche.");
  }

  const resultButtons = buildResultButtons(state.results, 0);
  await ctx.editMessageText("📚 Choisis un résultat :", Markup.inlineKeyboard(resultButtons));
});

// Cancel search
bot.action("cancel_search", async (ctx) => {
  await ctx.answerCbQuery();
  const state = getUserState(ctx.from.id);
  state.results = [];
  state.allResults = [];
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

// ─── Delivery ───

async function deliverFile(ctx, filePath, filename, title, prefs) {
  const method = prefs.delivery || "telegram";

  if (method === "email" && prefs.email && mailer.isConfigured()) {
    await ctx.editMessageText(`📧 Envoi par email a ${prefs.email}...`);
    try {
      await mailer.sendBookByEmail(filePath, filename, prefs.email);
      await ctx.editMessageText(`✅ Envoye par email a ${prefs.email} ! 📖`);
    } catch (e) {
      console.error("Email send error:", e.message);
      await ctx.editMessageText("❌ Erreur envoi email. Envoi par Telegram...");
      await sendViaTelegram(ctx, filePath, filename, title);
    }
  } else if (method === "kindle" && prefs.kindleEmail && mailer.isConfigured()) {
    await ctx.editMessageText(`📚 Envoi vers Kindle (${prefs.kindleEmail})...`);
    try {
      await mailer.sendToKindle(filePath, filename, prefs.kindleEmail);
      await ctx.editMessageText(`✅ Envoye sur ton Kindle ! 📖\nVerifie dans quelques minutes.`);
    } catch (e) {
      console.error("Kindle send error:", e.message);
      await ctx.editMessageText("❌ Erreur envoi Kindle. Envoi par Telegram...");
      await sendViaTelegram(ctx, filePath, filename, title);
    }
  } else {
    await sendViaTelegram(ctx, filePath, filename, title);
  }
}

async function sendViaTelegram(ctx, filePath, filename, title) {
  await ctx.editMessageText(`📤 Envoi de « ${title} »...`);
  await ctx.replyWithDocument(
    { source: filePath, filename },
    { caption: `📖 ${title}` }
  );
  await ctx.editMessageText("✅ Envoye ! Bonne lecture 📖");
}

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

      if (result.isTorrent) {
        await ctx.editMessageText(
          `🌀 Envoi vers le client torrent pour « ${title} »...\n⏳ Surveillance du dossier...`,
          cancelKb
        );
      } else {
        await ctx.editMessageText(`⏳ Recherche du fichier ${sourceTag(result)}...`, cancelKb);
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
          result.isTorrent ? null : onProgress,
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

      // Deliver the file
      const safeTitle = title.replace(/[^\w\s\-]/g, "").trim().slice(0, 60) || "livre";
      const filename = `${safeTitle}.${ext}`;
      const prefs = getUserPrefs(ctx.from.id);

      try {
        await deliverFile(ctx, filePath, filename, title, prefs);
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
