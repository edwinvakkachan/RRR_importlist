// bot.js
require('dotenv').config();
const { Telegraf } = require('telegraf');
const axios = require('axios');
const fs = require('fs').promises;

const bot = new Telegraf(process.env.BOT_TOKEN);

// small JSON-based store for lists
const DATA_FILE = process.env.DATA_FILE || './lists.json';
async function loadData(){
  try { return JSON.parse(await fs.readFile(DATA_FILE,'utf8')); }
  catch(e){ return { lists: {} }; }
}
async function saveData(data){ await fs.writeFile(DATA_FILE, JSON.stringify(data,null,2)); }

// Helpers: Radarr
const radarrAxios = axios.create({
  baseURL: process.env.RADARR_URL,
  params: { apikey: process.env.RADARR_APIKEY }
});
async function radarrLookupByImdb(imdbId){
  // imdbId like tt1234567 (without prefix or with)
  const id = imdbId.startsWith('tt')? imdbId : `tt${imdbId}`;
  const res = await radarrAxios.get(`/api/v3/movie/lookup/imdb`, { params: { imdbid: id } });
  return res.data; // array or object depending
}
async function radarrLookupByTmdb(tmdbId){
  const res = await radarrAxios.get(`/api/v3/movie/lookup/tmdb`, { params: { tmdbid: tmdbId } });
  return res.data;
}
async function radarrAddMovie(movieObj){
  // movieObj should include at least tmdbId. Build minimal add body:
  const body = {
    tmdbId: movieObj.tmdbId,
    title: movieObj.title || movieObj.originalTitle || movieObj.titleSlug || "Unknown",
    rootFolderPath: process.env.RADARR_ROOT,
    qualityProfileId: Number(process.env.RADARR_QUALITY_PROFILE_ID || 1),
    monitored: true,
    addOptions: { searchForMovie: true }
  };
  const res = await radarrAxios.post(`/api/v3/movie`, body, { headers: {'Content-Type':'application/json'} });
  return res.data;
}

// Helpers: Sonarr
const sonarrAxios = axios.create({
  baseURL: process.env.SONARR_URL,
  params: { apikey: process.env.SONARR_APIKEY }
});
async function sonarrLookupByImdb(imdbId){
  const id = imdbId.startsWith('tt')? `imdb:${imdbId}` : `imdb:tt${imdbId}`;
  const res = await sonarrAxios.get(`/api/v3/series/lookup`, { params: { term: id } });
  return res.data; // array of matches
}
async function sonarrAddSeries(seriesObj){
  // seriesObj must be enriched with a path, qualityProfileId, seasonFolder
  const body = {
    tvdbId: seriesObj.tvdbId || seriesObj.tvdbId || 0,
    title: seriesObj.title,
    rootFolderPath: process.env.SONARR_ROOT,
    qualityProfileId: Number(process.env.SONARR_QUALITY_PROFILE_ID || 1),
    seasonFolder: true,
    monitored: true,
    addOptions: { searchForMissingEpisodes: true }
  };
  const res = await sonarrAxios.post(`/api/v3/series`, body, { headers: {'Content-Type':'application/json'} });
  return res.data;
}

// Bot commands
bot.start(ctx => ctx.reply('Welcome. Use /newlist <name>, /addmovie <list> imdb:tt1234, /list <name>, /sync <list> radarr|sonarr'));

bot.command('newlist', async ctx => {
  const name = ctx.message.text.split(' ').slice(1).join(' ').trim();
  if(!name) return ctx.reply('Usage: /newlist <name>');
  const data = await loadData();
  if(data.lists[name]) return ctx.reply('List already exists');
  data.lists[name] = [];
  await saveData(data);
  ctx.reply(`List "${name}" created.`);
});

bot.command('addmovie', async ctx => {
  // /addmovie <list> imdb:tt12345 or tmdb:12345
  const args = ctx.message.text.split(' ').slice(1);
  if(args.length < 2) return ctx.reply('Usage: /addmovie <list> imdb:tt12345 or tmdb:12345');
  const listName = args[0];
  const idSpec = args[1];
  const [source, id] = idSpec.includes(':') ? idSpec.split(':') : ['imdb', idSpec];
  const data = await loadData();
  if(!data.lists[listName]) return ctx.reply('List not found');
  data.lists[listName].push({ source: source.toLowerCase(), id, addedBy: ctx.from.username || ctx.from.id, date: new Date().toISOString() });
  await saveData(data);
  ctx.reply(`Added ${source}:${id} to ${listName}`);
});

bot.command('list', async ctx => {
  const name = ctx.message.text.split(' ').slice(1).join(' ').trim();
  const data = await loadData();
  if(!name) return ctx.reply('Lists: ' + Object.keys(data.lists).join(', '));
  if(!data.lists[name]) return ctx.reply('List not found');
  const items = data.lists[name].map((it,i)=>`${i+1}. ${it.source}:${it.id}`).join('\n') || '(empty)';
  ctx.reply(`Items in ${name}:\n${items}`);
});

bot.command('sync', async ctx => {
  // /sync <list> radarr|sonarr
  const [_, listName, target] = ctx.message.text.split(' ');
  if(!listName || !target) return ctx.reply('Usage: /sync <list> radarr|sonarr');
  const data = await loadData();
  const list = data.lists[listName];
  if(!list) return ctx.reply('List not found');
  ctx.reply(`Starting sync of ${listName} -> ${target} (${list.length} items).`);
  for(const item of list){
    try {
      if(target.toLowerCase() === 'radarr' && (item.source === 'imdb' || item.source === 'tmdb')){
        const lookup = item.source === 'imdb' ? await radarrLookupByImdb(item.id) : await radarrLookupByTmdb(item.id);
        // lookup might return array or object; choose first entry
        const found = Array.isArray(lookup) ? lookup[0] : lookup;
        if(!found) { ctx.reply(`Not found in Radarr: ${item.source}:${item.id}`); continue; }
        // ensure tmdbId available (Radarr add expects tmdbId)
        const movie = found.tmdbId ? found : (await radarrLookupByTmdb(found.tmdbId));
        const added = await radarrAddMovie(movie);
        ctx.reply(`Added to Radarr: ${movie.title || movie.titleSlug} (tmdb:${movie.tmdbId})`);
      } else if(target.toLowerCase() === 'sonarr' && item.source === 'imdb'){
        const lookup = await sonarrLookupByImdb(item.id);
        const found = Array.isArray(lookup) ? lookup[0] : lookup;
        if(!found) { ctx.reply(`Not found in Sonarr: ${item.source}:${item.id}`); continue; }
        const added = await sonarrAddSeries(found);
        ctx.reply(`Added to Sonarr: ${found.title} (tvdb:${found.tvdbId || 'N/A'})`);
      } else {
        ctx.reply(`Skipping unsupported combination: ${item.source} -> ${target}`);
      }
    } catch(err) {
      console.error(err?.response?.data || err.message || err);
      ctx.reply(`Error adding ${item.source}:${item.id} -> ${err.message || 'see logs'}`);
    }
  }
  ctx.reply('Sync complete.');
});

bot.launch().then(()=>console.log('Bot started'));
process.once('SIGINT', ()=>bot.stop('SIGINT'));
process.once('SIGTERM', ()=>bot.stop('SIGTERM'));
