'use strict';

const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const NOMINATIM = (process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org').replace(/\/$/, '');
const CONTACT = process.env.CONTACT || 'admin@example.com';
const TILE_URL = process.env.TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTRIBUTION = process.env.TILE_ATTRIBUTION || '© участники <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';
const USER_AGENT = `RussiaAddressMap/1.0 (${CONTACT})`;
const PHOTON = (process.env.PHOTON_URL || 'https://photon.komoot.io').replace(/\/$/, '');
if (CONTACT === 'admin@example.com') {
  console.warn('ВНИМАНИЕ: не задан CONTACT (ваш email). Основной поиск адресов может отвечать ошибкой 403. Запасной поиск включится автоматически.');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- хранилище адресов ---------- */

let addresses = {};
try {
  addresses = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) || {};
} catch {
  addresses = {};
}

let saveTimer = null;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 500);
}
function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  try {
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(addresses));
    fs.renameSync(tmp, DATA_FILE);
  } catch (e) {
    console.error('Не удалось сохранить данные:', e.message);
  }
}

/* ---------- HTTP ---------- */

const app = express();
app.disable('x-powered-by');
app.use('/leaflet', express.static(path.join(path.dirname(require.resolve('leaflet/package.json')), 'dist')));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/config', (req, res) => {
  res.json({ tileUrl: TILE_URL, attribution: TILE_ATTRIBUTION });
});

/* Nominatim разрешает не больше 1 запроса в секунду, поэтому все запросы идут через общую очередь с кэшем. */
let chain = Promise.resolve();
let lastRequestAt = 0;
let pending = 0;

function nominatim(pathAndQuery) {
  if (pending >= 20) {
    const err = new Error('Слишком много запросов, повторите через несколько секунд');
    err.status = 429;
    return Promise.reject(err);
  }
  pending += 1;
  const job = chain.then(async () => {
    try {
      const wait = lastRequestAt + 1100 - Date.now();
      if (wait > 0) await sleep(wait);
      lastRequestAt = Date.now();
      const r = await fetch(NOMINATIM + pathAndQuery, {
        headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'ru' },
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) {
        const err = new Error('Поиск адресов вернул ошибку ' + r.status);
        err.status = r.status;
        throw err;
      }
      return await r.json();
    } finally {
      pending -= 1;
    }
  });
  chain = job.catch(() => {});
  return job;
}

const cache = new Map();
const CACHE_TTL = 10 * 60 * 1000;
const CACHE_MAX = 500;
function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.t > CACHE_TTL) {
    cache.delete(key);
    return null;
  }
  return hit.v;
}
function cacheSet(key, v) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { t: Date.now(), v });
}

function shortLabel(r) {
  const a = r.address || {};
  const road = a.road || a.pedestrian || a.footway || a.path || a.neighbourhood || a.suburb;
  const street = [road || r.name, a.house_number].filter(Boolean).join(', ');
  const place = a.city || a.town || a.village || a.hamlet || a.municipality || a.county;
  const parts = [street, place, a.state].filter(Boolean);
  const uniq = parts.filter((p, i) => parts.indexOf(p) === i);
  return uniq.length ? uniq.join(', ') : String(r.display_name || 'Адрес без названия');
}

function normalize(r) {
  return {
    key: String(r.osm_type || 'x')[0] + r.osm_id,
    label: shortLabel(r).slice(0, 300),
    lat: Number(r.lat),
    lon: Number(r.lon),
    kind: r.addresstype || r.type || '',
  };
}

/* Запасной поиск Photon (тоже на данных OpenStreetMap), если основной отказывает. */
let nominatimBlockedUntil = 0;

async function photon(pathAndQuery) {
  const r = await fetch(PHOTON + pathAndQuery, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error('Запасной поиск вернул ошибку ' + r.status);
  return r.json();
}

function normalizePhoton(f) {
  const p = (f && f.properties) || {};
  const c = (f && f.geometry && f.geometry.coordinates) || [];
  if (!p.osm_id || !p.osm_type) return null;
  const place = p.city || p.town || p.village || p.district || p.county;
  const street = p.housenumber ? [p.street || p.name, p.housenumber] : [p.name || p.street];
  const parts = [street.filter(Boolean).join(', '), place, p.state].filter(Boolean);
  const uniq = parts.filter((x, i) => parts.indexOf(x) === i);
  return {
    key: String(p.osm_type).toLowerCase()[0] + p.osm_id,
    label: (uniq.join(', ') || 'Адрес без названия').slice(0, 300),
    lat: Number(c[1]),
    lon: Number(c[0]),
    kind: p.osm_value || p.type || '',
    cc: p.countrycode || '',
  };
}

async function searchAddresses(q) {
  if (Date.now() >= nominatimBlockedUntil) {
    try {
      const data = await nominatim(
        '/search?' +
          new URLSearchParams({
            q,
            format: 'jsonv2',
            addressdetails: '1',
            countrycodes: 'ru',
            limit: '8',
            'accept-language': 'ru',
            dedupe: '1',
          })
      );
      return data.map(normalize);
    } catch (e) {
      console.warn('Основной поиск недоступен:', e.message);
      if (e.status === 403 || e.status === 429) nominatimBlockedUntil = Date.now() + 5 * 60 * 1000;
    }
  }
  const data = await photon('/api/?' + new URLSearchParams({ q, limit: '10', bbox: '19,41,180,82' }));
  return (data.features || [])
    .map(normalizePhoton)
    .filter((x) => x && (!x.cc || x.cc.toUpperCase() === 'RU'))
    .slice(0, 8);
}

async function reverseAddress(lat, lon) {
  if (Date.now() >= nominatimBlockedUntil) {
    try {
      const r = await nominatim(
        '/reverse?' +
          new URLSearchParams({
            lat: String(lat),
            lon: String(lon),
            format: 'jsonv2',
            addressdetails: '1',
            zoom: '18',
            'accept-language': 'ru',
          })
      );
      return !r || r.error ? null : normalize(r);
    } catch (e) {
      console.warn('Основной поиск недоступен:', e.message);
      if (e.status === 403 || e.status === 429) nominatimBlockedUntil = Date.now() + 5 * 60 * 1000;
    }
  }
  const data = await photon('/reverse?' + new URLSearchParams({ lat: String(lat), lon: String(lon), limit: '1' }));
  return normalizePhoton((data.features || [])[0]);
}

const SEARCH_DOWN = 'Поиск адресов временно недоступен. Попробуйте через минуту.';

app.get('/api/search', async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 200);
  if (q.length < 3) return res.json([]);
  const ck = 's:' + q.toLowerCase();
  const cached = cacheGet(ck);
  if (cached) return res.json(cached);
  try {
    const out = (await searchAddresses(q)).filter((x) => x && Number.isFinite(x.lat) && Number.isFinite(x.lon));
    cacheSet(ck, out);
    res.json(out);
  } catch (e) {
    console.warn('Поиск не удался:', e.message);
    res.status(e.status === 429 ? 429 : 502).json({ error: e.status === 429 ? e.message : SEARCH_DOWN });
  }
});

app.get('/api/reverse', async (req, res) => {
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  if (!(lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180)) return res.status(400).json({ error: 'Неверные координаты' });
  const ck = `r:${lat.toFixed(5)},${lon.toFixed(5)}`;
  const cached = cacheGet(ck);
  if (cached) return res.json(cached);
  try {
    const out = await reverseAddress(lat, lon);
    if (out && Number.isFinite(out.lat) && Number.isFinite(out.lon)) cacheSet(ck, out);
    res.json(out && Number.isFinite(out.lat) ? out : null);
  } catch (e) {
    console.warn('Определение адреса не удалось:', e.message);
    res.status(e.status === 429 ? 429 : 502).json({ error: e.status === 429 ? e.message : SEARCH_DOWN });
  }
});

/* ---------- WebSocket ---------- */

const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 });

const conns = new Map(); // ws -> { id, name, color, viewing, vt }
const PALETTE = ['#d64550', '#2f7ed8', '#2e9d6a', '#8e5bd0', '#e07a1f', '#0e8f9a', '#c2478a', '#6f8f1e'];

function colorFor(id) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

function cleanName(v) {
  return String(v || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 30);
}

function cleanAddr(a) {
  if (!a || typeof a !== 'object') return null;
  const key = String(a.key || '');
  if (!/^[a-z]\d{1,20}$/.test(key)) return null;
  const lat = Number(a.lat);
  const lon = Number(a.lon);
  if (!(lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180)) return null;
  const label = String(a.label || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 300);
  if (!label) return null;
  return { key, label, lat, lon };
}

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function broadcast(obj) {
  const data = JSON.stringify(obj);
  for (const ws of conns.keys()) if (ws.readyState === 1) ws.send(data);
}

function usersList() {
  const byId = new Map();
  for (const c of conns.values()) {
    const prev = byId.get(c.id);
    if (!prev || c.vt >= prev.vt) byId.set(c.id, c);
  }
  return [...byId.values()].map((c) => ({ id: c.id, name: c.name, color: c.color, viewing: c.viewing }));
}

function broadcastUsers() {
  broadcast({ t: 'users', users: usersList() });
}

wss.on('connection', (ws) => {
  let conn = null;
  let windowStart = Date.now();
  let count = 0;
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));

  ws.on('message', (raw) => {
    const now = Date.now();
    if (now - windowStart > 1000) {
      windowStart = now;
      count = 0;
    }
    if (++count > 40) return;

    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    if (msg.t === 'hello') {
      const id = String(msg.id || '');
      const name = cleanName(msg.name);
      if (!/^[\w-]{8,64}$/.test(id) || !name) return send(ws, { t: 'error', message: 'Введите имя' });
      conn = { id, name, color: colorFor(id), viewing: null, vt: now };
      conns.set(ws, conn);
      send(ws, {
        t: 'init',
        you: { id, name, color: conn.color },
        users: usersList(),
        addresses: Object.values(addresses),
      });
      broadcastUsers();
      return;
    }

    if (!conn) return;

    switch (msg.t) {
      case 'rename': {
        const name = cleanName(msg.name);
        if (!name) return;
        for (const c of conns.values()) if (c.id === conn.id) c.name = name;
        let changed = false;
        for (const a of Object.values(addresses)) {
          if (a.byId === conn.id && a.by !== name) {
            a.by = name;
            changed = true;
            broadcast({ t: 'address', addr: a });
          }
        }
        if (changed) saveSoon();
        send(ws, { t: 'you', you: { id: conn.id, name, color: conn.color } });
        broadcastUsers();
        break;
      }
      case 'viewing': {
        conn.viewing = msg.addr ? cleanAddr(msg.addr) : null;
        conn.vt = now;
        broadcastUsers();
        break;
      }
      case 'claim': {
        const a = cleanAddr(msg.addr);
        if (!a) return;
        const cur = addresses[a.key];
        if (cur && cur.byId !== conn.id) {
          send(ws, { t: 'error', message: `Адрес уже у ${cur.by}` });
          send(ws, { t: 'address', addr: cur });
          return;
        }
        if (cur) return;
        addresses[a.key] = { ...a, status: 'working', by: conn.name, byId: conn.id, at: now };
        saveSoon();
        broadcast({ t: 'address', addr: addresses[a.key] });
        break;
      }
      case 'done':
      case 'reopen': {
        const cur = addresses[String(msg.key || '')];
        if (!cur || cur.byId !== conn.id) return;
        cur.status = msg.t === 'done' ? 'done' : 'working';
        cur.at = now;
        saveSoon();
        broadcast({ t: 'address', addr: cur });
        break;
      }
      case 'release': {
        const key = String(msg.key || '');
        const cur = addresses[key];
        if (!cur || cur.byId !== conn.id) return;
        delete addresses[key];
        saveSoon();
        broadcast({ t: 'address_removed', key });
        break;
      }
    }
  });

  ws.on('close', () => {
    if (conns.delete(ws)) broadcastUsers();
  });
  ws.on('error', () => {});
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);
heartbeat.unref();

function shutdown() {
  if (saveTimer) saveNow();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, () => {
  console.log(`Карта запущена: http://localhost:${PORT}`);
});
