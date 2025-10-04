// bot.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const winston = require('winston');
require('winston-daily-rotate-file');

const { format, transports, createLogger } = winston;

// logs folder
const LOG_DIR = path.join(__dirname, 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

// bot logger
const consoleFormat = format.combine(
  format.colorize({ all: true }),
  format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  format.printf(({ timestamp, level, message }) => `[${timestamp}] [${level}] ${message}`)
);
const botLogger = createLogger({
  level: 'info',
  transports: [
    new transports.File({ filename: path.join(LOG_DIR, 'bot.log') }),
    new transports.Console({ format: consoleFormat })
  ],
  format: format.combine(format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }), format.printf(({ timestamp, level, message }) => `[${timestamp}] [${level.toUpperCase()}] ${message}`))
});

function safeString(x) {
  try { return typeof x === 'string' ? x : JSON.stringify(x); } catch (e) { return String(x); }
}

const TOKEN = process.env.TELEGRAM_TOKEN;
if (!TOKEN) throw new Error('TELEGRAM_TOKEN missing');
const bot = new TelegramBot(TOKEN, { polling: true });

const API_BASE = process.env.WEB_API_BASE || 'http://localhost:3000';
const apiAxiosConfig = {};
if (process.env.BASIC_AUTH_USER) {
  apiAxiosConfig.auth = { username: process.env.BASIC_AUTH_USER, password: process.env.BASIC_AUTH_PASS || '' };
  botLogger.info('Using Basic Auth for server API calls');
}
const api = axios.create(Object.assign({ baseURL: API_BASE, timeout: 15000 }, apiAxiosConfig));

// compact callback data helpers
function cbAddRadarr(tmdbId) { return `AR|${tmdbId}`; }
function cbAddSonarr(tvdbIdOrKey) { return `AS|${tvdbIdOrKey}`; }

// Build media group for Telegram (first item may have caption)
function buildMediaGroupFromUrls(urls, captionForFirst) {
  return (urls || []).slice(0, 10).map((u, idx) => {
    const media = { type: 'photo', media: u };
    if (idx === 0 && captionForFirst) media.caption = captionForFirst;
    if (idx === 0) media.parse_mode = 'HTML';
    return media;
  });
}

// extract image URLs from server result (server now returns images[] reliably)
function extractImageUrlsFromResult(item) {
  if (!item) return [];
  if (Array.isArray(item.images) && item.images.length) return item.images.map(String).filter(Boolean);
  if (item.imageUrl) return [String(item.imageUrl)];
  // fallback to raw images array (if server didn't normalize)
  if (item.raw && Array.isArray(item.raw.images) && item.raw.images.length) {
    return item.raw.images.map(i => (i.remoteUrl || i.url || i.coverUrl || i.path || i.posterPath)).filter(Boolean);
  }
  return [];
}

/* -------------------------
   /searchmovie command
   ------------------------- */
bot.onText(/\/searchmovie (.+)/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const query = match[1].trim();
  botLogger.info(`Received /searchmovie "${query}" from ${chatId}`);
  try {
    await bot.sendMessage(chatId, `Searching Radarr for: "${query}"...`);
    const r = await api.post('/api/search/movie', { query });
    const results = Array.isArray(r.data) ? r.data : [];
    botLogger.info(`Radarr returned ${results.length} results for "${query}"`);
    if (!results.length) return bot.sendMessage(chatId, 'No matches found.');

    for (const item of results.slice(0, 6)) {
      const title = item.title + (item.year ? ` (${item.year})` : '');
      const text = `${title}\nTMDB: ${item.tmdbId}\n${item.overview ? item.overview.slice(0, 220) + '...' : ''}`;
      const keyboard = { reply_markup: { inline_keyboard: [[{ text: '➕ Add to Radarr', callback_data: cbAddRadarr(item.tmdbId) }]] } };

      const imageUrls = extractImageUrlsFromResult(item);
      if (imageUrls.length === 0) {
        await bot.sendMessage(chatId, text, keyboard);
      } else if (imageUrls.length === 1) {
        try {
          await bot.sendPhoto(chatId, imageUrls[0], { caption: text, parse_mode: 'HTML', ...keyboard });
        } catch (err) {
          botLogger.warn('sendPhoto failed, falling back to text: ' + safeString(err.message));
          await bot.sendMessage(chatId, text, keyboard);
        }
      } else {
        // multiple images -> send media group then send inline keyboard message below the gallery
        try {
          const media = buildMediaGroupFromUrls(imageUrls, text);
          await bot.sendMediaGroup(chatId, media);
          await bot.sendMessage(chatId, ' ', keyboard); // empty message with keyboard (so button shows below album)
        } catch (err) {
          botLogger.warn('sendMediaGroup failed, falling back: ' + safeString(err.message));
          try {
            await bot.sendPhoto(chatId, imageUrls[0], { caption: text, parse_mode: 'HTML', ...keyboard });
          } catch (err2) {
            botLogger.warn('fallback sendPhoto also failed: ' + safeString(err2.message));
            await bot.sendMessage(chatId, text, keyboard);
          }
        }
      }
    }
  } catch (err) {
    botLogger.error('bot searchmovie error: ' + safeString(err.response?.data || err.message));
    bot.sendMessage(chatId, 'Search failed — check server logs.');
  }
});

/* -------------------------
   /searchseries command
   ------------------------- */
bot.onText(/\/searchseries (.+)/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const query = match[1].trim();
  botLogger.info(`Received /searchseries "${query}" from ${chatId}`);
  try {
    await bot.sendMessage(chatId, `Searching Sonarr for: "${query}"...`);
    const r = await api.post('/api/search/series', { query });
    const results = Array.isArray(r.data) ? r.data : [];
    botLogger.info(`Sonarr returned ${results.length} results for "${query}"`);
    if (!results.length) return bot.sendMessage(chatId, 'No matches found.');

    for (const item of results.slice(0, 6)) {
      const title = item.title + (item.year ? ` (${item.year})` : '');
      const text = `${title}\nTVDB: ${item.tvdbId || 'n/a'}\nIMDB: ${item.imdbId || 'n/a'}`;
      const key = item.tvdbId || item.imdbId || item.title;
      const keyboard = { reply_markup: { inline_keyboard: [[{ text: '➕ Add to Sonarr', callback_data: cbAddSonarr(key) }]] } };

      const imageUrls = extractImageUrlsFromResult(item);
      if (imageUrls.length === 0) {
        await bot.sendMessage(chatId, text, keyboard);
      } else if (imageUrls.length === 1) {
        try {
          await bot.sendPhoto(chatId, imageUrls[0], { caption: text, parse_mode: 'HTML', ...keyboard });
        } catch (err) {
          botLogger.warn('sendPhoto failed, falling back to text: ' + safeString(err.message));
          await bot.sendMessage(chatId, text, keyboard);
        }
      } else {
        try {
          const media = buildMediaGroupFromUrls(imageUrls, text);
          await bot.sendMediaGroup(chatId, media);
          await bot.sendMessage(chatId, ' ', keyboard);
        } catch (err) {
          botLogger.warn('sendMediaGroup failed, falling back: ' + safeString(err.message));
          try {
            await bot.sendPhoto(chatId, imageUrls[0], { caption: text, parse_mode: 'HTML', ...keyboard });
          } catch (err2) {
            botLogger.warn('fallback sendPhoto also failed: ' + safeString(err2.message));
            await bot.sendMessage(chatId, text, keyboard);
          }
        }
      }
    }
  } catch (err) {
    botLogger.error('bot searchseries error: ' + safeString(err.response?.data || err.message));
    bot.sendMessage(chatId, 'Search failed — check server logs.');
  }
});

/* -------------------------
   callback handler
   ------------------------- */
bot.on('callback_query', async (query) => {
  const id = query.id;
  const chatId = query.message.chat.id;
  const data = query.data;
  botLogger.info(`callback_query from ${chatId}: ${data}`);
  try {
    if (!data) return bot.answerCallbackQuery(id, { text: 'Invalid callback data' });
    const [action, payload] = data.split('|');
    if (action === 'AR') {
      await bot.sendMessage(chatId, `Adding TMDB:${payload} to Radarr...`);
      const r = await api.post('/api/add/movie', { tmdbId: payload });
      if (r.data.added) { await bot.sendMessage(chatId, `✅ Added: ${r.data.movie.title || 'Unknown'}`); botLogger.info(`Added movie tmdb:${payload}`); }
      else if (r.data.reason === 'exists') { await bot.sendMessage(chatId, `ℹ️ Already exists: ${r.data.movie.title || 'Unknown'}`); botLogger.info(`Movie exists tmdb:${payload}`); }
      else { await bot.sendMessage(chatId, `Add returned: ${JSON.stringify(r.data)}`); botLogger.warn('Add returned unexpected payload: ' + safeString(r.data)); }
    } else if (action === 'AS') {
      await bot.sendMessage(chatId, `Adding to Sonarr: ${payload}...`);
      const body = {}; if (/^\d+$/.test(payload)) body.tvdbId = Number(payload); else body.title = payload;
      const r = await api.post('/api/add/series', body);
      if (r.data.added) { await bot.sendMessage(chatId, `✅ Series added: ${r.data.series.title}`); botLogger.info(`Added series payload:${safeString(body)}`); }
      else if (r.data.reason === 'exists') { await bot.sendMessage(chatId, `ℹ️ Series already exists: ${r.data.series.title}`); botLogger.info(`Series exists payload:${safeString(body)}`); }
      else { await bot.sendMessage(chatId, `Add result: ${JSON.stringify(r.data)}`); botLogger.warn('Series add returned unexpected payload: ' + safeString(r.data)); }
    } else {
      bot.answerCallbackQuery(id, { text: 'Unknown action' });
      botLogger.warn('Unknown callback action: ' + data);
    }
    await bot.answerCallbackQuery(id);
  } catch (err) {
    botLogger.error('callback handler error: ' + safeString(err.response?.data || err.message));
    await bot.sendMessage(chatId, 'Failed to add — check server logs.');
    await bot.answerCallbackQuery(id, { text: 'Error' });
  }
});

botLogger.info('Telegram bot started and polling.');
