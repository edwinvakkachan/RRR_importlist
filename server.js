// server.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const basicAuth = require('basic-auth');
const winston = require('winston');
require('winston-daily-rotate-file');

const app = express();
app.use(bodyParser.json());

// logs folder
const LOG_DIR = path.join(__dirname, 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

// winston setup (rotating files + colored console)
const { format, transports, createLogger } = winston;
const rotateTransport = new transports.DailyRotateFile({
  filename: path.join(LOG_DIR, 'rrr-%DATE%.log'),
  datePattern: 'YYYY-MM-DD',
  zippedArchive: true,
  maxFiles: '14d',
  level: 'info'
});
const errorTransport = new transports.File({ filename: path.join(LOG_DIR, 'rrr-error.log'), level: 'error' });

const fileFormat = format.combine(
  format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  format.errors({ stack: true }),
  format.printf(({ timestamp, level, message, stack }) => `[${timestamp}] [${level.toUpperCase()}] ${message}${stack ? '\n' + stack : ''}`)
);
const consoleFormat = format.combine(
  format.colorize({ all: true }),
  format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  format.printf(({ timestamp, level, message }) => `[${timestamp}] [${level}] ${message}`)
);

const logger = createLogger({
  level: 'info',
  transports: [rotateTransport, errorTransport, new transports.Console({ format: consoleFormat })],
  format: fileFormat
});

function safeString(x) {
  try { return typeof x === 'string' ? x : JSON.stringify(x); } catch (e) { return String(x); }
}

// axios instances
const radarr = axios.create({
  baseURL: process.env.RADARR_BASE,
  params: { apikey: process.env.RADARR_APIKEY },
  headers: { 'Content-Type': 'application/json' }
});
const sonarr = axios.create({
  baseURL: process.env.SONARR_BASE,
  params: { apikey: process.env.SONARR_APIKEY },
  headers: { 'Content-Type': 'application/json' }
});

// Basic auth middleware
function requireBasicAuth(req, res, next) {
  const user = basicAuth(req);
  if (!process.env.BASIC_AUTH_USER) return next();
  const ok = user && user.name === process.env.BASIC_AUTH_USER && user.pass === process.env.BASIC_AUTH_PASS;
  if (!ok) {
    res.set('WWW-Authenticate', 'Basic realm="Restricted"');
    return res.status(401).send('Authentication required.');
  }
  return next();
}

// Telegram notify helper (simple)
async function notifyTelegram(text) {
  const token = process.env.TELEGRAM_TOKEN;
  const chatId = process.env.TELEGRAM_NOTIFY_CHAT_ID;
  if (!token || !chatId) {
    logger.warn('Telegram token or chat id not set — skipping notify');
    return;
  }
  try {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    await axios.post(url, { chat_id: chatId, text, parse_mode: 'HTML' });
    logger.info('Sent Telegram notification');
  } catch (err) {
    logger.error('Telegram notify failed: ' + safeString(err.response?.data || err.message));
  }
}

/* -------------------------
   Image helpers (normalize)
   ------------------------- */

// Build a usable absolute URL (handles TMDb style "/path.jpg" and full URLs)
function makeImageUrl(img) {
  if (!img) return null;
  try {
    if (Array.isArray(img) && img.length) img = img[0];
    if (typeof img === 'object') {
      img = img.remoteUrl || img.url || img.coverUrl || img.posterPath || img.backdropPath || img.path || img.imagePath;
    }
    if (!img) return null;
    img = String(img).trim();
    if (!img) return null;
    if (img.startsWith('http://') || img.startsWith('https://')) return img;
    if (img.startsWith('//')) return (process.env.SERVER_PROTOCOL || 'https:') + img;
    if (img.startsWith('/')) return 'https://image.tmdb.org/t/p/w500' + img;
    return img;
  } catch (e) {
    return null;
  }
}

// Normalize arrays/objects/strings into an array of full image URLs
function makeImageUrlsArray(maybeImgs) {
  if (!maybeImgs) return [];
  try {
    if (Array.isArray(maybeImgs)) {
      return maybeImgs.map(it => makeImageUrl(it)).filter(Boolean);
    }
    if (typeof maybeImgs === 'object') {
      // If object is a map of images, try to extract common fields
      const candidate = maybeImgs.remoteUrl || maybeImgs.url || maybeImgs.coverUrl || maybeImgs.posterPath || maybeImgs.backdropPath || maybeImgs.path;
      const v = makeImageUrl(candidate);
      return v ? [v] : [];
    }
    // string
    const v = makeImageUrl(String(maybeImgs));
    return v ? [v] : [];
  } catch (e) {
    return [];
  }
}

/* -------------------------
   Radarr / Sonarr metadata
   ------------------------- */

async function radarrGetDefaults() {
  try {
    const [rootsRes, qpsRes] = await Promise.all([radarr.get('/api/v3/rootfolder'), radarr.get('/api/v3/qualityprofile')]);
    return { rootFolders: rootsRes.data || [], qualityProfiles: qpsRes.data || [] };
  } catch (err) {
    logger.warn('radarrGetDefaults failed: ' + safeString(err.response?.data || err.message));
    return { rootFolders: [], qualityProfiles: [] };
  }
}
async function sonarrGetDefaults() {
  try {
    const [rootsRes, qpsRes] = await Promise.all([sonarr.get('/api/v3/rootfolder'), sonarr.get('/api/v3/qualityprofile')]);
    return { rootFolders: rootsRes.data || [], qualityProfiles: qpsRes.data || [] };
  } catch (err) {
    logger.warn('sonarrGetDefaults failed: ' + safeString(err.response?.data || err.message));
    return { rootFolders: [], qualityProfiles: [] };
  }
}

/* -------------------------
   API endpoints
   ------------------------- */

// meta for UI
app.get('/api/radarr/meta', requireBasicAuth, async (req, res) => res.json(await radarrGetDefaults()));
app.get('/api/sonarr/meta', requireBasicAuth, async (req, res) => res.json(await sonarrGetDefaults()));

// Search movie (Radarr lookup) — returns imageUrl and images[]
app.post('/api/search/movie', requireBasicAuth, async (req, res) => {
  try {
    const { query } = req.body;
    if (!query) return res.status(400).json({ error: 'query required' });
    logger.info(`🔍 search/movie: "${query}"`);
    const { data } = await radarr.get('/api/v3/movie/lookup', { params: { term: query } });
    const results = (Array.isArray(data) ? data : []).slice(0, 20).map(it => {
      // try many fields for images
      let imgs = [];
      if (it.images && Array.isArray(it.images) && it.images.length) {
        // Radarr images array may include objects; map to usable URLs
        imgs = it.images.map(i => i.remoteUrl || i.url || i.coverUrl || i.path || i.posterPath).filter(Boolean);
      } else if (it.posterPath || it.backdropPath) {
        imgs = [it.posterPath || it.backdropPath];
      } else if (it.remotePoster) {
        imgs = [it.remotePoster];
      }
      const images = makeImageUrlsArray(imgs);
      const imageUrl = images[0] || null;
      return {
        title: it.title || it.titleSlug,
        tmdbId: it.tmdbId,
        year: it.year,
        overview: it.overview,
        imageUrl,
        images
      };
    });
    logger.info(`📡 Radarr lookup returned ${results.length} results for "${query}"`);
    res.json(results);
  } catch (err) {
    logger.error('search/movie error: ' + safeString(err.response?.data || err.message));
    res.status(500).json({ error: 'search failed', details: err.response?.data || err.message });
  }
});

// Search series (Sonarr lookup) — returns imageUrl and images[]
app.post('/api/search/series', requireBasicAuth, async (req, res) => {
  try {
    const { query } = req.body;
    if (!query) return res.status(400).json({ error: 'query required' });
    logger.info(`🔍 search/series: "${query}"`);
    const { data } = await sonarr.get('/api/v3/series/lookup', { params: { term: query } });
    const results = (Array.isArray(data) ? data : []).slice(0, 20).map(item => {
      // gather potential images
      let imgs = [];
      if (item.series && item.series.images && Array.isArray(item.series.images) && item.series.images.length) {
        imgs = item.series.images.map(i => i.remoteUrl || i.url || i.coverUrl || i.path || i.posterPath).filter(Boolean);
      } else if (item.images && Array.isArray(item.images) && item.images.length) {
        imgs = item.images.map(i => i.remoteUrl || i.url || i.coverUrl || i.path || i.posterPath).filter(Boolean);
      } else if (item.imageUrl) {
        imgs = [item.imageUrl];
      } else if (item.remotePoster) {
        imgs = [item.remotePoster];
      }
      const images = makeImageUrlsArray(imgs);
      const imageUrl = images[0] || null;
      const tvdbId = item.tvdbId || item.series?.tvdbId || item.remoteId || null;
      const imdbId = item.imdbId || item.series?.imdbId || null;
      const title = item.title || item.seriesTitle || item.series?.title || item.name || null;
      const year = item.year || item.series?.year || null;
      return { title, tvdbId, imdbId, year, overview: item.overview || item.series?.overview, imageUrl, images, raw: item };
    });
    logger.info(`📡 Sonarr lookup returned ${results.length} results for "${query}"`);
    res.json(results);
  } catch (err) {
    logger.error('search/series error: ' + safeString(err.response?.data || err.message));
    res.status(500).json({ error: 'search failed', details: err.response?.data || err.message });
  }
});

// Add movie & add series endpoints (unchanged behavior)
app.post('/api/add/movie', requireBasicAuth, async (req, res) => {
  try {
    const { tmdbId, title, rootFolderPath, qualityProfileId, monitored = true } = req.body;
    if (!tmdbId) return res.status(400).json({ error: 'tmdbId required' });
    const meta = await radarrGetDefaults();
    const root = rootFolderPath || (meta.rootFolders[0] && meta.rootFolders[0].path) || process.env.RADARR_ROOT || '/movies';
    const qp = Number(qualityProfileId || process.env.RADARR_QUALITY_PROFILE_ID || (meta.qualityProfiles[0] && meta.qualityProfiles[0].id) || 1);
    const body = { tmdbId: Number(tmdbId), title: title || undefined, rootFolderPath: root, qualityProfileId: qp, monitored, addOptions: { searchForMovie: true } };
    logger.info(`🎬 add/movie tmdb:${tmdbId} title:${title || '-'} root:${root} qp:${qp}`);
    const r = await radarr.post('/api/v3/movie', body);
    logger.info(`✅ Radarr add success tmdb:${tmdbId} id:${r.data && r.data.id}`);
    await notifyTelegram(`✅ Movie added to Radarr: <b>${r.data.title}</b>\nTMDB: ${r.data.tmdbId}`);
    return res.json({ added: true, movie: r.data });
  } catch (err) {
    logger.warn('Radarr add error: ' + safeString(err.response?.data || err.message));
    // already exists handling
    if (err?.response?.data) {
      try {
        const errors = Array.isArray(err.response.data) ? err.response.data : [];
        const exists = errors.find(e => e.errorCode === 'MovieExistsValidator' || /already been added/i.test(e.errorMessage || ''));
        if (exists) {
          const tmdb = req.body.tmdbId || exists.formattedMessagePlaceholderValues?.propertyValue;
          const found = await radarr.get('/api/v3/movie', { params: { tmdbId: tmdb } });
          const movie = Array.isArray(found.data) && found.data.length ? found.data[0] : null;
          if (movie) { logger.info(`ℹ️ Movie exists tmdb:${tmdb} id:${movie.id}`); return res.json({ added: false, reason: 'exists', movie }); }
        }
      } catch (fetchErr) { logger.error('Error fetching existing movie: ' + safeString(fetchErr.response?.data || fetchErr.message)); }
    }
    return res.status(500).json({ error: 'add failed', details: err.response?.data || err.message });
  }
});

app.post('/api/add/series', requireBasicAuth, async (req, res) => {
  try {
    const { tvdbId, imdbId, title, rootFolderPath, qualityProfileId, monitored = true, seasonFolder = true } = req.body;
    if (!tvdbId && !imdbId && !title) return res.status(400).json({ error: 'tvdbId, imdbId or title required' });
    const meta = await sonarrGetDefaults();
    const root = rootFolderPath || (meta.rootFolders[0] && meta.rootFolders[0].path) || process.env.SONARR_ROOT || '/tv';
    const qp = Number(qualityProfileId || process.env.SONARR_QUALITY_PROFILE_ID || (meta.qualityProfiles[0] && meta.qualityProfiles[0].id) || 1);
    const body = {};
    if (tvdbId) body.tvdbId = Number(tvdbId);
    if (imdbId) body.imdbId = imdbId;
    if (title && !tvdbId && !imdbId) body.title = title;
    body.qualityProfileId = qp; body.rootFolderPath = root; body.monitored = monitored; body.seasonFolder = seasonFolder;
    logger.info(`📺 add/series title:${title || '-'} tvdb:${tvdbId || '-'} imdb:${imdbId || '-'} root:${root} qp:${qp}`);
    const r = await sonarr.post('/api/v3/series', body);
    logger.info(`✅ Sonarr add success ${r.data.title} id:${r.data.id}`);
    await notifyTelegram(`✅ Series added to Sonarr: <b>${r.data.title}</b>\nTVDB: ${r.data.tvdbId || 'n/a'}`);
    return res.json({ added: true, series: r.data });
  } catch (err) {
    logger.warn('Sonarr add error: ' + safeString(err.response?.data || err.message));
    if (err?.response?.data) {
      try {
        const all = await sonarr.get('/api/v3/series');
        const match = all.data.find(s => (req.body.tvdbId && Number(s.tvdbId) === Number(req.body.tvdbId)) ||
                                        (req.body.imdbId && s.imdbId === req.body.imdbId) ||
                                        (req.body.title && s.title && s.title.toLowerCase() === req.body.title.toLowerCase()));
        if (match) { logger.info('ℹ️ Series exists: ' + match.title); return res.json({ added: false, reason: 'exists', series: match }); }
      } catch (fetchErr) { logger.error('Error fetching series list: ' + safeString(fetchErr.response?.data || fetchErr.message)); }
    }
    return res.status(500).json({ error: 'add failed', details: err.response?.data || err.message });
  }
});

/* -------------------------
   Log management endpoints
   ------------------------- */
app.get('/api/logs', requireBasicAuth, (req, res) => {
  try {
    const files = fs.readdirSync(LOG_DIR).filter(f => f.endsWith('.log') || f.endsWith('.gz'));
    res.json({ ok: true, files });
  } catch (err) {
    logger.error('Failed to list logs: ' + safeString(err.message));
    res.status(500).json({ error: err.message });
  }
});
app.get('/api/logs/view', requireBasicAuth, (req, res) => {
  try {
    const file = req.query.file;
    if (!file) return res.status(400).json({ error: 'file query param required' });
    const full = path.join(LOG_DIR, path.basename(file));
    if (!fs.existsSync(full)) return res.status(404).json({ error: 'file not found' });
    const data = fs.readFileSync(full, 'utf8');
    res.type('text/plain').send(data);
  } catch (err) {
    logger.error('Failed to read log file: ' + safeString(err.message));
    res.status(500).json({ error: err.message });
  }
});
app.post('/api/clearlogs', requireBasicAuth, (req, res) => {
  try {
    fs.readdirSync(LOG_DIR).forEach(f => {
      const full = path.join(LOG_DIR, f);
      try { fs.unlinkSync(full); } catch (e) { logger.warn('unlink failed for ' + full + ': ' + safeString(e.message)); }
    });
    logger.info('🧹 Logs cleared via /api/clearlogs');
    res.json({ ok: true, message: 'logs cleared' });
  } catch (err) {
    logger.error('Failed to clear logs: ' + safeString(err.message));
    res.status(500).json({ error: err.message });
  }
});

let publicDir = path.join(__dirname, 'public');

// if /public doesn't exist under __dirname, try absolute /public
if (!fs.existsSync(publicDir)) {
  publicDir = '/public';
  logger.warn(`Fallback: Using ${publicDir} as public directory`);
}

// Serve all static files (CSS, JS, images)
app.use(express.static(publicDir));

// Default route - serve index.html
app.get('*', (req, res) => {
  const indexPath = path.join(publicDir, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send('index.html not found in public directory');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => logger.info(`✅ Server started on http://localhost:${PORT}`));
