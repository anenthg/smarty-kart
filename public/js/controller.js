// Phone controller: join, garage (car + paint), gamepad, and game feedback (vibration, sounds, flashes).
import { CARS, CAR_IDS, PAINTS, PATTERNS, FINISHES, GLOWS, DEFAULT_CFG, sanitizeCfg } from '/js/garage-data.js';
import { LEVELS, LEVEL_IDS } from '/js/levels.js';
import { RACERS, RACER_IDS, BODIES, WHEELS, BODY_IDS, WHEEL_IDS, KPAINTS, sanitizeKart, kartColor, kartStats } from '/sunny/racers.js';

const $ = (id) => document.getElementById(id);
const SLOT_PAINTS = ['#ff2d95', '#00b8ff', '#ffcc00', '#7dff2b'];
const ITEM_ICONS = { rocket: '🚀', star: '⭐', magnet: '🧲', banana: '🍌', orb: '🟢', homing: '🔴', boost: '⚡', coins: '🪙', horn: '📯',
  green: '🟢', red: '🔴', mushroom: '🍄', bullet: '🚀', coin: '🪙' };   // second row: Sunny Kart items
const ITEM_NAMES = { rocket: 'ROCKET!', star: 'STAR POWER!', magnet: 'COIN MAGNET!', banana: 'BANANA!', orb: 'BOUNCY ORB!', homing: 'HOMING ORB!', boost: 'BOOST!', coins: '+3 COINS!', horn: 'HORN BLAST!',
  green: 'GREEN SHELL!', red: 'RED SHELL!', mushroom: 'MUSHROOM!', bullet: 'BULLET!', coin: '+2 COINS!' };
const TIER_NAMES = ['', 'MINI-TURBO', 'SUPER TURBO', 'ULTRA TURBO'], TIER_COLORS = ['', '#4a8cff', '#ff8a1a', '#d24dff'];

let ws, myId = localStorage.getItem('nr_id') || Math.random().toString(36).slice(2, 12);
localStorage.setItem('nr_id', myId);
$('name').value = localStorage.getItem('nr_name') || '';
$('auto').checked = localStorage.getItem('nr_auto') === '1';
$('sfxOn').checked = localStorage.getItem('nr_sfx') !== '0';

let savedCfg = null;
try { savedCfg = JSON.parse(localStorage.getItem('nr_cfg') || 'null'); } catch {}
let cfg = sanitizeCfg(savedCfg || DEFAULT_CFG);
// which game the TV is running ('neon' | 'sunny' | 'menu'); the TV says so in every state message
let game = 'neon';
// Sunny Kart kart: racer + body + wheels + colour (racer null until chosen or given by the TV)
let kart = (() => { try { return JSON.parse(localStorage.getItem('nr_kart') || 'null'); } catch { return null; } })();
kart = kart ? sanitizeKart(kart) : null;
if (!kart && RACERS[localStorage.getItem('nr_racer')]) kart = sanitizeKart({ racer: localStorage.getItem('nr_racer') });
let stab = 'racer', kpreview = null;
const saveKart = () => localStorage.setItem('nr_kart', JSON.stringify(kart));
let others = [];   // racers other players have (Sunny Kart lobby)

const input = { s: 0, g: 0, b: 0, n: 0, i: 0 };
const held = { left: new Set(), right: new Set(), gas: new Set(), brake: new Set(), nitro: new Set(), item: new Set() };
let phase = 'lobby', lastSent = '', lastSentAt = 0, trailT = 0;
const tilt = { on: false, ok: false, raw: 0, zero: 0, s: 0 };
const stick = { id: null, s: 0 };   // on-screen thumbstick, -1..1
window.__pad = { tilt, stick, cfg: () => cfg, get lastSent() { return lastSent; } };   // for testing

// ---------------------------------------------------------------- input
function sendRaw(m) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); }
function sendInput(force) {
  input.s = tilt.on ? Math.round(tilt.s * 50) / 50 : Math.round(stick.s * 50) / 50;
  input.g = held.gas.size || ($('auto').checked && !held.brake.size) ? 1 : 0;
  input.b = held.brake.size ? 1 : 0;
  input.n = held.nitro.size ? 1 : 0;
  input.i = held.item.size ? 1 : 0;
  const k = JSON.stringify(input);
  const now = performance.now();
  if (force || (k !== lastSent && now - lastSentAt > 30)) { lastSent = k; lastSentAt = now; sendRaw({ t: 'in', ...input }); }
  else if (k !== lastSent) { clearTimeout(trailT); trailT = setTimeout(() => sendInput(true), 32); }   // never drop the latest position
}
setInterval(() => sendInput(true), 120);

for (const [id, key] of [['gas', 'gas'], ['brake', 'brake'], ['drift', 'nitro'], ['sitem', 'item']]) {   // drift = 'n', item = 'i' in the input message
  const el = $(id);
  const down = (e) => { e.preventDefault(); try { el.setPointerCapture?.(e.pointerId); } catch {} held[key].add(e.pointerId); el.classList.add('down'); sendInput(true); vib(8); };
  const up = (e) => { held[key].delete(e.pointerId); if (!held[key].size) el.classList.remove('down'); sendInput(true); };
  el.addEventListener('pointerdown', down);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('lostpointercapture', up);
}
document.addEventListener('contextmenu', (e) => e.preventDefault());

// ---------------------------------------------------------------- thumbstick (left/right only, fixed in the middle of the left half)
// Steering = how far the thumb is from the middle of the pad: small push = gentle turn, full push = full lock.
const area = $('stickArea'), knob = $('stick');
function stickMove(clientX) {
  const r = area.getBoundingClientRect(), max = Math.min(100, r.width * 0.3);
  const dx = Math.max(-max, Math.min(max, clientX - (r.left + r.width / 2)));
  knob.style.transform = `translateX(${dx}px)`;
  let s = dx / max;
  s = Math.abs(s) < 0.08 ? 0 : Math.sign(s) * (Math.abs(s) - 0.08) / 0.92;   // small dead zone in the middle
  if (Math.abs(s) > 0.98 && Math.abs(stick.s) <= 0.98) vib(6);                // tick at full lock
  stick.s = s;
  $('al').classList.toggle('on', s < -0.15); $('ar').classList.toggle('on', s > 0.15);
  sendInput();
}
function stickRelease() {
  stick.id = null; stick.s = 0; knob.classList.remove('drag'); knob.style.transform = 'translateX(0)';
  $('al').classList.remove('on'); $('ar').classList.remove('on');
}
area.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if (tilt.on) { tilt.zero = tilt.raw; tilt.s = 0; vib(20); sendInput(); return; }   // tilt mode: tap = re-center
  if (stick.id !== null) return;
  stick.id = e.pointerId; try { area.setPointerCapture(e.pointerId); } catch {}
  knob.classList.add('drag'); stickMove(e.clientX); vib(8);
});
area.addEventListener('pointermove', (e) => { if (e.pointerId === stick.id) stickMove(e.clientX); });
for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) area.addEventListener(ev, (e) => { if (e.pointerId === stick.id) { stickRelease(); sendInput(true); } });
$('auto').addEventListener('change', () => { localStorage.setItem('nr_auto', $('auto').checked ? '1' : '0'); sendInput(true); });
$('sfxOn').addEventListener('change', () => { localStorage.setItem('nr_sfx', $('sfxOn').checked ? '1' : '0'); if ($('sfxOn').checked) { sfx.init(); sfx.coin(); } });

// ---------------------------------------------------------------- tilt steering
// Device "up" vector from DeviceOrientation (same on iOS and Android): u = (-cosβ·sinγ, sinβ, cosβ·cosγ)
function screenAngle() {
  const a = (screen.orientation && typeof screen.orientation.angle === 'number') ? screen.orientation.angle : (window.orientation || 0);
  return ((a % 360) + 360) % 360;
}
function onOrient(e) {
  if (e.beta == null) return;
  tilt.ok = true;
  const b = e.beta * Math.PI / 180, g = (e.gamma || 0) * Math.PI / 180, a = screenAngle();
  let v;
  if (a === 90) v = Math.sin(b);
  else if (a === 270) v = -Math.sin(b);
  else if (a === 180) v = -Math.cos(b) * Math.sin(g);
  else v = Math.cos(b) * Math.sin(g);
  tilt.raw = Math.asin(Math.max(-1, Math.min(1, v))) * 180 / Math.PI;
  const d = tilt.raw - tilt.zero, DEAD = 3, FULL = 28;
  const target = Math.abs(d) < DEAD ? 0 : Math.sign(d) * Math.min(1, (Math.abs(d) - DEAD) / (FULL - DEAD));
  tilt.s += (target - tilt.s) * 0.5;
  $('wheel').style.transform = `rotate(${tilt.s * 90}deg)`;
  sendInput();
}
window.__pad.onOrient = onOrient;
async function enableTilt() {
  const msg = (t) => { $('tiltMsg').textContent = t; };
  if (!window.isSecureContext) { msg('Tilt needs the secure link: scan the QR code on the TV (https://…:8443). Using the stick.'); setTilt(false); return; }
  try {
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      const r = await DeviceOrientationEvent.requestPermission();
      if (r !== 'granted') { msg('Motion access was not allowed. Tap Tilt again and choose Allow.'); setTilt(false); return; }
    }
  } catch (e) { msg('Could not turn on motion: ' + e.message); setTilt(false); return; }
  window.addEventListener('deviceorientation', onOrient);
  tilt.ok = false; tilt.zero = 0;
  setTilt(true); msg('');
  setTimeout(() => { if (tilt.on && !tilt.ok) { msg('No motion sensor found on this phone, using the stick.'); setTilt(false); } }, 1500);
}
// persist only when the player flips the switch; a failed auto-start (no sensor, http link) must not turn the default off
function setTilt(on, persist = false) {
  tilt.on = on; $('tiltOn').checked = on;
  document.body.classList.toggle('tilt', on);
  if (persist) localStorage.setItem('nr_tilt3', on ? '1' : '0');
  if (!on) { window.removeEventListener('deviceorientation', onOrient); tilt.s = 0; }
  sendInput(true);
}
$('tiltOn').addEventListener('change', () => { if ($('tiltOn').checked) { localStorage.setItem('nr_tilt3', '1'); enableTilt(); } else setTilt(false, true); });

// ---------------------------------------------------------------- feedback: vibration + phone sounds + visuals
const vib = (p) => { try { navigator.vibrate?.(p); } catch {} };
function autoPress(key, delay) {
  setTimeout(() => { held[key].add('auto'); sendInput(true); setTimeout(() => { held[key].delete('auto'); sendInput(true); }, 200); }, delay);
}
function releaseAll() { for (const k of Object.keys(held)) held[k].clear(); for (const id of ['gas', 'brake', 'drift', 'sitem']) $(id).classList.remove('down'); stickRelease(); sendInput(true); }
const sfx = {
  ctx: null,
  init() { if (!this.ctx) { try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return; } } this.ctx.resume?.(); },
  get ok() { return $('sfxOn').checked && this.ctx && this.ctx.state === 'running'; },
  tone(f, d, type = 'sine', v = 0.15, when = 0, f2 = 0) {
    if (!this.ok) return;
    const c = this.ctx, o = c.createOscillator(), g = c.createGain(), t = c.currentTime + when;
    o.type = type; o.frequency.setValueAtTime(f, t); if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + d);
    g.gain.setValueAtTime(v, t); g.gain.exponentialRampToValueAtTime(0.001, t + d);
    o.connect(g); g.connect(c.destination); o.start(t); o.stop(t + d + 0.02);
  },
  noise(d, v = 0.2, f1 = 400, f2 = 3000) {
    if (!this.ok) return;
    const c = this.ctx, b = c.createBuffer(1, c.sampleRate * d, c.sampleRate), x = b.getChannelData(0);
    for (let i = 0; i < x.length; i++) x[i] = (Math.random() * 2 - 1) * Math.sin(Math.PI * i / x.length);
    const s = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain(), t = c.currentTime;
    s.buffer = b; f.type = 'bandpass'; f.Q.value = 1.5; f.frequency.setValueAtTime(f1, t); f.frequency.exponentialRampToValueAtTime(f2, t + d);
    g.gain.value = v; s.connect(f); f.connect(g); g.connect(c.destination); s.start();
  },
  coin() { this.tone(1318, 0.07, 'square', 0.06); this.tone(1760, 0.16, 'square', 0.06, 0.07); },
  pad() { this.noise(0.45, 0.35); this.tone(400, 0.4, 'sawtooth', 0.05, 0, 1200); },
  tick() { this.tone(1100, 0.03, 'square', 0.04); },
  item() { [523, 659, 784, 1046].forEach((f, i) => this.tone(f, 0.12, 'triangle', 0.12, i * 0.06)); },
  use(it) { if (it === 'star') [784, 988, 1175, 1568].forEach((f, i) => this.tone(f, 0.1, 'square', 0.06, i * 0.05)); else if (it === 'rocket') { this.noise(0.8, 0.4, 200, 2000); this.tone(150, 0.8, 'sawtooth', 0.08, 0, 600); } else this.tone(300, 0.4, 'sine', 0.15, 0, 900); },
  ready() { this.tone(880, 0.08, 'triangle', 0.1); this.tone(1320, 0.12, 'triangle', 0.1, 0.09); },
  bump(p) { this.tone(110, 0.18, 'sine', Math.min(0.4, 0.08 + p * 0.02), 0, 50); this.noise(0.15, Math.min(0.3, p * 0.02), 300, 200); },
  count() { this.tone(440, 0.18, 'square', 0.08); },
  go() { this.tone(880, 0.45, 'square', 0.1); },
  lap() { this.tone(784, 0.12, 'triangle', 0.12); this.tone(1046, 0.25, 'triangle', 0.12, 0.12); },
  final() { [784, 988, 1175].forEach((f, i) => this.tone(f, 0.18, 'triangle', 0.13, i * 0.14)); },
  finish() { [523, 659, 784, 1046, 784, 1046].forEach((f, i) => this.tone(f, i === 5 ? 0.5 : 0.14, 'square', 0.07, i * 0.13)); },
  wrong() { this.tone(220, 0.25, 'square', 0.08); this.tone(180, 0.35, 'square', 0.08, 0.25); },
};

let toastT = 0;
function toast(text, color = '#fff', ms = 1100) {
  const el = $('toast'); el.textContent = text; el.style.color = color; el.style.borderColor = color + '88';
  el.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('on'), ms);
}
function flash(color) { const el = $('flash'); el.style.background = color; el.classList.remove('go'); void el.offsetWidth; el.classList.add('go'); }
function shake() { const el = $('pad'); el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake'); }

let rollTimer = 0, autoItemT = 0;
const SUNNY_ROLL = ['🍌', '🟢', '🔴', '🍄', '⭐', '🪙'];
function setItem(it, n = 1) {
  const el = $('item'), ico = $('itemIco'), sel = $('sitem'), sico = $('sitemIco');
  const icon = (t) => { ico.textContent = t; sico.textContent = t; };
  clearInterval(rollTimer);
  el.classList.remove('has', 'rolling'); sel.classList.remove('has', 'rolling');
  if (it === 'roll') {
    el.classList.add('rolling'); sel.classList.add('rolling'); let k = 0;
    const list = game === 'sunny' ? SUNNY_ROLL : Object.values(ITEM_ICONS);
    rollTimer = setInterval(() => { icon(list[k++ % (game === 'sunny' ? list.length : 3)]); sfx.tick(); }, 90);
  } else if (it) { icon(ITEM_ICONS[it] + (n > 1 ? '×' + n : '')); el.classList.add('has'); sel.classList.add('has'); }
  else icon('·');
  el.dataset.it = it || '';
}

function onFx(k, v) {
  switch (k) {
    case 'coin': sfx.coin(); vib(12); $('hCoins').textContent = `🪙 ${v}`; $('hCoins').classList.remove('pop'); void $('hCoins').offsetWidth; $('hCoins').classList.add('pop'); break;
    case 'pad': sfx.pad(); vib([25, 25, 25, 25, 40]); flash('#00e5ff'); toast('⚡ SPEED PAD!', '#7df3ff', 800); break;
    case 'roll': setItem('roll'); vib(15); break;
    case 'item': setItem(v); sfx.item(); vib([40, 40, 80]); toast(`${ITEM_ICONS[v]} ${ITEM_NAMES[v]}`, '#e0b0ff'); break;   // fired by itself (see onHud)
    case 'use': setItem(null); sfx.use(v); vib(v === 'rocket' ? [60, 30, 200] : [30, 30, 30, 30, 120]); flash(v === 'star' ? '#ffd60a' : v === 'rocket' ? '#ff7a1a' : '#40a0ff'); toast(`${ITEM_ICONS[v]} ${ITEM_NAMES[v]}`, '#fff'); break;
    case 'boostReady': sfx.ready(); vib([30, 60, 30]); toast('⚡ BOOST READY!', '#7df3ff', 900); break;
    case 'wall': vib(Math.min(45, 18 + (v || 1) * 2)); sfx.bump(Math.min(3, v || 1)); break;   // light buzz when scraping or hitting the side
    case 'paused': vib(40); break;
    case 'spark': vib(10 + v * 6); sfx.tone(500 + v * 250, 0.06, 'square', 0.05); setDriftTier(v); break;   // drift sparks changed colour
    case 'turbo': vib([20, 20, 30 + v * 25]); sfx.pad(); flash(TIER_COLORS[v]); toast(`🔥 ${TIER_NAMES[v]}!`, TIER_COLORS[v], 700); setDriftTier(0); break;
    case 'rocketStart': vib([60, 30, 160]); sfx.use('rocket'); flash('#ff7a1a'); toast('🚀 ROCKET START!', '#ffb36b', 1200); break;
    case 'draft': vib([15, 15, 15, 15, 40]); sfx.pad(); toast('💨 SLIPSTREAM!', '#d6f3ff', 800); break;
    case 'spin': vib([120, 60, 120, 60, 200]); sfx.bump(12); shake(); flash('#ffffff'); toast(v ? `💫 SPUN OUT! −${v} 🪙` : '💫 SPUN OUT!', '#fff', 1200); break;
    case 'hitOther': vib([30, 30, 60]); sfx.item(); toast(`🎯 You hit ${v}!`, '#9dffc6', 1100); break;
    case 'bump': sfx.bump(v || 5); vib(Math.min(160, 30 + (v || 5) * 7)); shake(); break;
    case 'count': sfx.count(); vib(50); toast(v === 2 && !$('auto').checked ? '2 · press GO on 1 for a 🚀 start!' : String(v), '#fff', v === 2 ? 950 : 600); break;
    case 'go': sfx.go(); vib(180); flash('#19c46a'); toast('GO!', '#9dffc6', 700); break;
    case 'lap': sfx.lap(); vib([60, 40, 60]); toast(`LAP ${v}!`, '#fff'); break;
    case 'final': sfx.final(); vib([100, 50, 100, 50, 100]); flash('#ff2d95'); toast('🏁 FINAL LAP!', '#ff8ac8', 1500); break;
    case 'finish': sfx.finish(); vib([200, 100, 200, 100, 500]); flash('#ffd60a'); toast(v === 1 ? '🏆 YOU WON!' : `🏁 FINISHED ${ord(v)}!`, '#ffe066', 2500); break;
    case 'wrong': sfx.wrong(); vib(250); toast('⟲ WRONG WAY', '#ffdd33', 1300); break;
    case 'catchup': sfx.pad(); vib([40, 40, 40]); flash('#b06bff'); toast('🌀 CATCH UP!', '#d6b0ff', 1200); break;
  }
}
// the DRIFT button glows in the current spark colour while you hold it
// ---------------------------------------------------------------- quiz
let qzLast = '';
function renderQuiz(m) {
  const qp = $('quizpad'), key = [m.qstate, m.qi, m.pick, m.correct].join('|');
  qp.className = m.qstate === 'intro' ? 'intro' : m.qstate === 'done' ? 'done' : m.qstate === 'locked' && m.waiting && m.waiting.length ? '' : '';
  if (m.qstate === 'intro') { $('qzq').innerHTML = ''; $('qzmsg').innerHTML = '<div class="big1">🧠 Quiz time!</div>Answer all 5 questions to unlock the next race'; }
  else if (m.qstate === 'done') {
    $('qzq').innerHTML = '';
    $('qzmsg').innerHTML = `<div class="big1">Quiz complete! ${m.stars} out of ${m.of}</div><div class="stars">${'⭐'.repeat(m.stars)}${'☆'.repeat(m.of - m.stars)}</div>
      ${m.stars ? `You'll start the next race with <b>${m.stars} bonus coin${m.stars > 1 ? 's' : ''} 🪙</b>` : 'Great effort! Next time ⭐'}<div class="lockbtn">PLAY AGAIN 🔒 unlocking…</div>`;
  } else {
    $('qzq').innerHTML = `<small>${escapeAttr(m.cat || '')} · QUESTION ${m.qi + 1} OF ${m.of}</small>${escapeAttr(m.q)}`;
    document.querySelectorAll('.qzb').forEach((b, i) => {
      b.querySelector('.t').textContent = m.opts[i];
      b.classList.toggle('pick', m.pick === i && m.correct < 0);
      b.classList.toggle('fade', (m.pick >= 0 && m.pick !== i && m.correct < 0) || (m.correct >= 0 && i !== m.correct && i !== m.pick));
      b.classList.toggle('right', m.correct === i);
      b.classList.toggle('wrongpick', m.correct >= 0 && m.pick === i && i !== m.correct);
      b.disabled = m.qstate !== 'ask';
    });
    if (m.qstate === 'locked') $('status').textContent = m.waiting && m.waiting.length ? `✓ Locked in · waiting for ${m.waiting.join(', ')}` : '✓ Locked in';
  }
  if (key !== qzLast) {   // feedback once per change
    if (m.qstate === 'ask' && !qzLast.startsWith('ask|' + m.qi)) { vib(30); sfx.tick(); }
    if (m.qstate === 'reveal' && m.correct >= 0 && !qzLast.endsWith('|' + m.correct)) {
      if (m.ok) { vib([40, 40, 120]); sfx.item(); flash('#2bd35a'); toast('⭐ CORRECT!', '#9dffc6', 1200); }
      else { vib([80, 60, 80]); sfx.wrong(); toast('Good try!', '#fff', 1200); }
    }
    if (m.qstate === 'done' && !qzLast.startsWith('done')) { vib([100, 50, 100, 50, 200]); sfx.finish(); }
    qzLast = key;
  }
}
document.querySelectorAll('.qzb').forEach((b) => b.addEventListener('click', () => {
  if (b.disabled) return;
  sendRaw({ t: 'answer', k: +b.dataset.k }); vib(25); sfx.tick();
  document.querySelectorAll('.qzb').forEach((x) => { x.classList.toggle('pick', x === b); x.classList.toggle('fade', x !== b); x.disabled = true; });
}));

function setDriftTier(t) { const el = $('drift'); el.classList.remove('t1', 't2', 't3'); if (t && held.nitro.size) el.classList.add('t' + t); }
const ord = (n) => n + (['th', 'st', 'nd', 'rd'][(n % 100 > 10 && n % 100 < 14) ? 0 : (n % 10 < 4 ? n % 10 : 0)] || 'th');

function onHud(m) {
  $('hPos').innerHTML = `${m.pos}<small>${ord(m.pos).slice(-2)}/${m.of}</small>`;
  $('hLap').textContent = m.fin ? 'DONE' : `LAP ${m.lap}/${m.laps}`;
  $('hCoins').textContent = `🪙 ${m.coins}`;
  $('nfill').style.height = Math.round(m.nitro * 100) + '%';
  $('hItem').textContent = m.item === 'roll' ? '🎲' : (m.item ? ITEM_ICONS[m.item] + (m.n > 1 ? '×' + m.n : '') : '');
  if (game !== 'sunny') {   // Sunny Kart has its own ITEM and DRIFT buttons
    // items fire by themselves ~0.8 s after they arrive (one at a time for ×3 items)
    if (m.item && m.item !== 'roll' && !m.fin && !autoItemT) autoItemT = setTimeout(() => { autoItemT = 0; autoPress('item', 0); }, 800);
    // boost fires by itself when the bar is full, and runs until it's empty
    if (m.nitro >= 1 && !m.fin && !held.nitro.size) { held.nitro.add('auto'); sendInput(true); }
    else if (held.nitro.size && (m.nitro <= 0.05 || m.fin)) { held.nitro.clear(); sendInput(true); }
  } else if (!held.nitro.size) setDriftTier(0);
  document.body.classList.toggle('boosting', held.nitro.size > 0);
  $('nitro').classList.toggle('ready', m.nitro >= 1);
  const cur = $('item').classList.contains('rolling') ? 'roll' : ($('item').dataset.it || null);
  const curN = $('item').dataset.n || '1';
  if ((m.item || null) !== cur || (m.item && m.item !== 'roll' && String(m.n || 1) !== curN)) { setItem(m.item, m.n || 1); $('item').dataset.n = String(m.n || 1); }
  document.body.classList.toggle('fx-star', !!m.star);
  document.body.classList.toggle('fx-rocket', !!m.rocket);
  document.body.classList.toggle('fx-magnet', !!m.magnet);
}

// ---------------------------------------------------------------- garage
let tab = 'paint';
let preview = null;
import('/js/garage.js').then((mod) => { preview = new mod.GaragePreview($('gcanvas')); preview.set(cfg); if ($('garage').classList.contains('on')) preview.start(); })
  .catch((e) => console.warn('3D preview unavailable', e));

function saveCfg(send = true) {
  cfg = sanitizeCfg(cfg);
  localStorage.setItem('nr_cfg', JSON.stringify(cfg));
  setThemeColor();
  preview?.set(cfg);
  renderGarage();
  if (send) sendGarage();
}
// one garage message for both games: Neon Racer reads its car fields, Sunny Kart reads racer/body/wheels/kpaint
function sendGarage() { sendRaw({ t: 'garage', cfg: { ...cfg, ...(kart || {}) } }); }
function setKart(change) {
  kart = sanitizeKart({ ...(kart || { racer: 'ruby' }), ...change });
  saveKart(); setThemeColor(); renderGarage(); sendGarage();
}
function setThemeColor() {
  const c = game === 'sunny' && kart ? kartColor(kart) : (cfg.paint === '#16161a' ? '#8a8aa0' : cfg.paint);
  document.documentElement.style.setProperty('--c', c);
}
$('sracers').addEventListener('click', (e) => {
  const b = e.target.closest('[data-r],[data-b],[data-w],[data-p]'); if (!b) return;
  if (b.classList.contains('taken')) { vib([20, 40, 20]); toast(`${b.dataset.who} has ${RACERS[b.dataset.r].name}`, '#fff', 900); return; }
  vib(15); sfx.tick();
  if (b.dataset.r) setKart({ racer: b.dataset.r });
  else if (b.dataset.b) setKart({ body: b.dataset.b });
  else if (b.dataset.w) setKart({ wheels: b.dataset.w });
  else setKart({ kpaint: b.dataset.p });
});
$('stabs').addEventListener('click', (e) => { const b = e.target.closest('[data-st]'); if (!b) return; stab = b.dataset.st; vib(8); renderGarage(); });
$('gamesBtn').addEventListener('click', () => { sendRaw({ t: 'pick', game: 'menu' }); vib(20); });
for (const b of document.querySelectorAll('#menu .g')) b.addEventListener('click', () => { sfx.init(); sendRaw({ t: 'pick', game: b.dataset.game }); vib(30); goFullscreen(); });
function setGame(g) {
  if (g === game) return;
  game = g;
  document.body.classList.toggle('sunny', g === 'sunny');
  document.body.classList.toggle('menu', g === 'menu');
  document.title = g === 'sunny' ? 'Sunny Kart – Controller' : 'Neon Racer – Controller';
  setItem(null); setThemeColor();
  if ($('garage').classList.contains('on')) showGarage(true);
}
function renderGarage() {
  if (game === 'sunny') {
    const k = kart || sanitizeKart({}), r = RACERS[k.racer];
    $('carName').textContent = `${r.name} · ${BODIES[k.body].name}`.toUpperCase();
    $('carTag').textContent = `${WHEELS[k.wheels].name} wheels`.toUpperCase();
    $('simg').src = `/sunny/assets/racer_${k.racer}.jpg`;
    if (!kpreview && !window.__noPreview) {
      kpreview = 'loading';
      import('/sunny/preview.js').then((mod) => {
        kpreview = new mod.KartPreview($('scanvas'));
        kpreview.ready.then(() => document.querySelector('.preview').classList.add('pvready'));
        kpreview.set(kart || sanitizeKart({})); if ($('garage').classList.contains('on') && game === 'sunny') kpreview.start();
      }).catch((e) => { console.warn('kart preview unavailable', e); kpreview = null; window.__noPreview = true; });
    } else if (kpreview && kpreview !== 'loading') kpreview.set(k);
    // stats: green = better than the racer alone, faded red = worse
    const st = kartStats(k);
    $('stats').innerHTML = [['SPEED', 'speed'], ['ZOOM', 'accel'], ['TURNING', 'handling'], ['OFF-ROAD', 'offroad']].map(([n, key]) => {
      const v = st[key], b = st.base[key];
      return `<span>${n}</span><span class="bars">${[1, 2, 3, 4, 5].map((i) => `<i class="${i <= Math.min(v, b) ? 'on' : i <= v ? 'up' : i <= b ? 'down' : ''}"></i>`).join('')}</span>`;
    }).join('');
    for (const b of $('stabs').children) b.classList.toggle('on', b.dataset.st === stab);
    const el = $('sracers'); el.classList.toggle('paints', stab === 'paint');
    if (stab === 'racer') el.innerHTML = RACER_IDS.map((id) => {
      const o = others.find((x) => x.racer === id);
      return `<button class="rc ${id === k.racer ? 'on' : ''} ${o ? 'taken' : ''}" data-r="${id}" data-who="${o ? escapeAttr(o.name) : ''}"><i style="background:${RACERS[id].color}"></i>${RACERS[id].name}<small>${RACERS[id].tag}</small></button>`;
    }).join('');
    else if (stab === 'body') el.innerHTML = BODY_IDS.map((id) => `<button class="rc ${id === k.body ? 'on' : ''}" data-b="${id}"><span class="ic">${BODIES[id].icon}</span>${BODIES[id].name}<small>${BODIES[id].tag}</small></button>`).join('');
    else if (stab === 'wheels') el.innerHTML = WHEEL_IDS.map((id) => `<button class="rc ${id === k.wheels ? 'on' : ''}" data-w="${id}"><span class="ic">${WHEELS[id].icon}</span>${WHEELS[id].name}<small>${WHEELS[id].tag}</small></button>`).join('');
    else el.innerHTML = KPAINTS.map((c) => `<button class="psw ${c === k.kpaint ? 'on' : ''} ${c ? '' : 'own'}" data-p="${c || ' '}" style="background:${c || RACERS[k.racer].color}"></button>`).join('') + '<div class="shint">★ = your racer\'s own colour</div>';
    return;
  }
  const car = CARS[cfg.car];
  $('carName').textContent = car.name; $('carTag').textContent = car.tag;
  $('stats').innerHTML = [['SPEED', car.stats.speed], ['ZOOM', car.stats.accel], ['GRIP', car.stats.grip]]
    .map(([n, v]) => `<span>${n}</span><span class="bars">${[1, 2, 3, 4, 5].map((k) => `<i class="${k <= v ? 'on' : ''}"></i>`).join('')}</span>`).join('');
  for (const b of $('tabs').children) b.classList.toggle('on', b.dataset.tab === tab);
  const sw = (key, c, small) => `<button class="sw ${cfg[key] === c ? 'on' : ''} ${c === 'off' ? 'off' : ''}" data-k="${key}" data-v="${c}" style="background:${c}">${c === 'off' ? 'OFF' : ''}</button>`;
  let h = '';
  if (tab === 'paint') h = `<div class="grid colors">${PAINTS.map((c) => sw('paint', c)).join('')}</div>`;
  if (tab === 'pattern') {
    h = `<div class="grid opts six">${PATTERNS.map((p) => `<button class="opt ${cfg.pattern === p.id ? 'on' : ''}" data-k="pattern" data-v="${p.id}"><span>${p.icon}</span>${p.name}</button>`).join('')}</div>`;
    if (cfg.pattern !== 'none') h += `<div class="label">STYLE COLOUR</div><div class="grid small">${PAINTS.map((c) => sw('accent', c)).join('')}</div>`;
  }
  if (tab === 'finish') h = `<div class="grid opts">${FINISHES.map((f) => `<button class="opt ${cfg.finish === f.id ? 'on' : ''}" data-k="finish" data-v="${f.id}"><span>${{ gloss: '💎', metal: '🔩', matte: '🧱', chrome: '🪞', pearl: '🫧' }[f.id]}</span>${f.name}</button>`).join('')}</div>`;
  if (tab === 'glow') h = `<div class="label" style="margin-top:0">LIGHTS UNDER YOUR CAR</div><div class="grid colors">${GLOWS.map((c) => sw('glow', c)).join('')}</div>`;
  $('gbody').innerHTML = h;
}
$('gbody').addEventListener('click', (e) => {
  const b = e.target.closest('[data-k]'); if (!b) return;
  cfg[b.dataset.k] = b.dataset.v; vib(10); sfx.tick(); saveCfg();
});
$('tabs').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (!b) return; tab = b.dataset.tab; vib(8); renderGarage(); });
const stepCar = (d) => { const i = CAR_IDS.indexOf(cfg.car); cfg.car = CAR_IDS[(i + d + CAR_IDS.length) % CAR_IDS.length]; vib(15); sfx.tick(); saveCfg(); };
$('carPrev').addEventListener('click', () => stepCar(-1));
$('carNext').addEventListener('click', () => stepCar(1));
$('startBtn').addEventListener('click', () => { sfx.init(); sendRaw({ t: 'start' }); vib(30); });

function showGarage(on) {
  $('garage').classList.toggle('on', on);
  const kp = kpreview && kpreview !== 'loading' ? kpreview : null;
  if (on) { renderGarage(); if (game !== 'sunny') { preview?.start(); kp?.stop(); } else { preview?.stop(); kp?.start(); } } else { preview?.stop(); kp?.stop(); }
}
const escapeAttr = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------------------------------------------------------------- overlay + state
// ---------------------------------------------------------------- difficulty level (one per race; the TV decides and tells every phone)
let curLevel = null;
function renderLevels(lv) {
  if (lv === curLevel) return; curLevel = lv;
  const h = '<span class="lab">LEVEL</span>' + LEVEL_IDS.map((id) => `<button class="lvb lvb-${id}${id === lv ? ' on' : ''}" data-lv="${id}">${LEVELS[id].icon} ${LEVELS[id].name}<small>${LEVELS[id].cc}</small></button>`).join('');
  for (const id of ['lvlrow', 'lvlrow2']) $(id).innerHTML = h;
}
for (const id of ['lvlrow', 'lvlrow2']) $(id).addEventListener('click', (e) => {
  const b = e.target.closest('.lvb'); if (!b || b.dataset.lv === curLevel) return;
  sendRaw({ t: 'level', v: b.dataset.lv }); vib(20); sfx.tick();
  renderLevels(b.dataset.lv);   // show it at once; the TV's next state confirms
});

function overlay(on, title = '', sub = '', btn = '', btn2 = false) {
  $('lvlrow2').style.display = on && phase === 'results' && btn ? '' : 'none';   // level can change before PLAY AGAIN
  $('overlay').classList.toggle('on', on);
  $('otitle').textContent = title; $('osub').textContent = sub;
  $('obtn').style.display = btn ? '' : 'none'; $('obtn').textContent = btn;
  $('obtn2').style.display = btn2 ? '' : 'none';
}
$('obtn').addEventListener('click', () => { sfx.init(); sendRaw({ t: phase === 'paused' ? 'resume' : phase === 'results' ? 'again' : 'start' }); vib(30); });
$('obtn2').addEventListener('click', () => { sendRaw({ t: phase === 'paused' ? 'quit' : 'lobby' }); vib(30); });
$('pauseBtn').addEventListener('click', () => { sendRaw({ t: 'pause' }); vib(30); });

function connect() {
  const name = encodeURIComponent($('name').value.trim());
  const room = window.KR ? (KR.setPadRoom($('room').value) || KR.padRoom()) : '';
  ws = new WebSocket(window.KR ? KR.padSocket(myId, decodeURIComponent(name), room) : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/?role=pad&id=${myId}&name=${name}`);
  ws.onopen = () => { $('status').textContent = 'Connected'; };
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.t === 'welcome') {
      $('pname').textContent = m.name;
      if (!savedCfg) { cfg.paint = SLOT_PAINTS[m.slot] || cfg.paint; cfg.glow = cfg.paint; savedCfg = cfg; }
      saveCfg(true);
      if (!m.tv) overlay(true, 'Open the TV screen', 'The game screen is not open yet.');
    }
    else if (m.t === 'full') showJoin('Sorry, 4 racers are already playing.');
    else if (m.t === 'noroom') { noRoom = true; $('roomrow').hidden = false; $('room').value = ''; try { localStorage.removeItem('kr_proom'); } catch {} showJoin(m.room ? `No TV with room ${m.room}. Check the code on the TV.` : 'Type the room code shown on the TV.'); }
    else if (m.t === 'tvGone') { showGarage(false); overlay(true, 'TV disconnected', 'Waiting for the TV screen…'); }
    else if (m.t === 'state') {
      const was = phase; phase = m.phase;
      if (m.level) renderLevels(m.level);
      setGame(m.game || 'neon');
      if (m.game === 'sunny') {
        others = m.others || [];
        if (m.kart) {   // the TV is the referee (e.g. two players can't share a racer)
          const k = sanitizeKart(m.kart);
          if (!kart || JSON.stringify(k) !== JSON.stringify(kart)) { kart = k; saveKart(); setThemeColor(); }
          if ($('garage').classList.contains('on')) renderGarage();
        }
      }
      document.body.classList.toggle('quiz', m.phase === 'quiz');
      if (m.phase === 'quiz') { showGarage(false); overlay(false); document.body.classList.remove('racing'); releaseAll(); $('status').textContent = m.status || ''; $('pname').textContent = m.name; renderQuiz(m); return; }
      if (m.phase === 'menu') { showGarage(false); overlay(false); document.body.classList.remove('racing'); releaseAll(); $('status').textContent = 'Choose a game'; $('pname').textContent = m.name; return; }
      $('pname').textContent = m.name; $('status').textContent = m.status || '';
      document.body.classList.toggle('racing', m.phase === 'race');
      if (m.phase === 'lobby') { overlay(false); showGarage(true); }
      else if (m.phase === 'wait') { showGarage(false); overlay(true, 'Race in progress', 'You will join the next race.'); }
      else if (m.phase === 'quizwait') { showGarage(false); overlay(true, m.title, m.sub); }
      else if (m.phase === 'results' && m.locked) { showGarage(false); overlay(true, m.title || 'Finished!', m.sub || ''); }   // quiz comes first
      else if (m.phase === 'results') { showGarage(false); overlay(true, m.title || 'Finished!', m.sub || '', 'PLAY AGAIN', true); $('obtn2').textContent = game === 'sunny' ? '🏎️ Change racer' : '🎨 Change car'; }
      else if (m.phase === 'paused') { showGarage(false); releaseAll(); overlay(true, '⏸ Paused', m.by ? `${m.by} paused the race` : '', '▶ RESUME', true); $('obtn2').textContent = '🏠 Quit race'; }
      else { showGarage(false); overlay(false); if (was !== 'race') setItem(null); }
    }
    else if (m.t === 'hud') onHud(m);
    else if (m.t === 'fx') onFx(m.k, m.v);
  };
  ws.onclose = (e) => {
    if (e.code === 4004 || e.code === 4003) { $('status').textContent = ''; return; }   // no such room / server full: wait for the player
    $('status').textContent = 'Reconnecting…'; if (e.code !== 4001) setTimeout(connect, 1000);
  };
}

// ---------------------------------------------------------------- full screen
// Browsers only allow it inside a tap, and drop it when the phone locks or the page reloads,
// so ask again on every main tap until it sticks; the ⛶ button shows while we're not full screen.
const isFs = () => !!(document.fullscreenElement || document.webkitFullscreenElement);
function goFullscreen() {
  if (isFs()) return;
  const el = document.documentElement;
  try {
    const p = (el.requestFullscreen || el.webkitRequestFullscreen)?.call(el, { navigationUI: 'hide' });
    p?.then?.(() => { try { screen.orientation?.lock?.('landscape').catch(() => {}); } catch {} }).catch?.(() => {});
  } catch {}
}
const fsState = () => document.body.classList.toggle('notfs', !isFs() && document.body.classList.contains('playing'));
document.addEventListener('fullscreenchange', fsState);
document.addEventListener('webkitfullscreenchange', fsState);
setInterval(fsState, 1000);
$('fsBtn').addEventListener('click', goFullscreen);
for (const id of ['startBtn', 'obtn', 'obtn2', 'gas', 'brake', 'drift', 'sitem', 'stickArea']) $(id).addEventListener('pointerup', goFullscreen);

// hosted server: phones need the TV's room code (normally from the QR link). Ask for it when we don't have one.
let noRoom = false;
if (window.KR && !KR.padRoom() && !/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(location.hostname)) $('roomrow').hidden = false;
function showJoin(msg) { $('join').classList.add('on'); $('pad').classList.remove('on'); document.body.classList.remove('playing'); $('msg').textContent = msg || ''; }
$('joinBtn').addEventListener('click', () => {
  localStorage.setItem('nr_name', $('name').value.trim());
  sfx.init();
  $('join').classList.remove('on'); $('pad').classList.add('on'); document.body.classList.add('playing');
  goFullscreen();
  overlay(true, 'Connecting…');
  if (localStorage.getItem('nr_tilt3') === '1') enableTilt();   // the thumbstick is the default; tilt is opt-in
  connect();
});
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && ws && ws.readyState > 1) connect(); });
setThemeColor();
