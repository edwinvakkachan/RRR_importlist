// server.js — corrected, complete
require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const axios = require('axios');
const expressLayouts = require('express-ejs-layouts');

const app = express(); // <-- must be defined before routes

// view engine + static
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(expressLayouts);
app.set('layout', 'layout');
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const DATA_FILE = process.env.DATA_FILE || './lists.json';
async function loadData(){
  try { return JSON.parse(await fs.readFile(DATA_FILE,'utf8')); }
  catch(e){ return { lists: {} }; }
}
async function saveData(data){ await fs.writeFile(DATA_FILE, JSON.stringify(data,null,2)); }

// Radarr & Sonarr axios instances
const radarr = axios.create({ baseURL: process.env.RADARR_URL || '', params: { apikey: process.env.RADARR_APIKEY }});
const sonarr = axios.create({ baseURL: process.env.SONARR_URL || '', params: { apikey: process.env.SONARR_APIKEY }});

// Helpers
async function radarrLookup(imdbId){
  const id = imdbId.startsWith('tt') ? imdbId : `tt${imdbId}`;
  const res = await radarr.get(`/api/v3/movie/lookup/imdb`, { params: { imdbid: id } });
  return Array.isArray(res.data) ? res.data[0] : res.data;
}
// Helper: get first valid rootFolderPath and a valid qualityProfileId from Radarr
async function radarrGetDefaults() {
  const [rootRes, qpRes] = await Promise.all([
    radarr.get('/api/v3/rootfolder'),
    radarr.get('/api/v3/qualityprofile')
  ]);
  const roots = Array.isArray(rootRes.data) ? rootRes.data : [];
  const qps = Array.isArray(qpRes.data) ? qpRes.data : [];
  return {
    rootFolderPath: roots.length ? roots[0].path : (process.env.RADARR_ROOT || '/movies'),
    qualityProfileId: Number(process.env.RADARR_QUALITY_PROFILE_ID || (qps.length ? qps[0].id : 1))
  };
}

async function radarrAdd(movie){
  try {
    const defaults = await radarrGetDefaults(); // keep the helper from before
    const body = {
      tmdbId: movie.tmdbId,
      title: movie.title || movie.titleSlug || movie.originalTitle || movie.title,
      rootFolderPath: defaults.rootFolderPath,
      qualityProfileId: Number(defaults.qualityProfileId),
      monitored: true,
      addOptions: { searchForMovie: true }
    };

    const res = await radarr.post('/api/v3/movie', body);
    return res.data;
  } catch (error) {
    // If Radarr gave a response body, inspect it:
    if (error?.response?.data) {
      console.error('Radarr responded with status', error.response.status);
      console.error('Radarr response data:', JSON.stringify(error.response.data, null, 2));

      // Look for the specific "already exists" validation error
      const errors = Array.isArray(error.response.data) ? error.response.data : [];
      const existsErr = errors.find(e => e.errorCode === 'MovieExistsValidator' || /already been added/i.test(e.errorMessage || ''));

      if (existsErr) {
        // Try to fetch the existing movie by tmdbId
        try {
          const tmdbId = movie.tmdbId || existsErr.formattedMessagePlaceholderValues?.propertyValue;
          // First attempt: GET /api/v3/movie?tmdbId=...
          let found = await radarr.get('/api/v3/movie', { params: { tmdbId } });
          if (Array.isArray(found.data) && found.data.length) {
            console.log('Found existing movie via /api/v3/movie by tmdbId');
            return found.data[0];
          }

          // Fallback: use lookup endpoint
          found = await radarr.get('/api/v3/movie/lookup', { params: { term: `tmdb:${tmdbId}` } });
          if (Array.isArray(found.data) && found.data.length) {
            // lookup returns search-like entries; try to find an item with an "tmdbId" property
            const match = found.data.find(item => Number(item.tmdbId) === Number(tmdbId));
            if (match) {
              console.log('Found existing movie via lookup');
              // lookup doesn't necessarily return Radarr's stored movie object; if you need the stored object, you may need to search all movies.
              // Try retrieving all movies and match by tmdbId:
              const all = await radarr.get('/api/v3/movie');
              const stored = all.data.find(m => Number(m.tmdbId) === Number(tmdbId));
              if (stored) return stored;
              return match;
            }
          }

          // As a last resort, fetch all movies and search locally
          const allRes = await radarr.get('/api/v3/movie');
          const stored = allRes.data.find(m => Number(m.tmdbId) === Number(movie.tmdbId));
          if (stored) return stored;

          // if we couldn't find it, rethrow original error
          throw error;
        } catch (fetchErr) {
          console.error('Error while trying to fetch existing movie:', fetchErr?.response?.data || fetchErr);
          throw error; // keep original error visible to caller
        }
      }
    }

    // Not a 'movie exists' situation — rethrow so caller sees original error
    throw error;
  }
}

async function sonarrLookupImdb(imdbId){
  try {
    const val = imdbId.startsWith('tt') ? `imdb:${imdbId}` : `imdb:tt${imdbId}`;
  const res = await sonarr.get('/api/v3/series/lookup', { params: { term: val } });
  return Array.isArray(res.data) ? res.data[0] : res.data;
  } catch (error) {
    console.error(error)
  }
}
async function sonarrAdd(series){
  try {
    const body = {
    tvdbId: series.tvdbId || 0,
    title: series.title,
    rootFolderPath: process.env.SONARR_ROOT || process.env.SONARR_ROOT_PATH,
    qualityProfileId: Number(process.env.SONARR_QUALITY_PROFILE_ID || 1),
    seasonFolder: true,
    monitored: true,
    addOptions: { searchForMissingEpisodes: true }
  };
  const res = await sonarr.post('/api/v3/series', body);
  return res.data;
  } catch (error) {
    console.error(error)
  }
}

// Views
app.get('/', async (req,res)=>{
  const data = await loadData();
  res.render('index', { lists: Object.keys(data.lists || {}) });
});

app.get('/list/:name', async (req,res)=>{
 try {
     const data = await loadData();
  const list = data.lists[req.params.name] || [];
  res.render('list', { name: req.params.name, items: list });
 } catch (error) {
    console.error(error)
 }
});

// API
app.get('/api/lists', async (req,res)=>{
  const data = await loadData();
  res.json(data.lists || {});
});

app.post('/api/lists', async (req,res)=>{
 try {
     const { name } = req.body;
  if(!name) return res.status(400).json({ error: 'name required' });
  const data = await loadData();
  if(data.lists[name]) return res.status(400).json({ error: 'exists' });
  data.lists[name] = [];
  await saveData(data);
  res.json({ ok: true });
 } catch (error) {
    console.error(error)
 }
});

app.post('/api/lists/:name/items', async (req,res)=>{
  try {
    const { source, id } = req.body;
  if(!source || !id) return res.status(400).json({ error: 'source & id required' });
  const data = await loadData();
  const list = data.lists[req.params.name];
  if(!list) return res.status(404).json({ error: 'list not found' });
  list.push({ source: source.toLowerCase(), id, date: new Date().toISOString() });
  await saveData(data);
  res.json({ ok: true });
  } catch (error) {
    console.error(error)
  }
});

app.delete('/api/lists/:name/items/:index', async (req,res)=>{
  try {
    const data = await loadData();
  const list = data.lists[req.params.name];
  if(!list) return res.status(404).json({ error: 'list not found' });
  const idx = Number(req.params.index);
  if(Number.isNaN(idx) || idx < 0 || idx >= list.length) return res.status(400).json({ error: 'invalid index' });
  list.splice(idx,1);
  await saveData(data);
  res.json({ ok: true });
  } catch (error) {
    console.error(error)
  }
});

app.post('/api/sync/:target/:name', async (req,res)=>{
 try {
     const { target, name } = req.params;
  const data = await loadData();
  const list = data.lists[name];
  if(!list) return res.status(404).json({ error: 'list not found' });
  const results = [];
  for(const item of list){
    try{
      if(target === 'radarr' && (item.source === 'imdb' || item.source === 'tmdb')){
        const lookup = item.source === 'imdb' ? await radarrLookup(item.id) : await radarr.get(`/api/v3/movie/lookup/tmdb`, { params: { tmdbid: item.id } }).then(r=>Array.isArray(r.data)?r.data[0]:r.data);
        if(!lookup) { results.push({ item, ok:false, reason:'not found' }); continue; }
        const movie = lookup.tmdbId ? lookup : await radarr.get(`/api/v3/movie/lookup/tmdb`, { params: { tmdbid: lookup.tmdbId } }).then(r=>Array.isArray(r.data)?r.data[0]:r.data);
        await radarrAdd(movie);
        results.push({ item, ok:true });
      } else if(target === 'sonarr' && item.source === 'imdb'){
        const lookup = await sonarrLookupImdb(item.id);
        if(!lookup) { results.push({ item, ok:false, reason:'not found' }); continue; }
        await sonarrAdd(lookup);
        results.push({ item, ok:true });
      } else {
        results.push({ item, ok:false, reason:'unsupported' });
      }
    } catch(err){
      results.push({ item, ok:false, reason: err?.response?.data || err.message || 'error' });
    }
  }
  res.json({ results });
 } catch (error) {
    console.error(error)
 }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log(`Server started on http://localhost:${PORT}`));
