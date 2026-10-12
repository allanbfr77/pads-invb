// Pads Igreja — servidor (roda no PC ligado à mesa de som)
//   /          controle remoto (celular do tecladista)
//   /player    página que toca o áudio (PC)
//   /api/...   integração (app de projeção, Stream Deck, scripts)
'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
let QRCode = null;
try { QRCode = require('qrcode'); } catch { /* QR é opcional */ }

const DIR = __dirname;
const DATA_DIR = process.env.PADS_DATA_DIR || DIR;
const SAMPLES_DIR = process.env.PADS_SAMPLES_DIR || path.join(DIR, 'samples');
const PORT = Number(process.env.PORT) || 3000;
const DATA_FILE = path.join(DATA_DIR, 'data.json');

function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }

// ---------------------------------------------------------------- config / PIN
const config = readJson(path.join(DATA_DIR, 'config.json')) || readJson(path.join(DIR, 'config.json')) || {};
const PIN = String(process.env.PADS_PIN ?? config.pin ?? '').trim();

const isLocal = (a) => a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
function pinOk(p) {
  if (!PIN) return true;
  const a = Buffer.from(String(p || ''));
  const b = Buffer.from(PIN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const fails = new Map(); // ip -> { n, until }
const blocked = (ip) => (fails.get(ip)?.until || 0) > Date.now();
function noteFail(ip) {
  const f = fails.get(ip) || { n: 0, until: 0 };
  f.n++;
  if (f.n >= 5) { f.until = Date.now() + 60000; f.n = 0; }
  fails.set(ip, f);
}

// ---------------------------------------------------------------- notas e samples
const SEMI = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
// depois da nota: "m", "min", "menor" = menor ("maj" e "Mellow" não contam)
const MINOR_RE = /^(m(?!aj)|[\s_-]*([Mm]in|[Mm]enor))/;
function noteInfo(s) { // "Bbm" -> { n: 10, minor: true }
  const m = /^([A-Ga-g])([#b♯♭]?)([\s\S]*)$/.exec(String(s).trim());
  if (!m) return null;
  let n = SEMI[m[1].toUpperCase()];
  if (m[2] === '#' || m[2] === '♯') n++;
  else if (m[2] === 'b' || m[2] === '♭') n--;
  return { n: (n + 12) % 12, minor: MINOR_RE.test(m[3]) };
}
// undefined = inválido, null = desligar, { key, minor } (minor null = manter o modo atual)
function parseKey(v) {
  if (v === null || v === undefined || v === '' || v === 'off') return null;
  if (typeof v === 'number') return Number.isInteger(v) && v >= 0 && v <= 11 ? { key: v, minor: null } : undefined;
  if (/^\d+$/.test(String(v))) return parseKey(Number(v));
  const i = noteInfo(v);
  return i ? { key: i.n, minor: i.minor } : undefined;
}
function normKey(v) {
  const r = parseKey(v);
  return r === undefined || r === null ? r : r.key;
}
function parseMode(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (['min', 'minor', 'menor', 'm'].includes(s)) return 'min';
  if (['maj', 'major', 'maior'].includes(s)) return 'maj';
  return undefined;
}

const AUDIO_EXT = /\.(wav|mp3|ogg|flac|m4a|aac)$/i;
const MIME = { wav: 'audio/wav', mp3: 'audio/mpeg', ogg: 'audio/ogg', flac: 'audio/flac', m4a: 'audio/mp4', aac: 'audio/aac' };
let sampleFiles = {}; // pasta -> { maj: { semitom: arquivo }, min: { semitom: arquivo } }
const sampleCount = (set) => Object.keys(set.maj).length + Object.keys(set.min).length;
function scanSamples() {
  const out = {};
  try {
    for (const d of fs.readdirSync(SAMPLES_DIR, { withFileTypes: true })) {
      if (!d.isDirectory() || d.name.startsWith('.')) continue;
      const set = { maj: {}, min: {} };
      for (const f of fs.readdirSync(path.join(SAMPLES_DIR, d.name)).sort()) {
        if (!AUDIO_EXT.test(f)) continue;
        const i = noteInfo(f);
        if (!i) continue;
        const map = set[i.minor ? 'min' : 'maj'];
        if (!(i.n in map)) map[i.n] = f;
      }
      if (sampleCount(set)) out[d.name] = set;
    }
  } catch { /* pasta ainda não existe */ }
  sampleFiles = out;
}

const BUILTIN = [
  { id: 'warm', label: 'Quente', type: 'synth' },
  { id: 'strings', label: 'Cordas', type: 'synth' },
  { id: 'ethereal', label: 'Etéreo', type: 'synth' },
];
const timbreList = () => [
  ...BUILTIN,
  ...Object.keys(sampleFiles).map((f) => ({ id: 'sample:' + f, label: f.replace(/[_-]+/g, ' '), type: 'sample', notes: sampleCount(sampleFiles[f]) })),
];
const timbreValid = (id) => timbreList().some((t) => t.id === id);

// ---------------------------------------------------------------- estado
// Dois pads (camadas) tocam juntos; cada um tem timbre, nível e fades próprios. O pad 2 pode ficar desligado (timbre null).
const mkLayers = (t1, fade, t2 = null, level2 = 0.6) => [
  { timbre: t1, level: 1, fadeIn: fade, fadeOut: fade },
  { timbre: t2, level: level2, fadeIn: fade, fadeOut: fade },
];
const state = {
  key: null, // 0..11 ou null
  mode: 'maj', // 'maj' | 'min' (só muda o arquivo de sample usado)
  playing: false,
  volume: 0.7,
  tone: 0.5, // 0.5 = neutro
  reverb: 0.6,
  tuning: 0, // cents (-50..50)
  setlistIndex: -1,
  layers: mkLayers('warm', 3),
};
let presets = [
  { name: 'Adoração', layers: mkLayers('warm', 4), volume: 0.6, tone: 0.45, reverb: 0.6 },
  { name: 'Oração', layers: mkLayers('ethereal', 6), volume: 0.45, tone: 0.4, reverb: 0.75 },
  { name: 'Ministração', layers: mkLayers('warm', 5, 'ethereal', 0.5), volume: 0.5, tone: 0.35, reverb: 0.65 },
  { name: 'Louvor', layers: mkLayers('strings', 3), volume: 0.75, tone: 0.6, reverb: 0.5 },
];
let setlist = []; // [{ name, key, minor }]

const clamp = (v, a, b, d) => { v = Number(v); return Number.isFinite(v) ? Math.min(b, Math.max(a, v)) : d; };
const cleanStr = (s, n) => String(s ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);

function cleanLayer(l, base) {
  l = l && typeof l === 'object' ? l : {};
  return {
    timbre: l.timbre === null ? null : (typeof l.timbre === 'string' ? l.timbre : base.timbre),
    level: clamp(l.level, 0, 1, base.level),
    fadeIn: clamp(l.fadeIn, 0.5, 10, base.fadeIn),
    fadeOut: clamp(l.fadeOut, 0.5, 10, base.fadeOut),
  };
}
function cleanLayers(arr, base) {
  arr = Array.isArray(arr) ? arr : [];
  const out = [cleanLayer(arr[0], base[0]), cleanLayer(arr[1], base[1])];
  if (!out[0].timbre) out[0].timbre = base[0].timbre || 'warm';
  return out;
}
// timbre que não existe mais (pasta de samples apagada): pad 1 volta ao Quente, pad 2 desliga
function fixTimbres(layers) {
  layers.forEach((l, i) => { if (l.timbre && !timbreValid(l.timbre)) l.timbre = i === 0 ? 'warm' : null; });
}

// ---------------------------------------------------------------- persistência
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = DATA_FILE + '.tmp';
      const { key, mode, volume, tone, reverb, tuning, setlistIndex, layers } = state;
      fs.writeFileSync(tmp, JSON.stringify({ state: { key, mode, volume, tone, reverb, tuning, setlistIndex, layers }, presets, setlist }, null, 2));
      fs.renameSync(tmp, DATA_FILE);
    } catch (e) { console.error('Não foi possível salvar:', e.message); }
  }, 400);
}
function load() {
  const d = readJson(DATA_FILE);
  if (!d) return;
  const s = d.state || {};
  if (normKey(s.key) !== undefined) state.key = normKey(s.key);
  state.mode = parseMode(s.mode) || 'maj';
  state.volume = clamp(s.volume, 0, 1, state.volume);
  state.tone = clamp(s.tone, 0, 1, state.tone);
  state.reverb = clamp(s.reverb, 0, 1, state.reverb);
  state.tuning = clamp(s.tuning, -50, 50, 0);
  let layers = s.layers;
  if (!Array.isArray(layers)) { // formato antigo: um timbre e um fade só
    const f = clamp(s.fade, 0.5, 10, 3);
    layers = [{ timbre: s.timbre, fadeIn: f, fadeOut: f }, { timbre: null, fadeIn: f, fadeOut: f }];
  }
  state.layers = cleanLayers(layers, state.layers);
  fixTimbres(state.layers);
  if (Array.isArray(d.presets) && d.presets.length === 4) {
    presets = d.presets.map((p, i) => {
      const dflt = presets[i];
      let pl = p.layers;
      if (!Array.isArray(pl)) {
        const f = clamp(p.fade, 0.5, 10, 3);
        pl = [{ timbre: typeof p.timbre === 'string' ? p.timbre : 'warm', fadeIn: f, fadeOut: f }, { timbre: null, fadeIn: f, fadeOut: f }];
      }
      return {
        name: cleanStr(p.name, 24) || dflt.name,
        layers: cleanLayers(pl, dflt.layers),
        volume: clamp(p.volume, 0, 1, 0.6), tone: clamp(p.tone, 0, 1, 0.5), reverb: clamp(p.reverb, 0, 1, 0.6),
      };
    });
  }
  if (Array.isArray(d.setlist)) setlist = sanitizeSetlist(d.setlist);
  state.setlistIndex = Number.isInteger(s.setlistIndex) && s.setlistIndex < setlist.length ? s.setlistIndex : -1;
}
function sanitizeSetlist(items) {
  return items.slice(0, 100).map((it) => {
    it = it && typeof it === 'object' ? it : {};
    const pk = parseKey(it.key);
    const key = pk ? pk.key : null;
    let minor = false;
    if (typeof it.minor === 'boolean') minor = it.minor;
    else if (it.mode !== undefined) minor = parseMode(it.mode) === 'min';
    else if (pk) minor = !!pk.minor;
    return { name: cleanStr(it.name, 60) || 'Sem nome', key, minor: key === null ? false : minor };
  });
}

scanSamples();
load();

// ---------------------------------------------------------------- comandos (WebSocket e HTTP)
function playSetlistItem(i) {
  state.setlistIndex = i;
  const it = setlist[i];
  if (it && it.key !== null) { state.key = it.key; state.mode = it.minor ? 'min' : 'maj'; state.playing = true; }
}
const layerIdx = (m) => { const i = m.layer === undefined ? 0 : Number(m.layer); return i === 0 || i === 1 ? i : -1; };

// retorna true se algo mudou e deve ser transmitido
function exec(m) {
  switch (m.type) {
    case 'key': {
      const pk = parseKey(m.value !== undefined ? m.value : m.key);
      if (pk === undefined) return false;
      if (pk === null) { state.playing = false; break; }
      state.key = pk.key; state.playing = true;
      // "Am" / mode explícito escolhem o modo; número puro mantém o atual
      const mode = m.mode !== undefined ? parseMode(m.mode) : (pk.minor === null ? undefined : (pk.minor ? 'min' : 'maj'));
      if (mode) state.mode = mode;
      break;
    }
    case 'mode': { const md = parseMode(m.value); if (!md) return false; state.mode = md; break; }
    case 'fadeout': case 'stop': state.playing = false; break;
    case 'volume': state.volume = clamp(m.value, 0, 1, state.volume); break;
    case 'tone': state.tone = clamp(m.value, 0, 1, state.tone); break;
    case 'reverb': state.reverb = clamp(m.value, 0, 1, state.reverb); break;
    case 'tuning': state.tuning = Math.round(clamp(m.value, -50, 50, state.tuning)); break;
    case 'fade': // atalho antigo: o mesmo tempo de entrada e saída nos dois pads
      for (const l of state.layers) l.fadeIn = l.fadeOut = clamp(m.value, 0.5, 10, l.fadeIn);
      break;
    case 'layerFade': {
      const i = layerIdx(m);
      if (i < 0 || (m.which !== 'in' && m.which !== 'out')) return false;
      const f = m.which === 'in' ? 'fadeIn' : 'fadeOut';
      state.layers[i][f] = clamp(m.value, 0.5, 10, state.layers[i][f]);
      break;
    }
    case 'level': {
      const i = layerIdx(m);
      if (i < 0) return false;
      state.layers[i].level = clamp(m.value, 0, 1, state.layers[i].level);
      break;
    }
    case 'timbre': {
      const i = layerIdx(m);
      if (i < 0) return false;
      if (i === 1 && (m.value === null || m.value === '' || m.value === 'off')) state.layers[1].timbre = null; // pad 2 pode ser desligado
      else if (timbreValid(m.value)) state.layers[i].timbre = m.value;
      else return false;
      break;
    }
    case 'preset': {
      const p = presets[Number(m.n)];
      if (!p) return false;
      state.layers = p.layers.map((l, i) => ({ ...l, timbre: l.timbre && timbreValid(l.timbre) ? l.timbre : (i === 0 ? state.layers[0].timbre : null) }));
      state.volume = p.volume; state.tone = p.tone; state.reverb = p.reverb;
      break;
    }
    case 'savePreset': {
      const n = Number(m.n);
      if (!presets[n]) return false;
      presets[n] = {
        name: cleanStr(m.name, 24) || presets[n].name,
        layers: state.layers.map((l) => ({ ...l })),
        volume: state.volume, tone: state.tone, reverb: state.reverb,
      };
      break;
    }
    case 'setlist': {
      if (!Array.isArray(m.items)) return false;
      setlist = sanitizeSetlist(m.items);
      const idx = m.index !== undefined ? Number(m.index) : state.setlistIndex;
      state.setlistIndex = Number.isInteger(idx) && idx >= 0 && idx < setlist.length ? idx : -1;
      break;
    }
    case 'goto': {
      const i = Number(m.index);
      if (!Number.isInteger(i) || i < 0 || i >= setlist.length) return false;
      playSetlistItem(i);
      break;
    }
    case 'next': {
      if (!setlist.length) return false;
      playSetlistItem(Math.min(setlist.length - 1, state.setlistIndex + 1));
      break;
    }
    case 'prev': {
      if (!setlist.length) return false;
      playSetlistItem(Math.max(0, (state.setlistIndex < 0 ? 1 : state.setlistIndex) - 1));
      break;
    }
    case 'rescan':
      scanSamples();
      fixTimbres(state.layers);
      break;
    default: return false;
  }
  save();
  return true;
}

// ---------------------------------------------------------------- HTTP
const FILES = {
  '/': ['remote.html', 'text/html; charset=utf-8'],
  '/player': ['player.html', 'text/html; charset=utf-8'],
  '/engine.js': ['engine.js', 'application/javascript; charset=utf-8'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
  '/sw.js': ['sw.js', 'application/javascript'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'],
};

function send(res, code, body, type = 'text/plain; charset=utf-8', extra = {}) {
  res.writeHead(code, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', ...extra });
  res.end(body);
}
const json = (res, code, obj) => send(res, code, JSON.stringify(obj), 'application/json; charset=utf-8', { 'Cache-Control': 'no-store' });

function lanUrls() {
  const proto = useHttps ? 'https' : 'http';
  return Object.values(os.networkInterfaces()).flat()
    .filter((i) => i.family === 'IPv4' && !i.internal)
    .map((i) => `${proto}://${i.address}:${PORT}/`);
}

function readBody(req, limit = 65536) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => { n += c.length; if (n > limit) { reject(new Error('grande')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function counts() {
  let players = 0, remotes = 0;
  for (const c of clients.values()) if (c.authed) (c.role === 'player' ? players++ : remotes++);
  return { players, remotes };
}
function snapshot() {
  return { type: 'state', state: { ...state }, presets, setlist, timbres: timbreList(), samples: sampleFiles, pin: !!PIN, ...counts() };
}

async function api(req, res, u) {
  const ip = req.socket.remoteAddress;
  if (PIN && !isLocal(ip)) {
    if (blocked(ip)) return json(res, 429, { ok: false, error: 'bloqueado por 1 minuto' });
    if (!pinOk(u.searchParams.get('pin') || req.headers['x-pin'])) { noteFail(ip); return json(res, 401, { ok: false, error: 'PIN inválido' }); }
  }
  const q = u.searchParams;
  const route = u.pathname.replace(/^\/api\/?/, '').replace(/\/$/, '');
  const done = (changed) => { if (changed) broadcast(); json(res, 200, { ok: true, ...snapshot() }); };

  switch (route) {
    case 'state': return json(res, 200, { ok: true, ...snapshot() });
    case 'info': return json(res, 200, { ok: true, urls: lanUrls(), pin: !!PIN, qr: !!QRCode });
    case 'key': {
      const raw = q.get('k');
      if (normKey(raw) === undefined) return json(res, 400, { ok: false, error: 'tom inválido (ex.: G, Bb, F#, 0-11 ou off)' });
      return done(exec({ type: 'key', value: raw, mode: q.get('mode') ?? undefined }));
    }
    case 'fadeout': case 'stop': return done(exec({ type: 'fadeout' }));
    case 'volume': { let v = Number(q.get('v')); if (v > 1) v /= 100; return done(exec({ type: 'volume', value: v })); }
    case 'timbre': return done(exec({ type: 'timbre', value: q.get('id'), layer: Number(q.get('layer') || 1) - 1 }));
    case 'mode': return done(exec({ type: 'mode', value: q.get('m') }));
    case 'level': { let v = Number(q.get('v')); if (v > 1) v /= 100; return done(exec({ type: 'level', layer: Number(q.get('layer') || 1) - 1, value: v })); }
    case 'reverb': { let v = Number(q.get('v')); if (v > 1) v /= 100; return done(exec({ type: 'reverb', value: v })); }
    case 'preset': return done(exec({ type: 'preset', n: Number(q.get('n')) - 1 }));
    case 'next': return done(exec({ type: 'next' }));
    case 'prev': return done(exec({ type: 'prev' }));
    case 'goto': return done(exec({ type: 'goto', index: Number(q.get('i')) - 1 }));
    case 'rescan': return done(exec({ type: 'rescan' }));
    case 'setlist': {
      if (req.method !== 'POST') return json(res, 200, { ok: true, setlist, index: state.setlistIndex });
      try {
        const body = JSON.parse(await readBody(req));
        const items = Array.isArray(body) ? body : body.items;
        return done(exec({ type: 'setlist', items, index: Array.isArray(body) ? -1 : body.index }));
      } catch { return json(res, 400, { ok: false, error: 'JSON inválido: envie [{"name":"...","key":"G"}]' }); }
    }
    default: return json(res, 404, { ok: false, error: 'rota desconhecida' });
  }
}

async function handler(req, res) {
  let u;
  try { u = new URL(req.url, 'http://localhost'); } catch { return send(res, 400, 'Bad request'); }
  const p = u.pathname;

  if (p.startsWith('/api/')) {
    try { return await api(req, res, u); } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  if (p === '/qr.svg') {
    const target = u.searchParams.get('url') || '';
    if (!QRCode || !/^https?:\/\/[\w.:\-\[\]]+\/?$/.test(target)) return send(res, 404, 'Sem QR');
    try { return send(res, 200, await QRCode.toString(target, { type: 'svg', margin: 1 }), 'image/svg+xml'); }
    catch { return send(res, 500, 'Erro'); }
  }

  if (p.startsWith('/samples/')) {
    const parts = p.split('/').slice(2).map((s) => { try { return decodeURIComponent(s); } catch { return ''; } });
    if (parts.length !== 2) return send(res, 404, 'Not found');
    const [folder, file] = parts;
    const set = sampleFiles[folder];
    const allowed = set && (Object.values(set.maj).includes(file) || Object.values(set.min).includes(file));
    if (!allowed) return send(res, 404, 'Not found');
    const ext = path.extname(file).slice(1).toLowerCase();
    const stream = fs.createReadStream(path.join(SAMPLES_DIR, folder, file));
    stream.on('error', () => send(res, 500, 'Erro'));
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    return stream.pipe(res);
  }

  const entry = FILES[p];
  if (!entry) return send(res, 404, 'Not found');
  fs.readFile(path.join(DIR, entry[0]), (err, data) => {
    if (err) return send(res, 500, 'Erro');
    send(res, 200, data, entry[1], { 'Cache-Control': 'no-cache' });
  });
}

// HTTPS opcional: cert.pem e key.pem na pasta de dados ou do app
const certDir = [DATA_DIR, DIR].find((d) => fs.existsSync(path.join(d, 'cert.pem')) && fs.existsSync(path.join(d, 'key.pem')));
const useHttps = !!certDir;
const server = useHttps
  ? https.createServer({ cert: fs.readFileSync(path.join(certDir, 'cert.pem')), key: fs.readFileSync(path.join(certDir, 'key.pem')) }, handler)
  : http.createServer(handler);

// ---------------------------------------------------------------- WebSocket
const clients = new Map(); // ws -> { role, authed, ip }
const wss = new WebSocketServer({
  server,
  // impede que um site aberto em outro celular da rede controle o app
  verifyClient: ({ origin, req }) => {
    if (!origin) return true;
    try { return new URL(origin).host === req.headers.host; } catch { return false; }
  },
});

function broadcast() {
  const msg = JSON.stringify(snapshot());
  for (const [ws, c] of clients) if (c.authed && ws.readyState === 1) ws.send(msg);
}

wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress;
  const c = { role: 'remote', authed: !PIN || isLocal(ip), ip };
  clients.set(ws, c);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.send(JSON.stringify({ type: 'hello_ack', pinRequired: !!PIN, authed: c.authed }));

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.type !== 'string') return;

    if (m.type === 'auth') {
      if (c.authed) { ws.send(JSON.stringify({ type: 'auth', ok: true })); return ws.send(JSON.stringify(snapshot())); }
      if (blocked(c.ip)) return ws.send(JSON.stringify({ type: 'auth', ok: false, blocked: true }));
      if (pinOk(m.pin)) {
        c.authed = true;
        ws.send(JSON.stringify({ type: 'auth', ok: true }));
        ws.send(JSON.stringify(snapshot()));
        return broadcast();
      }
      noteFail(c.ip);
      return ws.send(JSON.stringify({ type: 'auth', ok: false, blocked: blocked(c.ip) }));
    }
    if (!c.authed) return ws.send(JSON.stringify({ type: 'denied' }));

    if (m.type === 'hello') {
      c.role = m.role === 'player' ? 'player' : 'remote';
      return broadcast();
    }
    if (exec(m)) broadcast();
  });

  ws.on('close', () => { clients.delete(ws); broadcast(); });
  ws.on('error', () => {});
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* ignora */ }
  }
}, 20000).unref();

server.listen(PORT, '0.0.0.0', () => {
  const proto = useHttps ? 'https' : 'http';
  console.log('\n  PADS IGREJA\n');
  console.log(`  No PC (som):          ${proto}://localhost:${PORT}/player`);
  lanUrls().forEach((url) => console.log(`  No celular (controle): ${url}`));
  console.log(PIN ? '\n  Proteção por PIN: ligada' : '\n  Proteção por PIN: desligada (defina "pin" em config.json)');
  const n = Object.keys(sampleFiles).length;
  console.log(`  Samples: ${n ? n + ' conjunto(s) encontrado(s)' : 'nenhum (usando timbres sintetizados)'}  -> ${SAMPLES_DIR}\n`);
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`\n  A porta ${PORT} já está em uso. Feche a outra instância ou use PORT=3001.\n`);
  else console.error(e);
  process.exitCode = 1;
});

module.exports = { server };
