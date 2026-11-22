// Kid Racer server (Neon Racer + Sunny Kart): serves the TV and phone pages and relays messages over WebSocket.
//
// Runs two ways:
//  * At home (npm start): plain http on PORT plus https on HTTPS_PORT with a self-signed certificate for this computer's
//    LAN address (phones need https for tilt steering).
//  * Hosted (Railway sets RAILWAY_ENVIRONMENT; or set HOSTED=1): one http port (PORT); the host adds https in front.
//
// Rooms: every TV screen has its own room code (made up by the TV, see public/js/room.js) and phones join that room
// from the QR code, so several homes can share one hosted server. One TV per room, up to 4 phones.
//
// Closed beta: set BETA_CODE (e.g. on Railway → Variables) and every page needs the invite code once per device
// (?k=CODE in the link, or typed into the small form). The QR on the TV carries the code, so phones don't have to type it.
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import QRCode from 'qrcode';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PUBLIC = path.join(ROOT, 'public');
const THREE = path.join(ROOT, 'node_modules', 'three');
const PORT = Number(process.env.PORT || 8080);
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 8443);
const HOSTED = !!(process.env.RAILWAY_ENVIRONMENT || process.env.HOSTED);
const BETA_CODE = (process.env.BETA_CODE || '').trim();
const BETA_TOKEN = BETA_CODE ? crypto.createHash('sha256').update('kr:' + BETA_CODE).digest('hex').slice(0, 32) : '';
const DEBUG_LOG = !HOSTED || process.env.DEBUG_LOG === '1';         // accept ?debug=1 reports from TV pages
const LOG_REQUESTS = !HOSTED || process.env.LOG_REQUESTS === '1';
const MAX_PLAYERS = 4, MAX_ROOMS = 300;

// this computer's address on the home network (prefers 192.168.x.x / 10.x.x.x / 172.16-31.x.x over VPN and virtual
// adapters). Override with HOST_IP=192.168.1.20 if the printed address doesn't work.
function lanIP() {
  const all = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) all.push({ name, a: i.address });
  }
  const home = (a) => /^192\.168\./.test(a) ? 3 : /^10\./.test(a) ? 2 : /^172\.(1[6-9]|2\d|3[01])\./.test(a) ? 1 : 0;
  const virt = (n) => /vbox|vmnet|vethernet|docker|utun|tun|tap|wsl|hyper-v|zt|tailscale/i.test(n);
  all.sort((x, y) => (virt(x.name) - virt(y.name)) || (home(y.a) - home(x.a)));
  return all.length ? all[0].a : 'localhost';
}
const IP = HOSTED ? null : (process.env.HOST_IP || lanIP());

// Phones need https:// for tilt steering (motion sensors are blocked on plain http). At home a self-signed certificate
// for this computer's LAN address is generated with the built-in openssl; hosted, the platform provides real https.
function certificate() {
  if (HOSTED) return null;
  const dir = path.join(ROOT, '.cert');
  const key = path.join(dir, 'key.pem'), crt = path.join(dir, 'cert.pem'), ipf = path.join(dir, 'ip.txt');
  try {
    if (fs.existsSync(crt) && fs.readFileSync(ipf, 'utf8') === IP) return { key: fs.readFileSync(key), cert: fs.readFileSync(crt) };
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '825', '-keyout', key, '-out', crt,
      '-subj', '/CN=Neon Racer', '-addext', `subjectAltName=IP:${IP},IP:127.0.0.1,DNS:localhost`], { stdio: 'ignore' });
    fs.writeFileSync(ipf, IP);
    return { key: fs.readFileSync(key), cert: fs.readFileSync(crt) };
  } catch (e) {
    console.warn('Could not create an https certificate (tilt steering disabled):', e.message);
    return null;
  }
}
const TLS = certificate();

// where phones should go: hosted = the address the TV used; at home = this computer's LAN address
function joinBase(req) {
  if (HOSTED) {
    const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
    return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;
  }
  return TLS ? `https://${IP}:${HTTPS_PORT}` : `http://${IP}:${PORT}`;
}

// ------------------------------------------------------------------ static files (revalidated with Last-Modified, text gzipped)
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.glb': 'model/gltf-binary', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg',
};
const GZIP = new Set(['.html', '.js', '.css', '.json', '.svg', '.glb']);
function send(req, res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('not found'); }
    const ext = path.extname(file), mod = st.mtime.toUTCString();
    const headers = { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'Last-Modified': mod };
    if (req.headers['if-modified-since'] === mod) { res.writeHead(304, headers); return res.end(); }
    const stream = fs.createReadStream(file);
    if (GZIP.has(ext) && /\bgzip\b/.test(req.headers['accept-encoding'] || '') && st.size > 1024) {
      res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' });
      return stream.pipe(zlib.createGzip({ level: 6 })).pipe(res);
    }
    res.writeHead(200, { ...headers, 'Content-Length': st.size });
    stream.pipe(res);
  });
}

// ------------------------------------------------------------------ closed-beta gate
const cookies = (req) => Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((a) => a[0]).map(([k, ...v]) => [k, v.join('=')]));
const hasInvite = (req) => !BETA_CODE || cookies(req).kr_beta === BETA_TOKEN;
const PAGES = new Set(['/', '/neon', '/neon/', '/sunny', '/sunny/', '/play']);
function gatePage(res, wrong) {
  res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Kid Racer</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0b2d6e;color:#fff;font-family:system-ui,sans-serif}
form{text-align:center;padding:24px}h1{font-size:30px;margin:0 0 8px}p{opacity:.85;margin:0 0 18px}
input{font-size:28px;padding:10px 14px;border-radius:12px;border:0;width:220px;text-align:center;text-transform:uppercase;letter-spacing:3px}
button{font-size:24px;font-weight:900;padding:12px 30px;border-radius:14px;border:0;background:#ffd21f;color:#0b2d6e;margin-top:14px}.bad{color:#ff9a9a}</style></head>
<body><form method="get"><h1>🏎️ Kid Racer</h1><p>Closed beta: enter your invite code</p>
<input name="k" autofocus autocomplete="off" autocapitalize="characters"><br><button>GO</button>${wrong ? '<p class="bad" style="margin-top:14px">That code didn\'t work. Try again.</p>' : ''}</form></body></html>`);
}

async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  let p;
  try { p = decodeURIComponent(url.pathname); } catch { res.writeHead(400); return res.end(); }
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim().replace('::ffff:', '');
  if (LOG_REQUESTS && !p.startsWith('/vendor/') && !p.startsWith('/assets/') && p !== '/__log') console.log(new Date().toLocaleTimeString(), ip, req.method, p);
  if (p === '/health') { res.writeHead(200); return res.end('ok'); }

  if (BETA_CODE) {
    const k = url.searchParams.get('k');
    if (k !== null) {
      if (k.trim().toUpperCase() === BETA_CODE.toUpperCase()) {
        url.searchParams.delete('k');
        res.writeHead(302, { 'Set-Cookie': `kr_beta=${BETA_TOKEN}; Path=/; Max-Age=31536000; SameSite=Lax${HOSTED ? '; Secure' : ''}; HttpOnly`,
          Location: url.pathname + (url.search || ''), 'Cache-Control': 'no-store' });
        return res.end();
      }
      return gatePage(res, true);
    }
    if (!hasInvite(req)) {
      if (PAGES.has(p)) return gatePage(res, false);
      res.writeHead(403); return res.end('invite needed');
    }
  }

  if (p === '/__log' && req.method === 'POST') {
    // ?debug=1 reporter from a TV page: print errors, console output and stats here (at home, or with DEBUG_LOG=1)
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 256 * 1024) req.destroy(); });
    req.on('end', () => {
      if (DEBUG_LOG) {
        try {
          for (const e of JSON.parse(body).slice(0, 50)) {
            const tag = e.type === 'stats' ? '\x1b[36m' : /error|reject/i.test(e.type) ? '\x1b[31m' : /warn/.test(e.type) ? '\x1b[33m' : '';
            console.log(`${tag}[${ip}] ${String(e.type).slice(0, 20)}: ${String(e.msg).slice(0, 2000)}\x1b[0m`);
          }
        } catch { console.log(`[${ip}] bad log payload`); }
      }
      res.writeHead(204); res.end();
    });
    return;
  }
  if (p === '/') return send(req, res, path.join(PUBLIC, 'menu.html'));   // start screen: choose Neon Racer or Sunny Kart
  if (p === '/neon' || p === '/neon/') return send(req, res, path.join(PUBLIC, 'tv.html'));
  if (p === '/sunny' || p === '/sunny/') return send(req, res, path.join(PUBLIC, 'sunny', 'index.html'));
  if (p === '/play') return send(req, res, path.join(PUBLIC, 'controller.html'));
  if (p === '/info') {
    // join link + QR for a TV room; the QR carries the room (and the invite code, so phones join without typing it)
    const room = cleanRoom(url.searchParams.get('room'));
    const base = joinBase(req);
    const qs = (room ? `?room=${room}` : '') + (BETA_CODE ? `${room ? '&' : '?'}k=${encodeURIComponent(BETA_CODE)}` : '');
    const joinUrl = `${base}/play${qs}`;
    const qr = await QRCode.toString(joinUrl, { type: 'svg', margin: 1, color: { dark: '#0b0b1a', light: '#ffffff' } });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({
      joinUrl, room, hosted: HOSTED, selfSigned: !!TLS,
      joinShort: `${base.replace(/^https?:\/\//, '')}/play`,
      joinUrlHttp: TLS ? `http://${IP}:${PORT}/play${room ? `?room=${room}` : ''}` : '',
      qr,
    }));
  }
  if (p.startsWith('/vendor/three/')) {
    const f = path.normalize(path.join(THREE, p.slice('/vendor/three/'.length)));
    if (!f.startsWith(THREE + path.sep)) { res.writeHead(403); return res.end(); }
    return send(req, res, f);
  }
  const f = path.normalize(path.join(PUBLIC, p));
  if (!f.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
  send(req, res, f);
}
const server = http.createServer(handler);
const secure = TLS ? https.createServer(TLS, handler) : null;

// ------------------------------------------------------------------ relay (per room)
function cleanRoom(v) { v = String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); return v.length >= 3 && v.length <= 8 ? v : ''; }
const rooms = new Map();        // code -> { tv, pads: Map(padId -> { ws, slot, name, garage, dropTimer }) }
let lastTvRoom = '';            // at home: phones with an old link (no room) join the TV that connected last
function room(code) {
  let r = rooms.get(code);
  if (!r) { r = { code, tv: null, pads: new Map() }; rooms.set(code, r); }
  return r;
}
function tidy(r) { if (!r.tv && r.pads.size === 0) rooms.delete(r.code); }
const sendWs = (ws, msg) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); };
const toTV = (r, msg) => sendWs(r.tv, msg);
const toPad = (r, id, msg) => { const p = r.pads.get(id); if (p) sendWs(p.ws, msg); };
function freeSlot(r) {
  const used = new Set([...r.pads.values()].map((p) => p.slot));
  for (let i = 0; i < MAX_PLAYERS; i++) if (!used.has(i)) return i;
  return -1;
}
const phoneCount = (r) => [...r.pads.values()].filter((x) => x.ws).length;
const tag = (r) => (HOSTED ? `[room ${r.code}] ` : '');

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
for (const srv of [server, secure]) srv?.on('upgrade', (req, sock, head) => {
  if (!hasInvite(req)) { sock.write('HTTP/1.1 403 Forbidden\r\n\r\n'); return sock.destroy(); }
  wss.handleUpgrade(req, sock, head, (ws) => wss.emit('connection', ws, req));
});

// keep connections alive through proxies, and drop dead ones
setInterval(() => { for (const ws of wss.clients) { if (ws.isAlive === false) { ws.terminate(); continue; } ws.isAlive = false; try { ws.ping(); } catch {} } }, 25000);

wss.on('connection', (ws, req) => {
  ws.isAlive = true; ws.on('pong', () => { ws.isAlive = true; });
  const q = new URL(req.url, 'http://x').searchParams;
  const role = q.get('role');
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim().replace('::ffff:', '');
  let code = cleanRoom(q.get('room'));

  if (role === 'tv') {
    if (!code) code = 'HOME';
    if (!rooms.has(code) && rooms.size >= MAX_ROOMS) return ws.close(4003, 'server full');
    const r = room(code);
    if (r.tv && r.tv.readyState === 1) { console.log(`[game] ${tag(r)}TV screen ${ip} replaces the previous TV screen`); r.tv.close(4000, 'replaced'); }
    else console.log(`[game] ${tag(r)}TV screen connected from ${ip}`);
    r.tv = ws; lastTvRoom = code;
    for (const [id, p] of r.pads) if (p.ws) { toTV(r, { t: 'join', id, slot: p.slot, name: p.name }); if (p.garage) toTV(r, p.garage); }
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.t === 'toPad') toPad(r, m.id, m.msg);
      else if (m.t === 'toAll') for (const id of r.pads.keys()) toPad(r, id, m.msg);
    });
    ws.on('close', () => {
      if (r.tv !== ws) return;
      r.tv = null; for (const id of r.pads.keys()) toPad(r, id, { t: 'tvGone' });
      setTimeout(() => tidy(r), 60000);
    });
    return;
  }

  // phone controller
  if (!code) code = HOSTED ? '' : (lastTvRoom || 'HOME');
  if (!code) { sendWs(ws, { t: 'noroom' }); return ws.close(4004, 'no room'); }
  if (HOSTED && !rooms.has(code)) { sendWs(ws, { t: 'noroom', room: code }); return ws.close(4004, 'no such room'); }
  const r = room(code);
  const id = (q.get('id') || Math.random().toString(36).slice(2)).slice(0, 40);
  const name = (q.get('name') || '').slice(0, 12);
  let p = r.pads.get(id);
  if (p) {
    if (p.ws && p.ws.readyState === 1) p.ws.close(4001, 'replaced');
    p.ws = ws; if (name) p.name = name;
    clearTimeout(p.dropTimer);
  } else {
    const slot = freeSlot(r);
    if (slot < 0) { sendWs(ws, { t: 'full' }); return ws.close(); }
    p = { ws, slot, name: name || `Player ${slot + 1}` };
    r.pads.set(id, p);
  }
  console.log(`[game] ${tag(r)}phone "${p.name}" (${ip}) joined, slot ${p.slot + 1}; ${phoneCount(r)} phone(s) connected`);
  sendWs(ws, { t: 'welcome', id, slot: p.slot, name: p.name, tv: !!r.tv, room: code });
  toTV(r, { t: 'join', id, slot: p.slot, name: p.name });

  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== 'object') return;
    m.id = id;
    if (m.t === 'garage') p.garage = m;   // remembered so a reloaded TV gets the car choice back
    if (m.t === 'start' || m.t === 'again') console.log(`[game] ${tag(r)}"${p.name}" started a race with ${phoneCount(r)} phone(s) connected`);
    toTV(r, m);
  });
  ws.on('close', () => {
    if (p.ws !== ws) return;
    p.ws = null;
    toTV(r, { t: 'away', id });
    // keep the seat for 30s so a phone that locks its screen can come back
    p.dropTimer = setTimeout(() => { r.pads.delete(id); toTV(r, { t: 'leave', id }); tidy(r); }, 30000);
  });
});

secure?.listen(HTTPS_PORT, '0.0.0.0');
server.listen(PORT, '0.0.0.0', () => {
  if (HOSTED) {
    console.log(`Kid Racer (hosted) listening on port ${PORT}; invite code ${BETA_CODE ? 'ON' : 'OFF (set BETA_CODE to close the beta)'}`);
    return;
  }
  console.log(`\n  Neon Racer is running!`);
  console.log(`  TV screen : http://localhost:${PORT}   (or http://${IP}:${PORT} from the TV browser)`);
  console.log(`  Phones    : ${joinBase({ headers: {} })}/play  (scan the QR code on the TV)`);
  if (TLS) console.log(`              http://${IP}:${PORT}/play  (buttons only, no tilt)`);
  if (BETA_CODE) console.log('  Invite code is ON (BETA_CODE)');
  console.log('');
});
