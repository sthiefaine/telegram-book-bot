require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");
const { searchBooks } = require("./prowlarr");

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// Store search results per user (in memory)
const userResults = new Map();

// /start command
bot.start((ctx) => {
  ctx.reply(
    "📚 Salut ! Je suis un bot de recherche de livres.\n\n" +
      "Utilise /search <titre> pour chercher un livre.\n" +
      "Exemple : /search le petit prince"
  );
});

// /help command
bot.help((ctx) => {
  ctx.reply(
    "📖 Commandes disponibles :\n\n" +
      "/search <titre> - Rechercher un livre\n" +
      "/help - Afficher cette aide"
  );
});

// /search command
bot.command("search", async (ctx) => {
  const query = ctx.message.text.replace("/search", "").trim();

  if (!query) {
    return ctx.reply("❌ Utilisation : /search <titre du livre>");
  }

  const searchMsg = await ctx.reply(`🔍 Recherche de "${query}" en cours...`);

  try {
    const results = await searchBooks(query);

    if (results.length === 0) {
      return ctx.telegram.editMessageText(
        ctx.chat.id,
        searchMsg.message_id,
        undefined,
        `😕 Aucun résultat pour "${query}". Essaie avec d'autres mots-clés.`
      );
    }

    // Store results for this user
    userResults.set(ctx.from.id, results);

    // Build results message
    let message = `📚 Résultats pour "${query}" :\n\n`;

    results.forEach((r, i) => {
      message +=
        `${i + 1}. 📖 ${r.title}\n` +
        `   💾 ${r.size} | ⬆️ ${r.seeders} seeds | 📡 ${r.indexer}\n\n`;
    });

    message += "Clique sur un bouton pour obtenir le lien :";

    // Inline keyboard with download buttons
    const buttons = results.map((r, i) =>
      Markup.button.callback(`📥 ${i + 1}`, `dl_${i}`)
    );

    // Arrange buttons in rows of 5
    const keyboard = [];
    for (let i = 0; i < buttons.length; i += 5) {
      keyboard.push(buttons.slice(i, i + 5));
    }

    await ctx.telegram.editMessageText(
      ctx.chat.id,
      searchMsg.message_id,
      undefined,
      message,
      Markup.inlineKeyboard(keyboard)
    );
  } catch (error) {
    console.error("Search error:", error);
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      searchMsg.message_id,
      undefined,
      "❌ Erreur lors de la recherche. Vérifie que Prowlarr est bien configuré."
    );
  }
});

// Handle download button clicks
bot.action(/dl_(\d+)/, async (ctx) => {
  const index = parseInt(ctx.match[1]);
  const results = userResults.get(ctx.from.id);

  if (!results || !results[index]) {
    return ctx.answerCbQuery("❌ Résultat expiré, refais une recherche.");
  }

  const result = results[index];

  await ctx.answerCbQuery("📥 Récupération du lien...");

  if (result.downloadUrl) {
    await ctx.reply(
      `📥 **${result.title}**\n\n` +
        `💾 Taille : ${result.size}\n` +
        `📡 Source : ${result.indexer}\n\n` +
        `🔗 [Télécharger](${result.downloadUrl})`,
      { parse_mode: "Markdown", disable_web_page_preview: true }
    );
  } else if (result.infoUrl) {
    await ctx.reply(
      `📖 **${result.title}**\n\n` +
        `🔗 [Voir la page](${result.infoUrl})`,
      { parse_mode: "Markdown", disable_web_page_preview: true }
    );
  } else {
    await ctx.reply("❌ Aucun lien disponible pour ce résultat.");
  }
});

// Handle plain text as search
bot.on("text", async (ctx) => {
  const query = ctx.message.text.trim();
  if (query.startsWith("/")) return;

  // Treat plain text as a search query
  ctx.message.text = `/search ${query}`;
  return bot.handleUpdate({
    ...ctx.update,
    message: { ...ctx.message, text: `/search ${query}` },
  });
});

// Error handling
bot.catch((err, ctx) => {
  console.error(`Bot error for ${ctx.updateType}:`, err);
});

// Start bot
bot.launch().then(() => {
  console.log("🤖 Bot started successfully!");
});

// Graceful stop
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
