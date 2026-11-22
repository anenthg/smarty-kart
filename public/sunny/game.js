// Sunny Kart, the TV screen. A Mario Kart-style racer built for the family TV (Mali-450, WebGL 1, slow ARM CPU).
// Engine parts (renderer, batching, projectiles, split screen, pause, HUD loop, phone protocol) are shared with Neon Racer;
// the kart handling is ported from Mario Kart 3.js (speed eases to top speed, hop → drift with a ±1.4 steering bias,
// 3 spark levels, the body swings out in a drift, sand slows you, walls bounce you back).
// Track: Mario Kart 3.js's "SNES Mario Circuit 3" model, cut from 460k to ~31k triangles with baked sunlight
// (blender/sunny/build_sunny_track.py). Private family use only.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Quiz } from '/quiz/quiz.js';
import { LEVELS, LEVEL_IDS, sanitizeLevel, loadLevel, saveLevel, botSpeedMul, levelStripHTML } from '/js/levels.js';
const LEVEL_HINT = '◀ ▶ level · ▲ join<br>OK start · Back games';
// ---- difficulty level (js/levels.js): one per race, changed in the lobby / results by the remote (◀ ▶) or any phone
let level = loadLevel();
const LV = () => LEVELS[level];
function setLevel(v) {
  v = sanitizeLevel(v); if (v === level) return;
  level = v; saveLevel(v); renderLevel(); syncPads(true);
}
function stepLevel(d) { setLevel(LEVEL_IDS[Math.max(0, Math.min(LEVEL_IDS.length - 1, LEVEL_IDS.indexOf(level) + d))]); }
function renderLevel() {
  for (const id of ['lvlstrip', 'lvlstrip2']) { const el = document.getElementById(id); if (el) el.innerHTML = levelStripHTML(level, LEVEL_HINT); }
}

import { KartModel, preparePart as prepareKartPart } from '/sunny/kartlook.js';
import { RACERS, RACER_IDS, sanitizeRacer, BODIES, WHEELS, BODY_IDS, WHEEL_IDS, sanitizeKart, kartColor, kartPhys, ITEM_ICONS, ITEM_NAMES as ITEM_LABELS } from '/sunny/racers.js';

THREE.ColorManagement.enabled = false;

const Q = new URLSearchParams(location.search);
const DEBUG = Q.has('debug');
const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const wrapA = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
const ord = (n) => n + (['th', 'st', 'nd', 'rd'][(n % 100 > 10 && n % 100 < 14) ? 0 : (n % 10 < 4 ? n % 10 : 0)] || 'th');
const sfx2 = (n) => ord(n).slice(-2);
const fmtTime = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LAPS = clamp(Number(Q.get('laps')) || 3, 1, 9);
const GAME = 'sunny';
const BOT_NAMES = ['Rex', 'Pip', 'Dot', 'Max'];
const ITEMS = ITEM_ICONS;
const ITEM_NAMES = Object.fromEntries(Object.keys(ITEM_ICONS).map((k) => [k, `${ITEM_ICONS[k]} ${ITEM_LABELS[k].toUpperCase()}!`]));
const itemLabel = (c) => c.item ? ITEMS[c.item] + (c.itemN > 1 ? '×' + c.itemN : '') : '';
const MAX_COINS = 10;                    // each coin adds a little top speed, up to 10 (Mario Kart)
const TURBO = [0, 0.6, 1.1, 1.7];        // mini-turbo seconds for blue / orange / purple sparks
const DRIFT_AT = [0, 0.7, 1.5, 2.5];     // seconds of drifting to reach each spark level (Mario Kart 3.js uses 1 / 3 / 6)
const TIER_COL = [[1, 1, 1], [0.45, 0.85, 1], [1, 0.62, 0.2], [0.85, 0.45, 1]];   // Mario Kart 3.js spark colours
const KART_SCALE = 1.35;                 // the road is ~23 m wide; bigger karts read better on the TV
const CATCH_UP = 70;
const SKY_TOP = 0x3f9dff, SKY_HORIZON = 0xcfeaff;
const FOG_COLOR = SKY_HORIZON;
const dbgLog = (t, m) => { if (window.__dbgLog) window.__dbgLog(t, m); };

let renderer, scene, camera, track, pickups, fx, sparks, skyGroup, quiz = null, lastOrder = [];
const parts = { body: {}, wheels: {}, driver: {}, steer: null, info: null };   // kart parts (assets/v2), combined per racer in Car
const KART_DIR = '/sunny/assets/v2/';
const OUTLINE = Q.get('outline') === '1';   // cartoon outline on the karts (off by default: costs draw calls on the TV)
let matcaps = null, kartMat = null;

// ------------------------------------------------------------------ renderer (created inside boot's try)
let renderH = 540, pixelRatio = 1, targetFps = 30;
function createRenderer() {
  const canvas = $('gl');
  renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, stencil: false, depth: true, powerPreference: 'high-performance', preserveDrawingBuffer: false });
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;   // gamma-space workflow (see header)
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.info.autoReset = false;   // reset once per frame (split screen renders twice)
  const caps = renderer.capabilities;
  const gl = renderer.getContext();
  const dbgInfo = gl.getExtension('WEBGL_debug_renderer_info');
  const gpu = dbgInfo ? gl.getParameter(dbgInfo.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  // TV-class (WebGL 1) devices render at 960×540; faster devices up to 1080p. ?res=720 overrides.
  renderH = Number(Q.get('res')) || (caps.isWebGL2 ? Math.min(1080, Math.round(innerHeight * (devicePixelRatio || 1))) : 540);
  targetFps = caps.isWebGL2 ? 55 : 28;
  dbgLog('webgl', `webgl2=${caps.isWebGL2} precision=${caps.precision} maxTex=${caps.maxTextures} vtx-tex=${caps.maxVertexTextures} gpu=${gpu} renderH=${renderH}`);
  resize();
  window.addEventListener('resize', resize);
}
function resize() {
  const w = innerWidth, h = innerHeight;
  pixelRatio = Math.min(renderH / h, 2);
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(w, h, true);
  if (camera) { camera.aspect = w / h; camera.updateProjectionMatrix(); }
  document.documentElement.style.setProperty('--ui', String(Math.max(0.6, h / 540)));
}

// ------------------------------------------------------------------ small helpers
function canvasTex(w, h, draw, repeat = false) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}
// additive glows must fade to black with distance (normal fog would add fog colour on top)
function fogFadeToBlack(mat) {
  mat.onBeforeCompile = (s) => {
    s.fragmentShader = s.fragmentShader.replace('#include <fog_fragment>',
      '#ifdef USE_FOG\n float fogF = smoothstep( fogNear, fogFar, vFogDepth );\n gl_FragColor.rgb *= 1.0 - fogF;\n#endif');
  };
  return mat;
}
const additive = (opts = {}) => fogFadeToBlack(new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, ...opts }));

// glow atlas (512×128): [radial blob | headlight beam | ring | soft blob]
let glowAtlas, radialTex;
function makeTextures() {
  glowAtlas = canvasTex(512, 128, (g) => {
    const blob = (cx, inner) => {
      const r = g.createRadialGradient(cx, 64, 0, cx, 64, 62);
      r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(inner, 'rgba(255,255,255,0.35)'); r.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = r; g.fillRect(cx - 64, 0, 128, 128);
    };
    blob(64, 0.35);
    const lg = g.createLinearGradient(0, 124, 0, 4);
    lg.addColorStop(0, 'rgba(255,255,255,0.9)'); lg.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = lg; g.beginPath(); g.moveTo(128 + 52, 124); g.lineTo(128 + 76, 124); g.lineTo(256 - 6, 6); g.lineTo(128 + 6, 6); g.closePath(); g.fill();
    const rr = g.createRadialGradient(320, 64, 30, 320, 64, 62);
    rr.addColorStop(0, 'rgba(255,255,255,0)'); rr.addColorStop(0.6, 'rgba(255,255,255,1)'); rr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = rr; g.fillRect(256, 0, 128, 128);
    blob(448, 0.6);
  });
  radialTex = canvasTex(64, 64, (g, w, h) => {
    const r = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(0.4, 'rgba(255,255,255,0.4)'); r.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = r; g.fillRect(0, 0, w, h);
  });
}
const ATLAS = { blob: [0, 0.25], beam: [0.25, 0.5], ring: [0.5, 0.75], soft: [0.75, 1] };

// ------------------------------------------------------------------ dynamic quad batch (one draw call)
class QuadBatch {
  constructor(max, material, withColor = true) {
    this.max = max; this.n = 0;
    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(max * 12); this.uv = new Float32Array(max * 8); this.col = withColor ? new Float32Array(max * 12) : null;
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('uv', new THREE.BufferAttribute(this.uv, 2).setUsage(THREE.DynamicDrawUsage));
    if (withColor) g.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    const idx = new Uint16Array(max * 6);
    for (let i = 0; i < max; i++) idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    if (withColor) material.vertexColors = true;
    material.side = THREE.DoubleSide;   // quads are wound both ways (ground / upright); never cull them
    this.mesh = new THREE.Mesh(g, material);
    this.mesh.frustumCulled = false; this.mesh.matrixAutoUpdate = false;
    this.geo = g;
  }
  begin() { this.n = 0; }
  // flat quad on the ground (y), centred at x,z, rotated by heading h, half sizes along right (hw) and forward (hl)
  ground(x, y, z, h, hw, hl, u0, u1, r, gC, b, fwdOff = 0) {
    if (this.n >= this.max) return;
    const s = Math.sin(h), c = Math.cos(h);
    const cx = x + s * fwdOff, cz = z + c * fwdOff;
    const rx = c * hw, rz = -s * hw, fx = s * hl, fz = c * hl;
    const i = this.n++, p = this.pos, o = i * 12;
    p[o] = cx - rx - fx; p[o + 1] = y; p[o + 2] = cz - rz - fz;
    p[o + 3] = cx + rx - fx; p[o + 4] = y; p[o + 5] = cz + rz - fz;
    p[o + 6] = cx + rx + fx; p[o + 7] = y; p[o + 8] = cz + rz + fz;
    p[o + 9] = cx - rx + fx; p[o + 10] = y; p[o + 11] = cz - rz + fz;
    this._uvcol(i, u0, u1, r, gC, b);
  }
  // upright quad facing along heading h (seen from behind/in front), centre x,y,z
  upright(x, y, z, h, hw, hh, u0, u1, r, gC, b) {
    if (this.n >= this.max) return;
    const s = Math.sin(h), c = Math.cos(h), rx = c * hw, rz = -s * hw;
    const i = this.n++, p = this.pos, o = i * 12;
    p[o] = x - rx; p[o + 1] = y - hh; p[o + 2] = z - rz;
    p[o + 3] = x + rx; p[o + 4] = y - hh; p[o + 5] = z + rz;
    p[o + 6] = x + rx; p[o + 7] = y + hh; p[o + 8] = z + rz;
    p[o + 9] = x - rx; p[o + 10] = y + hh; p[o + 11] = z - rz;
    this._uvcol(i, u0, u1, r, gC, b);
  }
  _uvcol(i, u0, u1, r, g, b) {
    const t = this.uv, o = i * 8;
    t[o] = u0; t[o + 1] = 0; t[o + 2] = u1; t[o + 3] = 0; t[o + 4] = u1; t[o + 5] = 1; t[o + 6] = u0; t[o + 7] = 1;
    if (this.col) { const c = this.col, k = i * 12; for (let v = 0; v < 4; v++) { c[k + v * 3] = r; c[k + v * 3 + 1] = g; c[k + v * 3 + 2] = b; } }
  }
  end() {
    this.geo.setDrawRange(0, this.n * 6);
    this.geo.attributes.position.needsUpdate = true; this.geo.attributes.uv.needsUpdate = true;
    if (this.col) this.geo.attributes.color.needsUpdate = true;
  }
}

// ------------------------------------------------------------------ track maths (centre line every 2 m, per-sample widths)
class Track {
  constructor(d) {
    this.L = d.length; this.sp = d.spacing; this.roadHalf = d.roadHalf;
    const n = (this.n = d.points.length);
    this.x = new Float32Array(n); this.z = new Float32Array(n); this.tx = new Float32Array(n); this.tz = new Float32Array(n);
    this.half = Float32Array.from(d.half); this.wallL = Float32Array.from(d.wallL); this.wallR = Float32Array.from(d.wallR);
    d.points.forEach((p, i) => { this.x[i] = p[0]; this.z[i] = p[1]; });
    for (let i = 0; i < n; i++) {
      const a = (i - 1 + n) % n, b = (i + 1) % n;
      const dx = this.x[b] - this.x[a], dz = this.z[b] - this.z[a], l = Math.hypot(dx, dz);
      this.tx[i] = dx / l; this.tz[i] = dz / l;
    }
    this.wallIn = this.roadHalf + 6;   // a typical wall distance (used for spawning things)
    this._loc = { i: 0, s: 0, d: 0, Rx: 0, Rz: 0, tx: 0, tz: 0 };
    this._at = { x: 0, z: 0, tx: 0, tz: 0, h: 0 };
  }
  idx(s) { return ((Math.round(s / this.sp) % this.n) + this.n) % this.n; }
  halfAt(s) { return this.half[this.idx(s)]; }
  // wall distance on the side of lateral offset d (d > 0 = right of the driving direction)
  wallAtS(s, d) { const i = this.idx(s); return d >= 0 ? this.wallR[i] : this.wallL[i]; }
  // NOTE: returns a shared object (no allocation); copy what you need before the next call
  locate(px, pz, hint = -1) {
    const n = this.n; let best = 0, bd = Infinity;
    const lo = hint < 0 ? 0 : hint - 30, hi = hint < 0 ? n : hint + 30;
    for (let k = lo; k < hi; k++) {
      const i = ((k % n) + n) % n, dx = px - this.x[i], dz = pz - this.z[i], d = dx * dx + dz * dz;
      if (d < bd) { bd = d; best = i; }
    }
    let i = best, j = (i + 1) % n;
    let sx = this.x[j] - this.x[i], sz = this.z[j] - this.z[i];
    let t = ((px - this.x[i]) * sx + (pz - this.z[i]) * sz) / (sx * sx + sz * sz);
    if (t < 0) { i = (i - 1 + n) % n; j = best; sx = this.x[j] - this.x[i]; sz = this.z[j] - this.z[i]; t = ((px - this.x[i]) * sx + (pz - this.z[i]) * sz) / (sx * sx + sz * sz); }
    t = clamp(t, 0, 1);
    const cx = this.x[i] + sx * t, cz = this.z[i] + sz * t;
    const tx = this.tx[i] + (this.tx[j] - this.tx[i]) * t, tz = this.tz[i] + (this.tz[j] - this.tz[i]) * t, tl = Math.hypot(tx, tz);
    const o = this._loc;
    o.i = best; o.s = (i + t) * this.sp; o.Rx = -tz / tl; o.Rz = tx / tl; o.d = (px - cx) * o.Rx + (pz - cz) * o.Rz; o.tx = tx / tl; o.tz = tz / tl;
    return o;
  }
  at(s, lateral = 0) {
    const n = this.n; s = ((s % this.L) + this.L) % this.L;
    const f = s / this.sp, i = Math.floor(f) % n, j = (i + 1) % n, t = f - Math.floor(f);
    const tx = this.tx[i] + (this.tx[j] - this.tx[i]) * t, tz = this.tz[i] + (this.tz[j] - this.tz[i]) * t, tl = Math.hypot(tx, tz);
    const x = this.x[i] + (this.x[j] - this.x[i]) * t, z = this.z[i] + (this.z[j] - this.z[i]) * t;
    const o = this._at;
    o.x = x + (-tz / tl) * lateral; o.z = z + (tx / tl) * lateral; o.tx = tx / tl; o.tz = tz / tl; o.h = Math.atan2(tx, tz);
    return o;
  }
  heading(s) { return this.at(s).h; }
}

// ------------------------------------------------------------------ loading
const manager = new THREE.LoadingManager();
manager.onProgress = (url, loaded, total) => { $('loadfill').style.width = `${(loaded / total) * 100}%`; };
const gltfLoader = new GLTFLoader(manager);

// daylight matcap drawn in code: a glossy plastic ball lit from the upper left (no textures to download)
function makeSunMatcap() {
  return canvasTex(128, 128, (g, w, h) => {
    const base = g.createRadialGradient(w * 0.42, h * 0.38, 6, w * 0.5, h * 0.5, w * 0.5);
    base.addColorStop(0, '#ffffff'); base.addColorStop(0.55, '#d9d9d9'); base.addColorStop(0.85, '#9a9a9a'); base.addColorStop(1, '#6c6c6c');
    g.fillStyle = base; g.fillRect(0, 0, w, h);
    const spec = g.createRadialGradient(w * 0.33, h * 0.27, 0, w * 0.33, h * 0.27, w * 0.16);
    spec.addColorStop(0, 'rgba(255,255,255,1)'); spec.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = spec; g.fillRect(0, 0, w, h);
    const rim = g.createLinearGradient(0, h, 0, h * 0.6);
    rim.addColorStop(0, 'rgba(140,200,255,0.35)'); rim.addColorStop(1, 'rgba(140,200,255,0)');
    g.fillStyle = rim; g.fillRect(0, 0, w, h);
  });
}

async function loadAll() {
  const glb = (n) => gltfLoader.loadAsync(`/sunny/assets/${n}.glb`);
  const kglb = (n) => gltfLoader.loadAsync(KART_DIR + n + '.glb');
  const [tj, info, tg, pg, bodies, wheels, drivers, steer] = await Promise.all([
    fetch('/sunny/assets/track.json').then((r) => r.json()),
    fetch(KART_DIR + 'kart_parts.json').then((r) => r.json()),
    glb('track'),
    gltfLoader.loadAsync('/assets/pickups.glb'),
    Promise.all(BODY_IDS.map((id) => kglb('body_' + id))),
    Promise.all(WHEEL_IDS.map((id) => kglb('wheels_' + id))),
    Promise.all(RACER_IDS.map((id) => kglb('driver_' + id))),
    kglb('steer'),
  ]);
  parts.info = info;
  const m = makeSunMatcap();
  matcaps = { gloss: m, detail: m, gold: m };
  kartMat = new THREE.MeshMatcapMaterial({ matcap: m, vertexColors: true });
  track = new Track(tj);
  setupTrack(tg.scene);
  BODY_IDS.forEach((id, k) => { parts.body[id] = prepareKartPart(bodies[k].scene); });
  WHEEL_IDS.forEach((id, k) => { parts.wheels[id] = prepareKartPart(wheels[k].scene); parts.wheels[id].lift = info.wheels[id].lift; parts.wheels[id].rearR = info.wheels[id].rearR; });
  RACER_IDS.forEach((id, k) => { parts.driver[id] = prepareKartPart(drivers[k].scene); });
  parts.steer = prepareKartPart(steer.scene);
  pickups = new Pickups(pg.scene);
  projectiles = new Projectiles(pg.scene);
  buildStartLights();
}

function rawTex(t) { if (t) { t.colorSpace = THREE.NoColorSpace; t.anisotropy = 1; } return t; }

const PIVOT = new THREE.Vector3(0, 0.62, -0.3);   // driver's seat (three.js coordinates, before KART_SCALE)
// one exported part → { Paint, Trim, Driver, Wheels geometries (baked transforms), wheel texture, rearZ }
function preparePart(root) {
  const out = { rearZ: -1.5 };
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    if (!o.isMesh) return;
    const g = o.geometry.clone().applyMatrix4(o.matrixWorld);
    g.computeBoundingSphere();
    const n = o.material.name.replace(/\.\d+$/, '');   // Blender may export 'Wheel.001' etc.
    if (n === 'Driver') g.translate(-PIVOT.x, -PIVOT.y, -PIVOT.z);   // pivot at the seat so the driver can lean and bounce
    if (n === 'Wheel') out.wheelTex = rawTex(o.material.map);
    out[n] = g;
    o.material.dispose();
  });
  const box = new THREE.Box3().setFromObject(root);
  out.rearZ = box.min.z;
  return out;
}

function setupTrack(root) {
  const mats = {};
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    if (!o.isMesh) return;
    const old = o.material, name = old.name;
    if (!mats[name]) {
      const map = rawTex(old.map);
      if (map && map.image && map.image.width <= 64) { map.magFilter = THREE.NearestFilter; map.minFilter = THREE.NearestFilter; map.generateMipmaps = false; }   // tiny colour palettes
      mats[name] = new THREE.MeshBasicMaterial({ map, vertexColors: true, color: old.color ? old.color.clone() : 0xffffff, side: name === 'Banner' || name === 'Props' ? THREE.DoubleSide : THREE.FrontSide });
      if (name === 'Hills') mats[name].fog = true;
    }
    o.material = mats[name];
    if (old !== o.material) old.dispose();
    o.matrixAutoUpdate = false; o.updateMatrix();
  });
  scene.add(root);
}

function setupSky() {
  skyGroup = new THREE.Group();
  const R = 900, geo = new THREE.SphereGeometry(R, 20, 10);
  const pos = geo.attributes.position, col = new Float32Array(pos.count * 3);
  const hz = new THREE.Color(SKY_HORIZON), top = new THREE.Color(SKY_TOP), c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) / R;
    c.copy(hz).lerp(top, clamp(y / 0.45, 0, 1));
    col.set([c.r, c.g, c.b], i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const sky = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }));
  sky.renderOrder = -2; sky.frustumCulled = false; skyGroup.add(sky);
  scene.add(skyGroup);
}

// ------------------------------------------------------------------ sparks (one Points draw)
class Sparks {
  constructor(n) {
    this.n = n; this.head = 0;
    this.pos = new Float32Array(n * 3).fill(-9999); this.vel = new Float32Array(n * 3); this.life = new Float32Array(n);
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    const m = new THREE.PointsMaterial({ color: 0xffb040, size: 0.35, map: radialTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    this.mesh = new THREE.Points(g, m); this.mesh.frustumCulled = false; this.geo = g; this.active = 0;
  }
  emit(x, y, z, nx, nz, count) {
    for (let k = 0; k < count; k++) {
      const i = this.head; this.head = (this.head + 1) % this.n;
      this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
      this.vel[i * 3] = nx * 6 + (Math.random() - 0.5) * 8; this.vel[i * 3 + 1] = Math.random() * 6 + 1; this.vel[i * 3 + 2] = nz * 6 + (Math.random() - 0.5) * 8;
      this.life[i] = 0.35 + Math.random() * 0.35;
    }
    this.active = 1;
  }
  update(dt) {
    if (!this.active) return;
    let any = 0;
    for (let i = 0; i < this.n; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) { this.pos[i * 3 + 1] = -9999; continue; }
      any = 1;
      this.vel[i * 3 + 1] -= 18 * dt;
      this.pos[i * 3] += this.vel[i * 3] * dt; this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt; this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
    }
    this.geo.attributes.position.needsUpdate = true;
    this.active = any;
  }
}
const emitSparks = (...a) => sparks.emit(...a);

// ------------------------------------------------------------------ pickups: coins, item boxes, boost pads (1 draw each)
// Merged geometry + per-vertex centre + alive flag; the vertex shader spins/bobs every copy with one uniform.
function spinningMaterial(base, spinX = false) {
  const u = { uSpin: { value: 0 } };
  base.onBeforeCompile = (s) => {
    s.uniforms.uSpin = u.uSpin;
    const rot = spinX
      ? 'vec3 rotP(vec3 p, float a){ float c=cos(a), s=sin(a); p = vec3(p.x*c+p.z*s, p.y, -p.x*s+p.z*c); float b=a*0.7; float cb=cos(b), sb=sin(b); return vec3(p.x, p.y*cb-p.z*sb, p.y*sb+p.z*cb); }'
      : 'vec3 rotP(vec3 p, float a){ float c=cos(a), s=sin(a); return vec3(p.x*c+p.z*s, p.y, -p.x*s+p.z*c); }';
    s.vertexShader = 'attribute vec3 aCenter;\nattribute float aAlive;\nuniform float uSpin;\n' + rot + '\n' + s.vertexShader
      .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = rotP( normal, uSpin + aCenter.x * 0.07 );')
      .replace('#include <begin_vertex>', 'vec3 transformed = rotP( position, uSpin + aCenter.x * 0.07 ) * aAlive + aCenter;\n transformed.y += sin( uSpin * 1.3 + aCenter.z * 0.3 ) * 0.15;');
  };
  base.userData.u = u;
  return base;
}

function mergeCopies(src, centers) {
  const per = src.attributes.position.count;
  const idx = src.index ? src.index.array : null;
  const n = centers.length;
  const pos = new Float32Array(per * n * 3), nor = new Float32Array(per * n * 3), uv = new Float32Array(per * n * 2);
  const cen = new Float32Array(per * n * 3), alive = new Float32Array(per * n).fill(1);
  const index = new Uint16Array((idx ? idx.length : per) * n);
  if (per * n > 65535) throw new Error('mergeCopies: too many vertices for 16-bit indices');
  for (let k = 0; k < n; k++) {
    pos.set(src.attributes.position.array, k * per * 3);
    nor.set(src.attributes.normal.array, k * per * 3);
    if (src.attributes.uv) uv.set(src.attributes.uv.array, k * per * 2);
    for (let v = 0; v < per; v++) cen.set(centers[k], (k * per + v) * 3);
    if (idx) for (let q = 0; q < idx.length; q++) index[k * idx.length + q] = idx[q] + k * per;
    else for (let q = 0; q < per; q++) index[k * per + q] = q + k * per;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('aCenter', new THREE.BufferAttribute(cen, 3));
  g.setAttribute('aAlive', new THREE.BufferAttribute(alive, 1).setUsage(THREE.DynamicDrawUsage));
  g.setIndex(new THREE.BufferAttribute(index, 1));
  g.userData.per = per;
  return g;
}

class Pickups {
  constructor(tpl) {
    const geoOf = (n) => { let g = null; tpl.traverse((c) => { if (c.isMesh && c.name === n && !g) g = c.geometry; }); return g; };
    const L = track.L;
    const straight = (s) => Math.abs(wrapA(track.heading(s + 60) - track.heading(s)));
    const nearStart = (s) => s < 45 || s > L - 70;
    const sep = (s, list, d) => list.every((q) => { const ds = Math.abs(s - q); return Math.min(ds, L - ds) > d; });
    // item-box rows at 3 places (like Mario Kart: one early, one mid, one late), on the straightest bit nearby
    this.boxRows = [];
    for (const f of [0.17, 0.48, 0.77]) {
      let best = f * L, bv = 9;
      for (let s = f * L - 60; s < f * L + 60; s += 4) { const v = straight(s); if (v < bv) { bv = v; best = s; } }
      this.boxRows.push(best);
    }
    // dash panels on two long straights
    this.padS = [];
    for (let s = 0; s < L; s += 6) {
      if (nearStart(s) || straight(s) > 0.05) continue;
      if (sep(s, this.padS, 300) && sep(s, this.boxRows, 60) && this.padS.length < 3) this.padS.push(s);
    }
    this.items = [];
    const add = (type, s, lat) => { const p = track.at(s, lat); this.items.push({ type, s: ((s % L) + L) % L, lat, x: p.x, z: p.z, h: p.h, on: true, t: 0, k: 0 }); };
    for (const s of this.boxRows) { const w = Math.min(track.halfAt(s) - 2.5, 8); [-w, -w / 3, w / 3, w].forEach((lat) => add('box', s, lat)); }
    this.padS.forEach((s, k) => add('pad', s, [-4, 4, 0][k % 3]));
    const used = [...this.boxRows, ...this.padS];
    let k = 0;
    for (let s = 70; s < L - 70; s += 95) {
      if (!sep(s, used, 30) && !sep(s + 25, used, 30)) continue;
      const shape = k++ % 3, hw = track.halfAt(s) - 3, base = (((k * 37) % 9) / 9 - 0.5) * hw;
      for (let j = 0; j < 6; j++) {
        const lat = shape === 0 ? base : shape === 1 ? (hw * 0.6) * Math.sin(j * 0.6 + k) : (-hw * 0.6 + j * hw * 0.24) * (k % 2 ? 1 : -1);
        add('coin', s + j * 5, lat);
      }
    }
    this.coins = this.items.filter((i) => i.type === 'coin');
    this.boxes = this.items.filter((i) => i.type === 'box');
    this.pads = this.items.filter((i) => i.type === 'pad');

    // coins: bright gold discs
    this.coins.forEach((c, i) => { c.k = i; });
    this.coinGeo = mergeCopies(geoOf('Coin'), this.coins.map((c) => [c.x, 1.3, c.z]));
    const coinTex = canvasTex(128, 128, (g, w, h) => {
      g.fillStyle = '#ffd21f'; g.fillRect(0, 0, w, h);
      g.beginPath(); g.ellipse(64, 64, 20, 40, 0, 0, Math.PI * 2); g.lineWidth = 9; g.strokeStyle = '#c78a00'; g.stroke();
      g.beginPath(); g.arc(64, 64, 58, 0, Math.PI * 2); g.lineWidth = 6; g.strokeStyle = '#fff3a8'; g.stroke();
    });
    coinTex.flipY = false;
    this.coinMat = spinningMaterial(new THREE.MeshBasicMaterial({ map: coinTex }));
    const coinMesh = new THREE.Mesh(this.coinGeo, this.coinMat); coinMesh.frustumCulled = false;
    scene.add(coinMesh);

    // item boxes: rainbow see-through cubes with a "?"
    this.boxes.forEach((b, i) => { b.k = i; });
    this.boxGeo = mergeCopies(geoOf('ItemBox'), this.boxes.map((b) => [b.x, 1.6, b.z]));
    const qTex = canvasTex(128, 128, (g, w, h) => {
      g.fillStyle = '#d8d8d8'; g.fillRect(0, 0, w, h);
      g.strokeStyle = '#ffffff'; g.lineWidth = 12; g.strokeRect(6, 6, w - 12, h - 12);
      g.font = '900 92px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.lineWidth = 10; g.strokeStyle = '#30306a'; g.strokeText('?', 64, 70); g.fillStyle = '#ffffff'; g.fillText('?', 64, 70);
    });
    qTex.flipY = false;
    this.boxMat = spinningMaterial(new THREE.MeshMatcapMaterial({ matcap: matcaps.gloss, map: qTex, transparent: true, opacity: 0.88 }), true);
    const boxMesh = new THREE.Mesh(this.boxGeo, this.boxMat); boxMesh.frustumCulled = false; boxMesh.renderOrder = 1;
    scene.add(boxMesh);

    // dash panels: orange/yellow chevrons, merged into one mesh
    const padSrc = geoOf('BoostPad');
    const padTex = canvasTex(64, 128, (g, w, h) => {
      g.fillStyle = '#ff7a00'; g.fillRect(0, 0, w, h);
      g.fillStyle = '#ffe14a';
      for (let y = -32; y < h; y += 42) { g.beginPath(); g.moveTo(6, y + 34); g.lineTo(w / 2, y + 6); g.lineTo(w - 6, y + 34); g.lineTo(w - 6, y + 50); g.lineTo(w / 2, y + 22); g.lineTo(6, y + 50); g.closePath(); g.fill(); }
      g.fillStyle = '#ffffff'; g.fillRect(0, 0, 4, h); g.fillRect(w - 4, 0, 4, h);
    }, true);
    const pg = [];
    for (const p of this.pads) { const g = padSrc.clone(); g.applyMatrix4(new THREE.Matrix4().makeRotationY(p.h).setPosition(p.x, 0.04, p.z)); pg.push(g); }
    if (pg.length) {
      const per = pg[0].attributes.position.count, idx = pg[0].index.array;
      const pos = new Float32Array(per * 3 * pg.length), uv = new Float32Array(per * 2 * pg.length), index = new Uint16Array(idx.length * pg.length);
      pg.forEach((g, k2) => { pos.set(g.attributes.position.array, k2 * per * 3); uv.set(g.attributes.uv.array, k2 * per * 2); for (let q = 0; q < idx.length; q++) index[k2 * idx.length + q] = idx[q] + k2 * per; });
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); geo.setIndex(new THREE.BufferAttribute(index, 1));
      padTex.repeat.set(1, 2); this.padTex = padTex;
      const padMesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: padTex, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
      padMesh.renderOrder = 1; padMesh.matrixAutoUpdate = false;
      scene.add(padMesh);
    }
  }
  setAlive(geo, k, v) { const per = geo.userData.per, a = geo.attributes.aAlive; a.array.fill(v, k * per, (k + 1) * per); a.needsUpdate = true; }
  reset() {
    for (const it of this.items) { it.on = true; it.t = 0; }
    this.coinGeo.attributes.aAlive.array.fill(1); this.coinGeo.attributes.aAlive.needsUpdate = true;
    this.boxGeo.attributes.aAlive.array.fill(1); this.boxGeo.attributes.aAlive.needsUpdate = true;
  }
  update(dt, t) {
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i];
      if (it.on) continue;
      it.t -= dt;
      if (it.t <= 0) { it.on = true; if (it.type === 'coin') this.setAlive(this.coinGeo, it.k, 1); else if (it.type === 'box') this.setAlive(this.boxGeo, it.k, 1); }
    }
    this.coinMat.userData.u.uSpin.value = t * 3;
    this.boxMat.userData.u.uSpin.value = t * 1.2;
    this.boxMat.color.setHSL((t * 0.3) % 1, 0.85, 0.66);
    if (this.padTex) this.padTex.offset.y = (-t * 1.4) % 1;
  }
  // Mario Kart item odds: the leader mostly gets defence (banana, green shell, coins, horn); the back of the pack gets
  // mushrooms, red shells, stars and the bullet. Counts (×3) set car.itemN.
  rollItem(car) {
    const n = Math.max(2, cars.length), p = Math.min(1, (car.place - 1) / (n - 1) + (car.human ? LV().luck : 0)), q = 1 - p;   // Easy: kids roll as if further back
    const table = [
      ['banana', 1, 1.0 * q + 0.1], ['banana', 3, 0.45 * q], ['green', 1, 0.7 * q + 0.3], ['green', 3, 0.35 * p * q * 4],
      ['red', 1, p > 0 ? 0.15 + 0.7 * p : 0.05], ['red', 3, 0.5 * p], ['mushroom', 1, 0.25 + 0.5 * p], ['mushroom', 3, 0.8 * p],
      ['coin', 1, 0.7 * q], ['horn', 1, 0.3 * q + 0.05], ['star', 1, 0.6 * p * p], ['bullet', 1, 0.9 * p * p * p],
    ];
    if (!car.human && LV().noRedAtKids) for (const e of table) if (e[0] === 'red' || e[0] === 'homing') e[2] = 0;   // Easy: no chasing shells
    let sum = 0; for (const e of table) sum += e[2];
    let r = Math.random() * sum;
    for (const e of table) { if ((r -= e[2]) <= 0) { car.itemN = e[1]; return e[0]; } }
    car.itemN = 1; return 'banana';
  }
  collide(car) {
    const L = track.L;
    let onPadNow = false;
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i];
      let ds = car.s - it.s; if (ds > L / 2) ds -= L; else if (ds < -L / 2) ds += L;
      if (it.type === 'pad') { if (ds > -3.6 && ds < 3.6 && Math.abs(car.d - it.lat) < 2.6) onPadNow = true; continue; }
      if (!it.on) continue;
      const R = it.type === 'coin' ? 2.4 : 2.6;
      if (ds > R + 1 || ds < -R - 1) continue;
      const dx = car.x - it.x, dz = car.z - it.z;
      if (dx * dx + dz * dz > R * R) continue;
      if (it.type === 'coin') {
        it.on = false; it.t = 9; this.setAlive(this.coinGeo, it.k, 0);
        car.coins = Math.min(MAX_COINS, car.coins + 1);
        emitSparks(it.x, 1.3, it.z, 0, 0, 6);
        car.fx('coin', car.coins);
        if (car.human) sound.sfx('coin', () => sound.coin(), 0.7, 0.95 + car.coins * 0.012);
      } else if (it.type === 'box' && !car.item && car.itemRoll <= 0) {
        it.on = false; it.t = 3; this.setAlive(this.boxGeo, it.k, 0);
        car.item = this.rollItem(car); car.itemRoll = 1.1;
        emitSparks(it.x, 1.6, it.z, 0, 0, 14);
        car.fx('roll');
        if (car.human) { sound.sfx('itembox', () => sound.beep(660, 0.1, 0.15, 'triangle'), 0.8); sound.play('roulette', 0.5); }
      }
    }
    if (onPadNow && !car.onPad) { car.padT = 1.0; car.fx('pad'); if (car.human) sound.sfx('dash', () => sound.whoosh(), 0.8); }
    car.onPad = onPadNow;
  }
}

// ------------------------------------------------------------------ projectiles: bananas, bouncy orbs, homing orbs
// Kept in track coordinates (distance along the track s, sideways offset d), so orbs follow the road and
// bounce off the walls without any 3D physics. Pooled meshes: hidden ones cost nothing to draw.
let projectiles;
class Projectiles {
  constructor(tpl) {
    const geoOf = (n) => { let g = null; tpl.traverse((c) => { if (c.isMesh && c.name === n && !g) g = c.geometry; }); return g; };
    const banGeo = geoOf('Banana'), orbGeo = geoOf('Orb');
    const banMat = new THREE.MeshMatcapMaterial({ matcap: matcaps.gloss, vertexColors: true });
    this.orbMat = { orb: new THREE.MeshMatcapMaterial({ matcap: matcaps.gloss, vertexColors: true, color: 0x22c840 }),
      homing: new THREE.MeshMatcapMaterial({ matcap: matcaps.gloss, vertexColors: true, color: 0xff3048 }) };
    const pool = (geo, mat, n) => Array.from({ length: n }, () => { const m = new THREE.Mesh(geo, mat); m.visible = false; m.scale.setScalar(1.3); scene.add(m); return m; });
    this.banPool = pool(banGeo, banMat, 12);
    this.orbPool = pool(orbGeo, this.orbMat.orb, 8);
    this.list = [];
  }
  clear() { for (const p of this.list) p.mesh.visible = false; this.list.length = 0; }
  _take(pool) {
    let m = pool.find((x) => !x.visible);
    if (!m) { const old = this.list.find((p) => pool.includes(p.mesh)); this._remove(old); m = old.mesh; }
    m.visible = true; return m;
  }
  _remove(p) { const i = this.list.indexOf(p); if (i >= 0) this.list.splice(i, 1); p.mesh.visible = false; }
  drop(car) {   // banana lands just behind the car
    const w = track.wallAtS(car.s - 3.4, car.d) - 1;
    const p = { type: 'banana', s: car.s - 3.4, d: clamp(car.d, -w, w), vs: 0, vd: 0, life: 40, owner: car, age: 0, rot: Math.random() * 6 };
    p.mesh = this._take(this.banPool); this.list.push(p); this._place(p);
  }
  fire(car, homing) {
    let target = homing ? car.ahead : null;
    if (homing && target && car.aheadGap > 140) target = null;
    const th = track.heading(car.s), rel = wrapA(car.h - th);
    const vs = Math.max(car.forwardSpeed, 10) + 30;
    const p = { type: homing ? 'homing' : 'orb', s: car.s + 3, d: car.d, vs, vd: homing ? 0 : clamp(Math.sin(rel) * vs, -12, 12),
      life: homing ? 8 : 5, owner: car, target, age: 0, rot: 0 };
    p.mesh = this._take(this.orbPool); p.mesh.material = this.orbMat[p.type];
    this.list.push(p); this._place(p);
  }
  _place(p) {
    const a = track.at(p.s, p.d);
    p.mesh.position.set(a.x, p.type === 'banana' ? 0 : 0.05 + Math.abs(Math.sin(p.age * 9)) * 0.12, a.z);
    p.mesh.rotation.y = p.type === 'banana' ? a.h + p.rot : p.age * 7;
  }
  step(dt) {
    const L = track.L;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const p = this.list[i];
      p.age += dt; p.life -= dt;
      if (p.life <= 0) { this._remove(p); continue; }
      if (p.type !== 'banana') {
        if (p.type === 'homing' && p.target) {
          const t = p.target; let ds = t.s - p.s; ds -= Math.round(ds / L) * L;
          p.vs = Math.max(t.speed + 16, 38);
          if (ds < 25) p.d += clamp(t.d - p.d, -9 * dt, 9 * dt);   // close in sideways at the end
        }
        p.s += p.vs * dt; p.d += p.vd * dt;
        const W = track.wallAtS(p.s, p.d) - 0.7;
        if (Math.abs(p.d) > W) { p.d = Math.sign(p.d) * W; p.vd = -p.vd; }   // bounce off the wall
        p.s = ((p.s % L) + L) % L;
      }
      // hit a car?
      for (const c of cars) {
        if (c === p.owner && p.age < 0.6) continue;
        let ds = c.s - p.s; ds -= Math.round(ds / L) * L;
        if (Math.abs(ds) > 1.9 || Math.abs(c.d - p.d) > 1.5) continue;
        if (p.type === 'homing' && p.target && c !== p.target && p.age < 0.6) continue;
        c.spinOut(p.owner);
        emitSparks(c.x, 0.8, c.z, 0, 0, 12);
        this._remove(p); break;
      }
    }
    // orbs knock out bananas (and each other)
    for (let i = this.list.length - 1; i >= 0; i--) for (let j = i - 1; j >= 0; j--) {
      const a = this.list[i], b = this.list[j];
      if (!a || !b || (a.type === 'banana' && b.type === 'banana')) continue;
      let ds = a.s - b.s; ds -= Math.round(ds / track.L) * track.L;
      if (Math.abs(ds) < 1.3 && Math.abs(a.d - b.d) < 1.3) {
        const pa = track.at(a.s, a.d); emitSparks(pa.x, 0.6, pa.z, 0, 0, 10);
        this._remove(a); this._remove(b); i = Math.min(i, this.list.length); break;
      }
    }
  }
  sync() {
    for (const p of this.list) {
      this._place(p);
      if (p.type !== 'banana') {
        const m = p.mesh.position, col = p.type === 'homing' ? [1, 0.2, 0.25] : [0.2, 1, 0.4];
        fx.glow.ground(m.x, 0.06, m.z, 0, 1.3, 1.3, ATLAS.soft[0], ATLAS.soft[1], col[0] * 0.6, col[1] * 0.6, col[2] * 0.6);
      }
    }
  }
  // horn blast: clear projectiles nearby
  clearAround(x, z, r) {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const p = this.list[i], m = p.mesh.position;
      if ((m.x - x) ** 2 + (m.z - z) ** 2 < r * r) { emitSparks(m.x, 0.6, m.z, 0, 0, 8); this._remove(p); }
    }
  }
}
function hornBlast(car) {
  car.hornT = 0.5;
  projectiles.clearAround(car.x, car.z, 13);
  for (const c of cars) if (c !== car && (c.x - car.x) ** 2 + (c.z - car.z) ** 2 < 9.5 * 9.5) c.spinOut(car);
  if (car.human) sound.sfx('horn', () => sound.noise(0.5, 0.45, 300, 120), 0.9);
}

// ------------------------------------------------------------------ start lights on the gantry: 3 red, then green
const lamps = [];
let lightsOn = 0, lampMats = null;
function buildStartLights() {
  const a = track.at(-0.75), R_ = -a.tz, Rz = a.tx;   // right vector
  const back = new THREE.Mesh(new THREE.BoxGeometry(7.4, 1.7, 0.25), new THREE.MeshBasicMaterial({ color: 0x0a0a12 }));
  back.position.set(a.x, 6.55, a.z); back.rotation.y = a.h; scene.add(back);
  lampMats = { off: new THREE.MeshBasicMaterial({ color: 0x2a0a0e }), red: new THREE.MeshBasicMaterial({ color: 0xff2030 }), green: new THREE.MeshBasicMaterial({ color: 0x30ff60 }) };
  const g = new THREE.CircleGeometry(0.6, 14);
  [-2.55, -0.85, 0.85, 2.55].forEach((off) => {
    const m = new THREE.Mesh(g, lampMats.off);
    m.position.set(a.x + R_ * off - a.tx * 0.15, 6.55, a.z + Rz * off - a.tz * 0.15);
    m.rotation.y = a.h + Math.PI;   // face the cars on the grid
    scene.add(m); lamps.push(m);
  });
}
function startLights(n) {   // n = 0 off, 1..3 red lamps, 4 = all green
  lightsOn = n;
  lamps.forEach((m, i) => { m.material = n === 4 ? lampMats.green : (i < n ? lampMats.red : lampMats.off); });
}
function drawStartLights() {
  if (!lightsOn) return;
  const a = track.at(-0.9);
  lamps.forEach((m, i) => {
    if (lightsOn !== 4 && i >= lightsOn) return;
    const [r, gC, b] = lightsOn === 4 ? [0.2, 1, 0.4] : [1, 0.15, 0.2];
    fx.glow.upright(m.position.x - a.tx * 0.1, 6.55, m.position.z - a.tz * 0.1, a.h, 1.3, 1.3, ATLAS.blob[0], ATLAS.blob[1], r, gC, b);
  });
}

// ------------------------------------------------------------------ kart (handling ported from Mario Kart 3.js)
const NO_INPUT = { s: 0, g: 0, b: 0, n: 0, i: 0 };    // n = HOP / DRIFT button
class Car {
  constructor({ name, cfg, human, player }) {
    const k = sanitizeKart(cfg);
    const racer = k.racer, R = RACERS[racer];
    this.cfg = k; this.racer = racer; this.name = name; this.color = kartColor(k); this.human = human; this.player = player;
    this.phys = kartPhys(k); this.carName = `${R.name} · ${BODIES[k.body].name}`;
    const body = parts.body[k.body], wh = parts.wheels[k.wheels];
    this.tpl = { pivot: PIVOT, rearZ: body.rearZ * KART_SCALE };
    this.group = new THREE.Group();
    // baked-texture kart with steering front wheels, a turning steering wheel and suspension (kartlook.js)
    this.model = new KartModel({ body, steer: parts.steer, wheels: wh, driver: parts.driver[racer], lift: wh.lift, color: this.color, outline: OUTLINE });
    this.paintMat = this.model.paintMat; this.rearR = wh.rearR || 0.38;
    this.driver = this.model.driver;
    this.kart = this.model.group; this.kart.scale.setScalar(KART_SCALE);
    this.group.add(this.kart);
    scene.add(this.group);
    this.tag = human ? makeNameTag(name, this.color) : null;
    if (this.tag) scene.add(this.tag);

    this.input = NO_INPUT; this._ai = { s: 0, g: 0, b: 0, n: 0, i: 0 };
    this.x = 0; this.z = 0; this.h = 0; this.vx = 0; this.vz = 0; this.steer = 0; this.rot = 0; this.spin = 0;
    this.nitro = 0; this.boosting = false; this.speedMul = 1; this.yaw = 0; this.accel = 0; this.boostFx = false; this.roll = 0; this.pitch = 0;
    this.ti = -1; this.s = 0; this.d = 0; this.u = 0; this.prevS = 0; this.finished = false; this.finishTime = 0; this.place = 1;
    this.stuck = 0; this.wrongWay = 0; this.lane = (Math.random() - 0.5) * 8; this.hitCool = 0; this.blink = 0;
    this.coins = 0; this.item = null; this.itemN = 0; this.itemRoll = 0; this.prevI = 0; this.prevN = 0; this.aiItemT = 0;
    this.padT = 0; this.rocketT = 0; this.starT = 0; this.magnetT = 0; this.onPad = false; this.lapFlash = 0; this.wrongSent = false;
    this.hopT = 0; this.hopWin = 0; this.drift = 0; this.driftPow = 0; this.driftTier = 0; this.driftVis = 0; this.turboT = 0; this.stunT = 0;
    this.spinT = 0; this.spinA = 0; this.invT = 0; this.draftT = 0; this.draftCharge = 0; this.hornT = 0; this.offroad = false; this.dustT = 0;
    this.cheerT = 0; this.dizzyT = 0; this.passT = 0;
    this.ahead = null; this.aheadGap = 1e9; this.behindGap = 1e9; this.gasEarly = false; this.gasOnOne = false; this.aiDrift = 0;
  }
  get speed() { return Math.hypot(this.vx, this.vz); }
  get forwardSpeed() { return this.vx * Math.sin(this.h) + this.vz * Math.cos(this.h); }
  get lap() { return clamp(Math.floor(this.u / track.L) + 1, 1, LAPS); }
  get safe() { return this.starT > 0 || this.rocketT > 0 || this.invT > 0; }
  placeAt(s, lateral) {
    const p = track.at(s, lateral);
    this.x = p.x; this.z = p.z; this.h = p.h; this.vx = this.vz = 0;
    const loc = track.locate(this.x, this.z); this.ti = loc.i; this.s = this.prevS = loc.s; this.d = loc.d;
  }
  dispose() {
    scene.remove(this.group); this.model.dispose();
    if (this.tag) { scene.remove(this.tag); this.tag.material.map.dispose(); this.tag.material.dispose(); }
  }
  fx(k, v) { if (this.player) sendPad(this.player.id, { t: 'fx', k, v }); }

  aiInput() {
    const sp = this.speed, o = this._ai;
    const look = track.at(this.s + 8 + sp * 0.45, clamp(this.lane, -track.halfAt(this.s) + 3, track.halfAt(this.s) - 3));
    const diff = wrapA(Math.atan2(look.x - this.x, look.z - this.z) - this.h);
    const turn = wrapA(track.heading(this.s + 40) - track.heading(this.s + 8));
    if (Math.random() < 0.006) this.lane = (Math.random() - 0.5) * 10;
    // bots drift through the bigger corners (and earn mini-turbos), like the CPU racers in Mario Kart
    if (!this.drift && !this.aiDrift && Math.abs(turn) > 0.55 && sp > 16 && Math.random() < LV().drift) { this.aiDrift = 1; this.aiDriftDir = turn > 0 ? -1 : 1; }
    if (this.aiDrift && ((this.drift && Math.abs(turn) < 0.2) || (!this.drift && this.hopWin <= 0 && this.hopT < -0.1))) this.aiDrift = 0;
    let i = 0;
    if (this.item && this.itemRoll <= 0) {
      this.aiItemT += 1 / 60;
      const it = this.item;
      if (this.aiItemT > 1.2 / LV().itemUse) {
        if (it === 'banana') i = this.behindGap < 18 || Math.random() < 0.004 ? 1 : 0;
        else if (it === 'green') i = this.aheadGap < 30 && Math.random() < 0.05 ? 1 : 0;
        else if (it === 'red') i = this.aheadGap < 70 ? 1 : 0;
        else if (it === 'horn') i = this.aheadGap < 7 || this.behindGap < 7 ? 1 : 0;
        else i = (it === 'coin' || Math.abs(turn) < 0.15) && Math.random() < 0.03 ? 1 : 0;
      }
    }
    o.s = clamp(-diff * 2.4, -1, 1);
    if (this.aiDrift && !this.drift) o.s = this.aiDriftDir;              // hop into the corner
    else if (this.drift) o.s = clamp(o.s * 0.6 + this.drift * 0.6, -1, 1);
    o.g = 1; o.b = Math.abs(turn) > 1.2 && sp > 24 && !this.drift ? 1 : 0;
    o.n = this.aiDrift; o.i = i;
    return o;
  }

  step(dt, inp, assist) {
    const P = this.phys;
    let sinH = Math.sin(this.h), cosH = Math.cos(this.h);
    let vf = this.vx * sinH + this.vz * cosH;
    let vr = this.vx * -cosH + this.vz * sinH;
    const v0 = vf;
    if (inp.i && !this.prevI && this.item && this.itemRoll <= 0) this.useItem();
    this.prevI = inp.i ? 1 : 0;
    if (this.itemRoll > 0) { this.itemRoll -= dt; if (this.itemRoll <= 0) { this.fx('item', this.item); if (this.human) sound.play('itemget', 0.6); } }
    this.padT -= dt; this.rocketT -= dt; this.starT -= dt; this.turboT -= dt; this.draftT -= dt; this.invT -= dt; this.hornT -= dt; this.stunT -= dt; this.hopT -= dt; this.hopWin -= dt;
    const bullet = this.rocketT > 0, spun = this.spinT > 0;
    if (spun) this.spinT -= dt;
    let sIn = spun ? 0 : inp.s;
    if (bullet) sIn = this.aiInput().s;            // the bullet drives itself
    const hopHeld = !spun && !bullet && inp.n;
    // holding HOP/DRIFT also accelerates: on a phone one thumb can't hold GO and DRIFT at the same time
    const gas = spun || this.stunT > 0 ? 0 : bullet ? 1 : (inp.g || hopHeld ? 1 : 0);
    const rev = !spun && !gas && inp.b;

    // ---- hop → drift (Mario Kart 3.js: the drift direction is the stick direction at the hop)
    if (hopHeld && !this.prevN && this.hopT <= -0.05) {
      this.hopT = 0.25; this.hopWin = 0.3;
      if (this.human) sound.sfx('hop', () => sound.hop(), 0.6, 0.95 + Math.random() * 0.1);
    }
    this.prevN = hopHeld ? 1 : 0;
    if (!this.drift && hopHeld && this.hopWin > 0 && Math.abs(sIn) > 0.3 && vf > 12) { this.drift = Math.sign(sIn); this.driftPow = 0; this.driftTier = 0; }
    if (this.drift) {
      if (!hopHeld || vf < 9) {
        if (this.driftTier > 0 && !spun) {
          this.turboT = TURBO[this.driftTier]; this.fx('turbo', this.driftTier);
          if (this.human) { sound.sfx('turbo', () => sound.whoosh(), 0.6 + this.driftTier * 0.15, 0.9 + this.driftTier * 0.08); if (this.driftTier === 3) { sound.voice(this.racer, 'turbo'); this.cheerT = 1.2; } }
        }
        this.drift = 0; this.driftTier = 0; this.driftPow = 0;
      } else {
        this.driftPow += dt * (0.85 + 0.45 * clamp(sIn * this.drift, 0, 1));   // steering into the drift charges faster
        const tier = this.driftPow >= DRIFT_AT[3] ? 3 : this.driftPow >= DRIFT_AT[2] ? 2 : this.driftPow >= DRIFT_AT[1] ? 1 : 0;
        if (tier > this.driftTier) { this.driftTier = tier; this.fx('spark', tier); if (this.human) sound.sfx(tier === 3 ? 'spark3' : 'spark1', () => sound.beep(500 + tier * 250, 0.06, 0.08, 'square'), 0.55, tier === 2 ? 1.25 : 1); }
      }
    }

    // ---- speed (Mario Kart 3.js: damp towards the target speed)
    const half = track.halfAt(this.s);
    const boost = this.turboT > 0 || this.padT > 0 || this.draftT > 0;
    this.offroad = Math.abs(this.d) > half + 0.5 && this.starT <= 0 && !bullet && !boost;
    let maxV = P.maxV * this.speedMul * (1 + 0.012 * this.coins);
    if (boost) maxV *= 1.4;
    if (bullet) maxV = P.maxV * 1.55;
    if (this.starT > 0) maxV *= 1.12;
    if (this.offroad) maxV *= this.human ? 1 - (1 - P.offroad) * LV().offroad : P.offroad;   // big wheels lose less on sand
    this.boostFx = boost || bullet;
    const target = gas ? maxV : rev ? -10 : 0;
    let rate = gas ? (boost || bullet ? 4 : 1.5 * P.acc / 1.6) : rev ? 2.5 : 0.7;
    if (vf > maxV) rate = this.offroad ? 2.5 : 1.2;
    if (spun) rate = 2.6;
    vf += (target - vf) * (1 - Math.exp(-rate * dt));
    this.accel = (vf - v0) / dt;

    // ---- steering (Mario Kart 3.js: yaw rate from the stick plus a ±1.4 drift bias, scaled by speed)
    this.steer += (sIn - this.steer) * Math.min(1, dt * (this.human ? 9 : 10));
    const cmd = this.drift ? (this.steer + 1.4 * this.drift) / 1.7 : this.steer;
    const spF = clamp(vf / 8, -1, 1) * (1.35 - 0.35 * clamp(vf / P.maxV, 0, 1));
    const wantRot = cmd * 1.35 * P.turn * spF;
    this.rot += (wantRot - this.rot) * (1 - Math.exp(-6 * dt));
    this.yaw = -this.rot;
    const vx = sinH * vf - cosH * vr, vz = cosH * vf + sinH * vr;
    this.h -= this.rot * dt;
    // smart steering for kids: with the stick centred, gently line up with the road and steer back off the sand
    if (assist && Math.abs(sIn) < 0.12 && !this.drift && vf > 3 && !bullet) {
      const want = track.heading(this.s + 6) + clamp(this.d / Math.max(4, half) * 0.35, -0.35, 0.35);
      const dh = wrapA(want - this.h);
      if (Math.abs(dh) < 1.0) this.h += dh * Math.min(1, dt * 1.3 * LV().assist);
    }
    sinH = Math.sin(this.h); cosH = Math.cos(this.h);
    vf = vx * sinH + vz * cosH; vr = vx * -cosH + vz * sinH;
    vr *= Math.exp(-(this.drift ? 2.4 : 9) * dt);    // drifting = the kart slides outwards
    this.vx = sinH * vf - cosH * vr; this.vz = cosH * vf + sinH * vr;
    this.x += this.vx * dt; this.z += this.vz * dt;

    const loc = track.locate(this.x, this.z, this.ti);
    this.ti = loc.i; this.d = loc.d;
    let ds = loc.s - this.prevS;
    if (ds < -track.L / 2) ds += track.L; else if (ds > track.L / 2) ds -= track.L;
    this.u += ds; this.prevS = this.s = loc.s;

    // ---- walls (per sample, left and right): bounce back like Mario Kart 3.js, but gently
    const wall = (loc.d >= 0 ? track.wallR[loc.i] : track.wallL[loc.i]) - 1.3;
    this.hitCool -= dt;
    if (Math.abs(loc.d) > wall) {
      const sg = Math.sign(loc.d), push = loc.d - sg * wall;
      this.x -= loc.Rx * push; this.z -= loc.Rz * push;
      const vn = this.vx * loc.Rx + this.vz * loc.Rz;
      if (vn * sg > 0) {
        this.vx -= loc.Rx * vn * 1.5; this.vz -= loc.Rz * vn * 1.5;
        const hard = Math.abs(vn) > 9;
        let loss = this.starT > 0 ? 1 : hard ? 0.55 : 1 - 0.25 * Math.min(1, Math.abs(vn) / 14);
        const soft = this.human && LV().wallLoss < 1;   // Easy: softer walls
        if (this.human) loss = 1 - (1 - loss) * LV().wallLoss;
        this.vx *= loss; this.vz *= loss;
        if (hard && this.starT <= 0 && !soft) { this.stunT = 0.3; this.drift = 0; this.driftTier = 0; }
        if (Math.abs(vn) > 2.5) {
          emitSparks(this.x + loc.Rx * sg, 0.5, this.z + loc.Rz * sg, -loc.Rx * sg, -loc.Rz * sg, Math.min(20, Math.abs(vn) * 2) | 0);
          if (this.hitCool <= 0) { this.hitCool = 0.4; this.onHit(Math.abs(vn), true); }
        }
        const dh = wrapA(Math.atan2(loc.tx, loc.tz) - this.h);
        if (Math.abs(dh) < 1.3) this.h += dh * 0.15;
      }
    }
    if (Math.abs(loc.d) > wall - 0.05 && this.speed > 4 && this.hitCool <= 0) { this.hitCool = 0.35; this.fx('wall', 1); this.model.bump(0.7); }
    const along = Math.sin(this.h) * loc.tx + Math.cos(this.h) * loc.tz;
    this.wrongWay = along < -0.35 && this.speed > 4 ? this.wrongWay + dt : Math.max(0, this.wrongWay - dt * 2);
    this.stuck = gas && !spun && this.speed < 1.5 ? this.stuck + dt : 0;
    if (this.stuck > 2.5 || this.wrongWay > 4) this.respawn(this.s - 6, clamp(this.d, -half + 2, half - 2));
  }

  onHit(power, wall = false) {
    this.fx(wall ? 'wall' : 'bump', Math.round(power));
    if (this.human) { camShake = Math.max(camShake, Math.min(0.45, power * 0.03)); this.shake = Math.max(this.shake || 0, Math.min(0.45, power * 0.03)); sound.sfx(wall ? 'wall' : 'bump', () => sound.thud(power), Math.min(1, 0.3 + power * 0.05)); }
  }

  // hit by a banana / shell / horn / star / bullet: spin around, drop coins, then a moment of safety
  spinOut(by) {
    if (this.safe) return false;
    this.spinT = 1.0; this.invT = 2.5; this.blink = 0; this.drift = 0; this.driftTier = 0; this.turboT = 0;
    const lost = Math.min(3, this.coins); this.coins -= lost;
    emitSparks(this.x, 1, this.z, 0, 0, 10 + lost * 4);
    this.fx('spin', lost);
    this.dizzyT = 2.2;
    if (this.human || (by && by.human)) sound.sfx('slip', () => sound.thud(14), 0.8);
    if (this.human) { this.shake = 0.35; camShake = Math.max(camShake, 0.3); sound.voice(this.racer, 'hit'); }
    if (by && by !== this) { by.fx('hitOther', this.name); if (by.human) { setTimeout(() => sound.voice(by.racer, 'gotcha'), 700); by.cheerT = 1.0; } }
    return true;
  }

  useItem() {
    const it = this.item; this.aiItemT = 0;
    this.itemN = Math.max(0, (this.itemN || 1) - 1);
    if (!this.itemN) this.item = null;
    if (it === 'mushroom') { this.turboT = Math.max(this.turboT, 1.2); if (this.human) sound.sfx('mushroom', () => sound.whoosh(), 0.8); }
    if (it === 'star') this.starT = 7;
    if (it === 'bullet') this.rocketT = 3;
    if (it === 'coin') this.coins = Math.min(MAX_COINS, this.coins + 2);
    if (it === 'banana') projectiles.drop(this);
    if (it === 'green') projectiles.fire(this, false);
    if (it === 'red') projectiles.fire(this, true);
    if (it === 'horn') hornBlast(this);
    if (this.human) {
      showMsg(`${this.name}: ${ITEM_NAMES[it]}`, this.color);
      const s = { banana: 'banana', green: 'throw', red: 'throw', star: 'star', bullet: 'bullet', coin: 'coin' }[it];
      if (s) sound.sfx(s, () => sound.beep(it === 'star' ? 1046 : 784, 0.25, 0.2, 'triangle'), 0.8);
      if (it === 'star') sound.voice(this.racer, 'star'); else if (it === 'green' || it === 'red' || it === 'banana') sound.voice(this.racer, 'item');
    }
    this.fx('use', it);
  }

  respawn(s, lat) {
    const p = track.at(s, lat);
    this.x = p.x; this.z = p.z; this.h = p.h; this.vx = this.vz = 0; this.stuck = 0; this.wrongWay = 0; this.blink = 1.5; this.drift = 0;
    const loc = track.locate(this.x, this.z, -1); this.ti = loc.i;
    let ds = loc.s - this.prevS; ds -= Math.round(ds / track.L) * track.L;
    this.u += ds; this.prevS = this.s = loc.s;
  }

  sync(dt, t) {
    const g = this.group;
    const vf = this.forwardSpeed;
    this.roll += (clamp(this.yaw * vf * 0.003, -0.08, 0.08) - this.roll) * 0.15;
    this.pitch += (clamp(-this.accel * 0.003, -0.05, 0.05) - this.pitch) * 0.1;
    // the body swings out during a drift (Mario Kart 3.js: driftDirection × 0.4) and hops
    this.driftVis += ((this.drift ? this.drift * 0.42 : this.steer * 0.06) - this.driftVis) * Math.min(1, dt * 7);
    if (this.spinT > 0) this.spinA = (1 - this.spinT / 1.0) * Math.PI * 4; else this.spinA = 0;
    const hopY = this.hopT > 0 ? Math.sin((1 - this.hopT / 0.25) * Math.PI) * 0.55 : 0;
    g.position.set(this.x, hopY + (this.offroad ? Math.sin(t * 40) * 0.03 : 0), this.z);
    g.rotation.set(this.pitch, this.h - this.driftVis + this.spinA, this.roll, 'YXZ');
    if (this.starT > 0) g.scale.setScalar(1.08); else if (this.rocketT > 0) g.scale.setScalar(1.15); else g.scale.setScalar(1);
    // the driver leans into turns and looks where they're going
    if (this.cheerT > 0) this.cheerT -= dt;
    if (this.dizzyT > 0) this.dizzyT -= dt;
    if (this.cheerT > 0) {   // happy bounce, arms-up wiggle
      const k = Math.abs(Math.sin(t * 14));
      this.driver.position.y = this.tpl.pivot.y + k * 0.22; this.driver.rotation.set(-0.15, Math.sin(t * 9) * 0.25, Math.sin(t * 14) * 0.18);
    } else if (this.dizzyT > 0) {
      this.driver.position.y = this.tpl.pivot.y; this.driver.rotation.set(Math.sin(t * 7) * 0.15, Math.sin(t * 5) * 0.3, Math.cos(t * 7) * 0.2);
    } else {
      this.driver.position.y = this.tpl.pivot.y;
      this.driver.rotation.set(0, -this.steer * 0.25, -this.steer * 0.16);
    }
    this.spin -= (vf / 0.4) * dt;
    if (this._hopWas > 0 && this.hopT <= 0) this.model.bump(0.9);   // landing from a hop squashes the suspension
    this._hopWas = this.hopT;
    this.model.update(dt, this.steer, vf, this.rearR);
    if (this.starT > 0) this.paintMat.color.setHSL((t * 1.6 + 0.5) % 1, 1, 0.6);
    else if (this._wasStar) this.paintMat.color.set(this.color);
    this._wasStar = this.starT > 0;
    if (this.blink > 0) { this.blink -= dt; g.visible = Math.floor(this.blink * 10) % 2 === 0; }
    else g.visible = !(this.invT > 0 && this.spinT <= 0 && Math.floor(this.invT * 12) % 3 === 0);
    if (this.hidden) g.visible = false;
    if (this.liftY) g.position.y += this.liftY;
    if (this.tag) this.tag.position.set(this.x, 3.4, this.z);
  }

  drawFx(t) {
    if (!this.group.visible) return;
    const x = this.x, z = this.z, h = this.h, s = Math.sin(h), c = Math.cos(h);
    fx.shadow.ground(x, 0.05, z, h, 1.25 * KART_SCALE, 1.75 * KART_SCALE, 0, 1, 1, 1, 1);
    const rz = this.tpl.rearZ;
    const hv = h - this.driftVis, sv = Math.sin(hv), cv = Math.cos(hv);
    // drift sparks at the back wheels (white while charging, then blue → orange → purple)
    if (this.drift) {
      const [r, gC, b] = TIER_COL[this.driftTier], k = this.driftTier ? 1 : 0.4, fl = 0.7 + Math.random() * 0.5;
      const wz = rz - 0.05, sz = (0.45 + 0.2 * this.driftTier) * fl;
      for (const side of [-1, 1]) {
        const px = x + sv * wz + cv * side * 1.05, pz = z + cv * wz - sv * side * 1.05;
        fx.glow.upright(px, 0.35, pz, h, sz, sz * 0.8, ATLAS.blob[0], ATLAS.blob[1], r * k, gC * k, b * k);
      }
      if (this.driftTier && Math.random() < 0.35) sparks.emit(x + sv * wz, 0.3, z + cv * wz, -sv, -cv, 1);
    }
    // turbo flames out of the exhausts
    if (this.boostFx) {
      const tc = this.rocketT > 0 ? [1, 0.55, 0.15] : this.turboT > 0 && this.padT <= 0 ? [1, 0.5, 0.15] : [0.4, 0.75, 1];
      for (const side of [-1, 1]) {
        const ex = 0.3 * side, ez = rz - 0.35, fl = 0.5 + Math.random() * 0.35;
        fx.glow.upright(x + sv * ez + cv * ex, 0.95, z + cv * ez - sv * ex, h, 0.32 + fl * 0.25, 0.28, ATLAS.blob[0], ATLAS.blob[1], tc[0], tc[1], tc[2]);
      }
    }
    // sand: dust puffs behind the wheels
    if (this.offroad && this.speed > 5 && (this.dustT -= 1 / 60) <= 0) {
      this.dustT = 0.05;
      fx.puffs.add(x + sv * (rz + 0.2) + (Math.random() - 0.5) * 2, z + cv * (rz + 0.2) + (Math.random() - 0.5) * 2, 0.86, 0.74, 0.52);
    }
    if (this.starT > 0) { const cc = tmpColor.setHSL((t * 1.5) % 1, 1, 0.5); fx.glow.ground(x, 0.09, z, h, 2.6, 3.4, ATLAS.blob[0], ATLAS.blob[1], cc.r * 0.6, cc.g * 0.6, cc.b * 0.6); }
    if (this.draftCharge > 0.15 || this.draftT > 0) {
      for (let k2 = 0; k2 < 3; k2++) {
        const side = (k2 - 1) * 1.6, fwd = 2 + ((t * 18 + k2 * 2.7) % 6);
        fx.glow.ground(x + s * fwd + c * side, 0.7 + k2 * 0.35, z + c * fwd - s * side, h, 0.04, 1.4, ATLAS.soft[0], ATLAS.soft[1], 0.5, 0.55, 0.6);
      }
    }
    if (this.dizzyT > 0) {   // dizzy stars circling the driver's head
      for (let k2 = 0; k2 < 3; k2++) {
        const a = t * 6 + k2 * 2.09, r = 0.75;
        fx.glow.upright(x + Math.cos(a) * r, 2.9 * KART_SCALE * 0.82 + Math.sin(t * 9 + k2) * 0.08, z + Math.sin(a) * r, camYawNow, 0.28, 0.28, ATLAS.blob[0], ATLAS.blob[1], 1, 0.9, 0.3);
      }
    }
    if (this.hornT > 0) { const rr = 2 + (0.5 - this.hornT) * 18, a = this.hornT * 1.6; fx.glow.ground(x, 0.1, z, 0, rr, rr, ATLAS.ring[0], ATLAS.ring[1], a, a * 0.85, a * 0.3); }
  }
}
const tmpColor = new THREE.Color();

// dust / smoke puffs: normal blending (additive would glow on bright sand), short-lived, one draw
class Puffs {
  constructor(n) {
    this.list = Array.from({ length: n }, () => ({ x: 0, z: 0, t: 0, r: 0, g: 0, b: 0 })); this.head = 0;
    this.batch = new QuadBatch(n, new THREE.MeshBasicMaterial({ map: radialTex, transparent: true, depthWrite: false }));
    this.batch.mesh.renderOrder = 2;
  }
  add(x, z, r, g, b) { const p = this.list[this.head]; this.head = (this.head + 1) % this.list.length; p.x = x; p.z = z; p.t = 0.55; p.r = r; p.g = g; p.b = b; }
  update(dt) {
    this.batch.begin();
    for (const p of this.list) {
      if (p.t <= 0) continue;
      p.t -= dt;
      const k = 1 - p.t / 0.55, sz = 0.6 + k * 1.6;
      this.batch.upright(p.x, 0.5 + k * 1.2, p.z, camYawNow, sz, sz, 0, 1, p.r, p.g, p.b);
    }
    this.batch.end();
  }
}
let camYawNow = 0;

function makeNameTag(name, color) {
  const tex = canvasTex(256, 64, (g, w, h) => {
    g.font = '800 30px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    const tw = Math.min(w - 8, g.measureText(name).width + 28);
    g.fillStyle = 'rgba(10,8,24,0.75)'; g.beginPath(); g.roundRect((w - tw) / 2, 4, tw, 40, 12); g.fill();
    g.lineWidth = 4; g.strokeStyle = color; g.stroke();
    g.fillStyle = '#fff'; g.fillText(name, w / 2, 25);
    g.fillStyle = color; g.beginPath(); g.moveTo(w / 2 - 10, 46); g.lineTo(w / 2 + 10, 46); g.lineTo(w / 2, 60); g.closePath(); g.fill();
  });
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, depthWrite: false, fog: false, transparent: true }));
  s.renderOrder = 10; s.center.set(0.5, 0); s.scale.set(4, 1, 1);
  return s;
}

// ------------------------------------------------------------------ audio
class Sound {
  constructor() { this.ctx = null; this.engines = new Map(); }
  // Sound is on by default: the AudioContext is created at boot. Browsers let it play straight away when the page was
  // opened by a click/OK on the same site (the start screen), or once the site is trusted; otherwise it waits for the
  // first key or tap, which then also does its normal job (no extra OK press just for sound).
  start() {
    if (this.ctx) { if (this.ctx.state !== 'running') this.ctx.resume().catch(() => {}); return; }
    try {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain(); this.master.gain.value = 0.7;
      this.master.connect(this.ctx.destination);
      this.sfxBus = this.ctx.createGain(); this.sfxBus.gain.value = 0.8; this.sfxBus.connect(this.master);
      this.voiceBus = this.ctx.createGain(); this.voiceBus.gain.value = 1.0; this.voiceBus.connect(this.master);
      this.prefetch().then(() => this._decodeAll()); this._decodeAll();
      const hint = () => {
        $('sound').classList.toggle('hidden', this.ctx.state === 'running' || phase === 'loading');
        if (this.ctx.state === 'running' && this._wantMusic && !this.musicSrc) this._startSampleMusic();
        if (this.ctx.state === 'running' && !this._welcomed && phase === 'lobby') { this._welcomed = true; setTimeout(() => this.announce('a_welcome'), 600); }
      };
      this.ctx.onstatechange = hint;
      if (this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
      setTimeout(hint, 300);
    } catch { this.ctx = null; }
  }
  get ok() { return this.ctx && this.ctx.state === 'running'; }

  // ---- ElevenLabs sound effects, voices and music (public/sunny/audio, made by tools/gen_sunny_audio.py).
  // Files are fetched at boot and decoded once the AudioContext exists; anything missing falls back to the synth sounds.
  prefetch() {
    if (this._pre) return this._pre;
    this.buf = {}; this.raw = {};
    this._pre = fetch('/sunny/audio/manifest.json').then((r) => r.ok ? r.json() : {}).then((man) => {
      this.manifest = man;
      return Promise.all(Object.keys(man).map((n) => fetch(`/sunny/audio/${n}.mp3`).then((r) => r.arrayBuffer()).then((ab) => { this.raw[n] = ab; this._decode(n); }).catch(() => {})));
    }).catch(() => {});
    return this._pre;
  }
  _decode(n) {
    if (!this.ctx || !this.raw[n] || this.buf[n]) return;
    const ab = this.raw[n]; this.raw[n] = null;
    this.ctx.decodeAudioData(ab, (b) => {
      this.buf[n] = b;
      if (n === this._wantMusic) this._startSampleMusic();
      if (n === 'a_welcome' && this.ok && !this._welcomed && phase === 'lobby') { this._welcomed = true; this.announce('a_welcome'); }
    }, () => {});
  }
  _decodeAll() { if (this.raw) for (const n of Object.keys(this.raw)) this._decode(n); }
  // play a sample; returns the source node, or null when it isn't available (caller can fall back to a synth sound)
  play(name, vol = 1, rate = 1, dest = null) {
    const b = this.buf && this.buf[name];
    if (!this.ok || !b) return null;
    const s = this.ctx.createBufferSource(), g = this.ctx.createGain();
    s.buffer = b; s.playbackRate.value = rate; g.gain.value = vol;
    s.connect(g); g.connect(dest || this.sfxBus || this.master); s.start();
    return s;
  }
  sfx(name, fallback, vol = 1, rate = 1) { if (!this.play(name, vol, rate) && fallback) fallback(); }
  // character voices: at most one line every ~1.6 s overall and 4 s per racer, so it stays fun rather than noisy
  voice(racer, key, force = false) {
    if (!this.ok) return;
    const now = this.ctx.currentTime;
    this._vT = this._vT || {};
    if (!force && (now < (this._vAny || 0) || now < (this._vT[racer] || 0))) return;
    const name = racer === 'announcer' ? key : `v_${racer}_${key}`;
    if (!this.buf || !this.buf[name]) return;
    if (this._vSrc && force) { try { this._vSrc.stop(); } catch {} }
    this._vSrc = this.play(name, racer === 'announcer' ? 1.0 : 0.95, 1, this.voiceBus);
    this._vAny = now + Math.max(1.0, this.buf[name].duration * 0.9 + 0.5); this._vT[racer] = now + 4;
    // duck the music under voices
    if (this.musicGain) { const g = this.musicGain.gain; g.cancelScheduledValues(now); g.setTargetAtTime(this.musicVol * 0.45, now, 0.05); g.setTargetAtTime(this.musicVol, now + this.buf[name].duration, 0.3); }
  }
  announce(key) { this.voice('announcer', key, true); }
  beep(freq, dur = 0.18, vol = 0.25, type = 'square') {
    if (!this.ok) return;
    const o = this.ctx.createOscillator(), g = this.ctx.createGain(), t = this.ctx.currentTime;
    o.type = type; o.frequency.value = freq; g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(this.master); o.start(t); o.stop(t + dur);
  }
  coin() { this.beep(1318, 0.07, 0.1, 'sine'); setTimeout(() => this.beep(1760, 0.1, 0.1, 'sine'), 60); }
  noise(len, gain, f0, f1, type = 'lowpass') {
    if (!this.ok) return;
    if (!this._nb) { const b = this.ctx.createBuffer(1, this.ctx.sampleRate * 0.6, this.ctx.sampleRate), d = b.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; this._nb = b; }
    const s = this.ctx.createBufferSource(), f = this.ctx.createBiquadFilter(), g = this.ctx.createGain(), t = this.ctx.currentTime;
    s.buffer = this._nb; f.type = type; f.frequency.setValueAtTime(f0, t); f.frequency.exponentialRampToValueAtTime(f1, t + len);
    g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.001, t + len);
    s.connect(f); f.connect(g); g.connect(this.master); s.start(t); s.stop(t + len);
  }
  thud(power) { this.noise(0.22, Math.min(0.5, power * 0.03), 900, 200); }
  hop() { if (!this.ok) return; const o = this.ctx.createOscillator(), g = this.ctx.createGain(), t = this.ctx.currentTime; o.type = 'square'; o.frequency.setValueAtTime(330, t); o.frequency.exponentialRampToValueAtTime(660, t + 0.09); g.gain.setValueAtTime(0.08, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.12); o.connect(g); g.connect(this.master); o.start(t); o.stop(t + 0.13); }
  whoosh() { this.noise(0.5, 0.35, 400, 3000, 'bandpass'); }
  engine(car) {
    if (!this.ok) return;
    let e = this.engines.get(car);
    const hasS = this.buf && this.buf.engine;
    if (!e) {
      const loop = (name, vol) => {
        const s = this.ctx.createBufferSource(), g = this.ctx.createGain();
        s.buffer = this.buf[name]; s.loop = true; g.gain.value = vol; s.connect(g); g.connect(this.sfxBus); s.start();
        return { s, g };
      };
      if (hasS) {
        e = { sample: true, eng: loop('engine', 0) };
        if (this.buf.skid) e.skid = loop('skid', 0);
        if (this.buf.offroad) e.off = loop('offroad', 0);
      } else {
        const o1 = this.ctx.createOscillator(), f = this.ctx.createBiquadFilter(), g = this.ctx.createGain();
        o1.type = 'sawtooth'; f.type = 'lowpass'; f.frequency.value = 600; g.gain.value = 0;
        o1.connect(f); f.connect(g); g.connect(this.master); o1.start();
        e = { o1, f, g };
      }
      this.engines.set(car, e);
    }
    const sp = car.speed, t = this.ctx.currentTime, share = 1 / Math.max(1, humanCars().length * 0.7);
    if (e.sample) {
      e.eng.s.playbackRate.setTargetAtTime(0.75 + Math.min(sp, 45) / 38 + (car.boostFx ? 0.18 : 0), t, 0.08);
      e.eng.g.gain.setTargetAtTime((0.22 + (car.input.g ? 0.12 : 0)) * share, t, 0.1);
      if (e.skid) e.skid.g.gain.setTargetAtTime(car.drift && car.hopT <= 0 ? 0.35 * share : 0, t, 0.05);
      if (e.off) e.off.g.gain.setTargetAtTime(car.offroad && sp > 4 ? 0.4 * share : 0, t, 0.08);
      return;
    }
    const gear = sp / 11, frac = gear - Math.floor(gear);
    const base = 45 + Math.min(4, Math.floor(gear)) * 6 + frac * 55 + (car.boostFx ? 25 : 0);
    e.o1.frequency.setTargetAtTime(base, t, 0.06);
    e.f.frequency.setTargetAtTime(400 + sp * 25 + (car.input.g ? 500 : 0), t, 0.1);
    e.g.gain.setTargetAtTime((0.03 + (car.input.g ? 0.03 : 0)) * share, t, 0.12);
  }
  stopEngines() {
    for (const e of this.engines.values()) {
      if (e.sample) for (const l of [e.eng, e.skid, e.off]) { if (l) { try { l.s.stop(); } catch {} } }
      else { e.g.gain.value = 0; e.o1.stop(); }
    }
    this.engines.clear();
  }

  // ---- music: the ElevenLabs track when it's loaded (final lap = played faster and higher, like Mario Kart),
  //      otherwise the procedural chiptune below
  _startSampleMusic() {
    const name = this._wantMusic; if (!name || !this.ok || !this.buf[name] || this.musicSrc) return false;
    this.stopProcMusic();
    const s = this.ctx.createBufferSource(), g = this.ctx.createGain();
    this.musicVol = name === 'music_menu' ? 0.28 : 0.38;
    s.buffer = this.buf[name]; s.loop = true; g.gain.value = 0; g.gain.setTargetAtTime(this.musicVol, this.ctx.currentTime, 0.3);
    s.connect(g); g.connect(this.master); s.start();
    this.musicSrc = s; this.musicGain = g; this.musicName = name;
    return true;
  }
  music(name) {   // 'music_race' | 'music_menu' | null
    if (Q.get('music') === '0') return;
    if (this.musicName === name && this.musicSrc) return;
    this.stopMusic();
    this._wantMusic = name;
    if (!name || !this.ok) return;
    if (!this._startSampleMusic() && name === 'music_race' && !(this.buf && this.manifest && this.manifest.music_race)) this.startProcMusic();
  }
  startMusic() { this.music('music_race'); }
  stopMusic() {
    if (this.musicSrc) { const s = this.musicSrc, g = this.musicGain; try { g.gain.setTargetAtTime(0, this.ctx.currentTime, 0.08); setTimeout(() => { try { s.stop(); } catch {} }, 400); } catch {} }
    this.musicSrc = null; this.musicGain = null; this.musicName = null; this._wantMusic = null;
    this.stopProcMusic();
  }
  // ---- procedural race music (no files): bass + arpeggio + drums, A minor, speeds up on the final lap
  startProcMusic() {
    if (!this.ok || this.procMusic || Q.get('music') === '0') return;
    const ctx = this.ctx, out = ctx.createGain(); out.gain.value = 0.14; out.connect(this.master);
    this.procMusic = { out, step: 0, next: ctx.currentTime + 0.1, tempo: 136, timer: 0 };
    const CH = [[60, 64, 67], [65, 69, 72], [67, 71, 74], [60, 64, 67]];   // C F G C (MIDI): bouncy, major key
    const LEAD = [72, 0, 76, 79, 0, 76, 72, 0, 74, 0, 77, 0, 76, 74, 72, 0];
    const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);
    const note = (f, t, d, type, v, dest) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = type; o.frequency.value = f; g.gain.setValueAtTime(v, t); g.gain.exponentialRampToValueAtTime(0.001, t + d);
      o.connect(g); g.connect(dest); o.start(t); o.stop(t + d + 0.02);
    };
    const tick = () => {
      const m = this.procMusic; if (!m) return;
      while (m.next < ctx.currentTime + 0.25) {
        const sixteenth = 60 / m.tempo / 4, st = m.step % 16, bar = Math.floor(m.step / 16) % 4, ch = CH[bar], t = m.next;
        if (st % 2 === 0) note(hz(ch[0] - 24), t, sixteenth * 1.8, 'square', 0.22, m.out);              // bass 8ths
        note(hz(ch[st % 3] + 12), t, sixteenth * 0.9, 'triangle', 0.1, m.out);                           // arpeggio 16ths
        if (bar % 2 === 1 && LEAD[st]) note(hz(LEAD[st] - (bar === 3 ? 2 : 0)), t, sixteenth * 1.7, 'square', 0.06, m.out);
        if (st % 4 === 0) { const o = ctx.createOscillator(), g = ctx.createGain(); o.frequency.setValueAtTime(140, t); o.frequency.exponentialRampToValueAtTime(40, t + 0.12); g.gain.setValueAtTime(0.5, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.15); o.connect(g); g.connect(m.out); o.start(t); o.stop(t + 0.16); }
        if (st % 2 === 1) { const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain(); if (!this._nb) this.noise(0.01, 0.0001, 100, 100); s.buffer = this._nb; f.type = 'highpass'; f.frequency.value = 7000; g.gain.setValueAtTime(0.12, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.04); s.connect(f); f.connect(g); g.connect(m.out); s.start(t); s.stop(t + 0.05); }
        m.next += sixteenth; m.step++;
      }
    };
    this.procMusic.timer = setInterval(tick, 50); tick();
  }
  finalLap() {
    this.announce('a_final');
    this.sfx('finallap', () => [784, 988, 1175, 1568].forEach((f, i) => setTimeout(() => this.beep(f, 0.16, 0.12, 'square'), i * 110)), 0.8);
    if (this.musicSrc && this.musicName === 'music_race') this.musicSrc.playbackRate.setTargetAtTime(1.12, this.ctx.currentTime + 1.5, 0.4);
    if (this.procMusic) this.procMusic.tempo = 160;
  }
  stopProcMusic() {
    const m = this.procMusic; if (!m) return;
    clearInterval(m.timer); this.procMusic = null;
    try { m.out.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05); setTimeout(() => m.out.disconnect(), 400); } catch {}
  }
}
const sound = new Sound();
window.addEventListener('pointerdown', () => sound.start());

// ------------------------------------------------------------------ players + network
const players = new Map(); // id -> { id, name, cfg, input, connected, car }
let phase = 'loading', phaseT = 0, raceTime = 0, cars = [];
let paused = false, resumeT = 0;   // pause from a phone; resume runs a short 3-2-1
const keys = {};

// each player drives a racer (Ruby / Lime / Sunny / Plum); phones that haven't picked one get a free one by slot
function defaultCfg(slot) {
  const used = new Set([...players.values()].map((p) => p.cfg.racer));
  const want = RACER_IDS[slot] && !used.has(RACER_IDS[slot]) ? RACER_IDS[slot] : (RACER_IDS.find((r) => !used.has(r)) || RACER_IDS[0]);
  return sanitizeKart({ racer: want });
}
const pColor = (p) => kartColor(p.cfg);
const pick = (a) => a[Math.floor(Math.random() * a.length)];
function randomCfg(racer) { return sanitizeKart({ racer: racer || pick(RACER_IDS), body: pick(BODY_IDS), wheels: pick(WHEEL_IDS) }); }
let gridTimer = 0;
const rebuildSoon = () => { clearTimeout(gridTimer); gridTimer = setTimeout(() => { if (phase === 'lobby') rebuildGrid(); }, 150); };
let botCfgs = BOT_NAMES.map(() => randomCfg());
// bots take the racers nobody picked first, so the grid shows all four characters
function botCfgsFor() {
  const used = new Set([...players.values()].map((p) => p.cfg.racer));
  const free = RACER_IDS.filter((r) => !used.has(r)).sort(() => Math.random() - 0.5);
  return BOT_NAMES.map((_, i) => free[i] ? { ...botCfgs[i], racer: free[i] } : botCfgs[i]);
}

let ws;
function connectWS() {
  ws = new WebSocket(window.KR ? KR.tvSocket() : `ws://${location.host}/?role=tv`);   // this TV's own room (js/room.js)
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    const p = players.get(m.id);
    switch (m.t) {
      case 'join':
        if (p) { p.connected = true; p.name = m.name; }
        else {
          if (players.size >= 4) return;
          players.set(m.id, { id: m.id, name: m.name, cfg: defaultCfg(m.slot), input: { ...NO_INPUT }, connected: true, car: null });   // the replayed garage message may change the racer
          if (phase === 'lobby') rebuildSoon();
        }
        refreshLobby(); syncPads(true); break;
      case 'away': if (p) { p.connected = false; p.input = { ...NO_INPUT }; refreshLobby(); } break;
      case 'leave':
        if (p) { if (p.car) { p.car.human = false; p.car.player = null; } players.delete(m.id); if (phase === 'lobby') rebuildSoon(); refreshLobby(); }
        break;
      case 'in': if (p) p.input = { s: clamp(+m.s || 0, -1, 1), g: m.g ? 1 : 0, b: m.b ? 1 : 0, n: m.n ? 1 : 0, i: m.i ? 1 : 0 }; break;
      case 'garage':   // phones send their Neon Racer car and their Sunny Kart racer together; only the racer matters here
        if (p && m.cfg && RACERS[m.cfg.racer]) {
          const k = sanitizeKart(m.cfg);
          const taken = k.racer !== p.cfg.racer && [...players.values()].some((q) => q !== p && q.cfg.racer === k.racer);
          if (taken) k.racer = p.cfg.racer;   // a refused racer snaps the phone back; the kart parts still apply
          const changed = JSON.stringify(k) !== JSON.stringify(p.cfg), newRacer = k.racer !== p.cfg.racer;
          if (changed) {
            p.cfg = k; rebuildSoon(); refreshLobby();
            if (phase === 'lobby') { if (newRacer) sound.voice(k.racer, 'pick', true); else sound.play('select', 0.6); }
          }
          syncPads(true);
        }
        break;
      case 'pick': if (phase === 'lobby' || (phase === 'results' && !(quiz && quiz.locked))) { if (m.game === 'neon') location.href = '/neon'; else if (m.game === 'menu') location.href = '/'; } break;
      case 'start': if (phase === 'lobby') startCountdown(); else introSkip(); break;
      case 'level': if ((phase === 'lobby' || phase === 'results') && !(quiz && quiz.locked)) setLevel(m.v); break;
      case 'again': if (phase === 'results' && !(quiz && quiz.locked)) startCountdown(); break;   // the quiz unlocks the next race
      case 'lobby': if (phase === 'results' && !(quiz && quiz.locked)) toLobby(); break;
      case 'answer': if (quiz) quiz.answer(m.id, m.k | 0); break;
      case 'pause': if (p) pauseGame(p.name); break;
      case 'resume': resumeGame(); break;
      case 'quit': if (paused) toLobby(); break;
    }
  };
  ws.onclose = (e) => {
    if (e.code === 4000) { window.__fatal('The game was opened on another screen, so this one stopped. Reload this page to take it back.'); return; }   // don't fight the other screen
    setTimeout(connectWS, 1000);
  };
}
const sendPad = (id, msg) => { if (id !== 'kb' && ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'toPad', id, msg })); };

const lastPadState = new Map();
function syncPads(force = false) {
  let slot = 0;
  for (const p of players.values()) {
    const others = [...players.values()].filter((q) => q !== p).map((q) => ({ name: q.name, racer: q.cfg.racer }));
    const base = { t: 'state', game: GAME, name: p.name, color: pColor(p), racer: p.cfg.racer, kart: p.cfg, others, slot: slot++, level };
    let st;
    if (phase === 'lobby' || phase === 'loading') st = { ...base, phase: 'lobby', status: 'Ready!' };
    else if (paused) st = { ...base, phase: 'paused', status: 'Paused', by: pausedByName };
    else if (phase === 'countdown' || phase === 'race') {
      const c = p.car;
      st = !c ? { ...base, phase: 'wait', status: 'Next race' } : { ...base, phase: 'race', status: c.finished ? `Finished ${ord(c.place)}!` : `Lap ${c.lap}/${LAPS} · ${ord(c.place)}` };
    } else {
      const c = p.car;
      st = { ...base, phase: 'results', status: 'Race over', title: c ? (c.place === 1 ? '🏆 You WON!' : `You finished ${ord(c.place)}!`) : 'Race over',
        sub: c ? `${c.place === 1 ? 'Amazing driving!' : 'Great race!'} You collected ${c.coins} coin${c.coins === 1 ? '' : 's'} 🪙` : 'Great race! Try again?' };
    }
    if (phase === 'results' && quiz && quiz.locked) st = quiz.padState(p, st) || st;
    const k = JSON.stringify(st);
    if (force || lastPadState.get(p.id) !== k) { lastPadState.set(p.id, k); sendPad(p.id, st); }
  }
}

// keyboard / TV remote (D-pad + OK) player
window.addEventListener('keydown', (e) => {
  sound.start();
  if (quiz && quiz.active && quiz.key(e)) { e.preventDefault(); return; }
  if ((e.code === 'ArrowLeft' || e.code === 'ArrowRight') && (phase === 'lobby' || phase === 'results') && !paused && !(quiz && quiz.locked)) {
    e.preventDefault(); stepLevel(e.code === 'ArrowRight' ? 1 : -1); return;   // remote ◀ ▶ = level (▲ ▼ join the remote player)
  }
  keys[e.code] = true;
  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space'].includes(e.code)) {
    e.preventDefault();
    if (!players.has('kb') && players.size < 4 && (phase === 'lobby' || phase === 'results') && e.code !== 'Space' && !(quiz && quiz.locked)) {
      players.set('kb', { id: 'kb', name: 'Remote', cfg: defaultCfg(-1), input: { ...NO_INPUT }, connected: true, car: null });
      if (phase === 'lobby') rebuildSoon();
      refreshLobby();
    }
  }
  if ((e.key === 'Backspace' || e.key === 'GoBack' || e.key === 'BrowserBack' || e.code === 'Escape') && (phase === 'lobby' || phase === 'results') && !(quiz && quiz.locked)) { e.preventDefault(); location.href = '/'; return; }
  if (e.code === 'KeyP' || e.key === 'MediaPlayPause' || e.key === 'Pause') { e.preventDefault(); if (paused) resumeGame(); else pauseGame('Remote'); return; }
  if (e.code === 'Enter' || e.code === 'NumpadEnter' || e.key === 'Enter') {
    e.preventDefault();
    if (paused) { resumeGame(); return; }
    if (phase === 'lobby' || (phase === 'results' && !(quiz && quiz.locked))) startCountdown(); else introSkip();
  }
});
window.addEventListener('keyup', (e) => { keys[e.code] = false; });
const kbInput = { s: 0, g: 0, b: 0, n: 0, i: 0 };
function keyboardInput() {
  kbInput.s = (keys.ArrowRight ? 1 : 0) - (keys.ArrowLeft ? 1 : 0); kbInput.g = keys.ArrowUp ? 1 : 0; kbInput.b = keys.ArrowDown ? 1 : 0;
  kbInput.n = keys.Space ? 1 : 0; kbInput.i = keys.KeyZ ? 1 : 0;
  return kbInput;
}

// ------------------------------------------------------------------ lobby / results
function refreshLobby() {
  renderLevel();
  const list = [...players.values()];
  let h = '';
  for (let i = 0; i < 4; i++) {
    const p = list[i];
    h += p ? `<div class="slot on${p.connected ? '' : ' away'}"><span class="dot" style="background:${pColor(p)}"></span>${escapeHtml(p.name)}<span class="carname">${RACERS[p.cfg.racer].name} · ${BODIES[p.cfg.body].name}</span></div>`
      : '<div class="slot"><span class="dot"></span>Waiting for player…</div>';
  }
  $('slots').innerHTML = h;
}
async function loadJoinInfo() {
  try {
    const info = await fetch('/info' + (window.KR ? '?room=' + KR.tvRoom() : '')).then((r) => r.json());
    $('qr').innerHTML = info.qr;
    if (info.hosted) for (const el of document.querySelectorAll('.steps div')) if (/same Wi-Fi/.test(el.textContent)) el.innerHTML = '<b>1.</b> Any phone with internet';
    $('joinurl').innerHTML = info.joinShort ? `${escapeHtml(info.joinShort)} · room <b>${escapeHtml(info.room || '')}</b>` : escapeHtml(info.joinUrl);
    if (info.selfSigned ?? (info.joinUrl.startsWith('https') && !info.hosted)) $('joinalt').innerHTML = `Phone says “not private”? Tap <b>Show Details → visit this website</b> (it's your own computer).<br>Buttons-only link: ${escapeHtml(info.joinUrlHttp || '')}`;
  } catch { $('joinurl').textContent = 'Could not get join address'; }
}

function humanCars() { return cars.filter((c) => c.human); }

function rebuildGrid() {
  cars.forEach((c) => c.dispose());
  cars = [];
  const humans = [...players.values()];
  const total = clamp(Math.max(4, humans.length + 2), 4, 8);
  const nb = Math.min(BOT_NAMES.length, total - humans.length);
  const entries = [];
  const bc = botCfgsFor();
  for (let i = 0; i < nb; i++) entries.push({ name: BOT_NAMES[i], cfg: bc[i], human: false, player: null });
  for (const p of humans) entries.push({ name: p.name, cfg: p.cfg, human: true, player: p });
  entries.forEach((e, k) => {
    const car = new Car(e);
    const row = Math.floor(k / 2), col = k % 2;
    car.placeAt(track.L - 8 - row * 8 - col * 4, col ? 4.5 : -4.5);
    car.u = car.s - track.L;
    car.speedMul = e.human ? 1 : LV().bot.start;
    if (e.player) e.player.car = car;
    car.sync(0, 0);
    cars.push(car);
  });
  for (const p of players.values()) if (!cars.some((c) => c.player === p)) p.car = null;
  buildHud();
  renderer.compile(scene, camera);   // compile new paint shaders now, not mid-race (slow on the TV)
}

function startCountdown() {
  if (!track) return;
  sound.stopEngines();
  if (quiz) quiz.cancel();
  rebuildGrid();
  if (quiz) for (const p of players.values()) {
    const b = quiz.bonus(p.id);
    if (p.car && b) { p.car.coins = Math.min(MAX_COINS, b); setTimeout(() => showMsg(`${p.name}: +${b} quiz coin${b > 1 ? 's' : ''} 🪙`, p.car ? p.car.color : '#fff'), 300); }
  }
  if (quiz) quiz.res.clear();
  phase = 'countdown'; phaseT = 0; raceTime = 0;
  pickups.reset(); projectiles.clear(); startLights(0); sound.stopMusic();
  podiumOff();
  $('lobby').classList.add('hidden'); $('results').classList.add('hidden');
  buildHud(); snapCam = true;
  startIntro();
  syncPads(true);
}
// ---- racer intro before the countdown: fly over the circuit, then along the grid while the racers shout. OK skips.
const INTRO_LEN = Q.get('intro') === '0' ? 0 : 4.6;
let introT = 0, introShout = new Set();
function startIntro() {
  introT = INTRO_LEN; introShout = new Set();
  if (!introT) return;
  $('introLaps').textContent = `${LAPS} lap${LAPS > 1 ? 's' : ''} · Mario-style kart racing`;
  $('introCards').innerHTML = [...cars].reverse().map((c) => `<div class="icard" style="--c:${c.color}"><div class="e">${BODIES[c.cfg.body].icon}</div>${escapeHtml(c.name.toUpperCase())}<small>${RACERS[c.racer].name} · ${BODIES[c.cfg.body].name}${c.human ? '' : ' 🤖'}</small></div>`).join('');
  $('intro').classList.remove('hidden'); document.body.classList.add('intro');
  sound.music('music_menu');
}
function endIntro() {
  if (introT <= 0 && !document.body.classList.contains('intro')) return;
  introT = 0; $('intro').classList.add('hidden'); document.body.classList.remove('intro'); snapCam = true; phaseT = 0;
  sound.stopMusic();
}
function introCamera(dt) {
  const u = 1 - introT / INTRO_LEN;
  if (u < 0.42) {   // high orbit over the whole circuit
    const a = -0.6 + u * 1.6, R = 175 - u * 60;
    camera.position.set(Math.sin(a) * R, 95 - u * 40, Math.cos(a) * R);
    camera.lookAt(0, 0, 0);
    if (Math.abs(camera.fov - 55) > 0.05) { camera.fov = 55; camera.updateProjectionMatrix(); }
    return;
  }
  // low dolly down the side of the grid, from the front kart to the back
  const v = (u - 0.42) / 0.58, front = track.L + 4, back = track.L - 8 - Math.ceil(cars.length / 2) * 8 - 6;
  const sc = front - (front - back) * v * v * (3 - 2 * v);
  const p = track.at(sc, -8.5); camera.position.set(p.x, 3.0, p.z);   // (track.at returns a shared object: use it before the next call)
  const l = track.at(sc - 7, 1.5); camera.lookAt(l.x, 1.0, l.z);
  if (Math.abs(camera.fov - 50) > 0.05) { camera.fov = 50; camera.updateProjectionMatrix(); }
  for (const c of cars) {
    let ds = c.u - (sc - track.L); if (ds > 2 && !introShout.has(c) && (c.human || introShout.size < 2)) { introShout.add(c); if (c.human || Math.random() < 0.6) sound.voice(c.racer, 'start'); c.cheerT = 1.2; }
  }
}
function introSkip() { if (introT > 0) { endIntro(); return true; } return false; }
function showResults() {
  phase = 'results'; phaseT = 0;
  botCfgs = BOT_NAMES.map(() => randomCfg());
  sound.stopEngines(); sound.stopMusic(); projectiles.clear();
  setTimeout(() => { if (phase === 'results') sound.music('music_menu'); }, 4500);
  const order = [...cars].sort(raceOrder);
  lastOrder = order;
  podiumShow(order);
  if (quiz && quiz.arm()) setTimeout(() => { if (phase === 'results' && quiz.pending) quiz.start(); }, 7000);
  $('restable').innerHTML = order.map((c, i) =>
    `<tr class="${c.human ? '' : 'bot'}"><td class="p">${ord(i + 1)}</td><td class="n"><span class="dot" style="background:${c.color}"></span>${escapeHtml(c.name)}${c.human ? '' : ' 🤖'}<span class="carname">${c.carName}</span></td><td class="c">🪙 ${c.coins}</td><td class="t">${c.finished ? fmtTime(c.finishTime) : '—'}</td></tr>`).join('');
  $('results').classList.remove('hidden');
  buildHud();
  syncPads(true);
}
function pauseGame(by) {
  if (paused || (phase !== 'race' && phase !== 'countdown')) return;
  paused = true; resumeT = 0; pausedByName = by;
  $('pausedBy').textContent = `${by} paused the race`;
  $('paused').classList.remove('hidden');
  sound.stopEngines(); sound.stopMusic();
  for (const c of cars) c.fx('paused');
  syncPads(true);
}
function resumeGame() {
  if (!paused) return;
  paused = false;
  $('paused').classList.add('hidden');
  resumeT = phase === 'race' ? 3 : 0;   // a countdown already counts itself
  if (phase === 'race') setTimeout(() => { if (!paused && phase === 'race') sound.startMusic(); }, 3000);
  lastResumeN = -1;
  last = performance.now();
  syncPads(true);
}
let pausedByName = '', lastResumeN = -1;
function toLobby() {
  paused = false; resumeT = 0; $('paused').classList.add('hidden'); sound.stopMusic(); projectiles.clear();
  phase = 'lobby'; $('results').classList.add('hidden'); $('lobby').classList.remove('hidden'); sound.music('music_menu'); podiumOff();
  rebuildGrid(); refreshLobby(); syncPads(true);
}
// ---- winner's podium after the race: the top three karts on 1-2-3 blocks, confetti, the winner cheering
const PODIUM_S = 24;   // just past the start line: no coins or item boxes between the camera and the podium
let podium = null, podiumOn = false, confetti = null;
const PODIUM = [{ d: 0, h: 1.5, col: 0xffcf3a, n: '1' }, { d: 4.2, h: 1.05, col: 0xd7dce6, n: '2' }, { d: -4.2, h: 0.75, col: 0xe08a4a, n: '3' }];
function buildPodium() {
  podium = new THREE.Group();
  const ah = track.at(PODIUM_S, 0).h;
  for (const b of PODIUM) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(3.9, b.h, 4.2), new THREE.MeshMatcapMaterial({ matcap: matcaps.gloss, color: b.col }));
    const p = track.at(PODIUM_S, b.d); m.position.set(p.x, b.h / 2, p.z); m.rotation.y = ah; podium.add(m);
    const tex = canvasTex(128, 128, (g) => { g.font = '900 110px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineWidth = 10; g.strokeStyle = '#0b2d6e'; g.strokeText(b.n, 64, 70); g.fillStyle = '#fff'; g.fillText(b.n, 64, 70); });
    const lab = new THREE.Mesh(new THREE.PlaneGeometry(Math.min(1.3, b.h * 0.9), Math.min(1.3, b.h * 0.9)), new THREE.MeshBasicMaterial({ map: tex, transparent: true }));
    const f = track.at(PODIUM_S + 2.12, b.d); lab.position.set(f.x, b.h / 2, f.z); lab.rotation.y = ah; podium.add(lab);
  }
  podium.visible = false; scene.add(podium);
  confetti = new Confetti(140);
}
class Confetti {
  constructor(n) {
    const t = canvasTex(8, 8, (g) => { g.fillStyle = '#fff'; g.fillRect(0, 0, 8, 8); });
    this.batch = new QuadBatch(n, new THREE.MeshBasicMaterial({ map: t }));
    this.batch.mesh.renderOrder = 2; scene.add(this.batch.mesh);
    const cols = [[1, 0.25, 0.25], [1, 0.82, 0.12], [0.2, 0.8, 0.3], [0.3, 0.6, 1], [1, 0.4, 0.75], [1, 1, 1]];
    this.p = Array.from({ length: n }, (_, i) => ({ x: 0, y: -9, z: 0, vy: 0, a: 0, c: cols[i % cols.length], s: 0.12 + Math.random() * 0.1 }));
    this.on = false;
  }
  start(cx, cz) { this.on = true; this.cx = cx; this.cz = cz; for (const q of this.p) this.reset(q, true); }
  reset(q, first) { q.x = this.cx + (Math.random() - 0.5) * 16; q.z = this.cz + (Math.random() - 0.5) * 10; q.y = 7 + Math.random() * (first ? 8 : 2); q.vy = 1.2 + Math.random() * 1.5; q.a = Math.random() * 6; }
  update(dt, t) {
    this.batch.begin();
    if (this.on) for (const q of this.p) {
      q.y -= q.vy * dt; q.a += dt * 5; q.x += Math.sin(t * 2 + q.a) * dt * 0.6;
      if (q.y < 0) this.reset(q, false);
      this.batch.upright(q.x, q.y, q.z, q.a, q.s * Math.abs(Math.cos(q.a)) + 0.03, q.s, 0, 1, q.c[0], q.c[1], q.c[2]);
    }
    this.batch.end();
  }
}
function podiumShow(order) {
  if (!podium) buildPodium();
  podiumOn = true; podium.visible = true;
  const a0 = track.at(PODIUM_S, 0), a = { x: a0.x, z: a0.z, h: a0.h };
  cars.forEach((c) => { c.hidden = true; c.liftY = 0; c.vx = c.vz = 0; c.drift = 0; c.boostFx = false; c.starT = 0; c.rocketT = 0; c.spinT = 0; c.dizzyT = 0; c.invT = 0; c.blink = 0; });
  order.slice(0, 3).forEach((c, i) => {
    const b = PODIUM[i], p = track.at(PODIUM_S, b.d);
    c.hidden = false; c.x = p.x; c.z = p.z; c.h = a.h + (i === 0 ? 0 : i === 1 ? -0.35 : 0.35); c.liftY = b.h; c.steer = 0;   // facing the camera
    c.cheerT = i === 0 ? 1e9 : 0;
  });
  confetti.start(a.x, a.z);
  snapCam = true;
  const humanTop = order.slice(0, 3).some((c) => c.human), win = order[0];
  const me = order.find((c) => c.human);
  $('greattry').classList.toggle('hidden', !me || humanTop);
  if (me && !humanTop) $('greattry').textContent = `Great try, ${me.name}! 🌟`;
  document.body.classList.add('podium');
  setTimeout(() => {
    if (!podiumOn) return;
    sound.play('cheer', 0.7);
    if (win.human) sound.voice(win.racer, 'win', true);
    else if (me) sound.voice(me.racer, humanTop ? 'start' : 'lose', true);
    else sound.voice(win.racer, 'win', true);
  }, 500);
}
function podiumOff() {
  if (!podiumOn) return;
  podiumOn = false; if (podium) podium.visible = false; if (confetti) confetti.on = false, confetti.update(0, 0);
  document.body.classList.remove('podium');
  for (const c of cars) { c.hidden = false; c.liftY = 0; c.cheerT = 0; }
}
function podiumCamera(dt, t) {
  // podium on the left half of the screen (the results panel is on the right)
  const a = track.at(PODIUM_S + 19 + Math.sin(t * 0.3) * 1.2, -3 + Math.sin(t * 0.21) * 1.2);
  camera.position.set(a.x, 3.6 + Math.sin(t * 0.4) * 0.3, a.z);
  const l = track.at(PODIUM_S, -7); camera.lookAt(l.x, 2.0, l.z);
  if (Math.abs(camera.fov - 48) > 0.05) { camera.fov = 48; camera.updateProjectionMatrix(); }
  for (const c of cars) if (c.tag) c.tag.visible = false;
}

const raceOrder = (a, b) => {
  if (a.finished && b.finished) return a.finishTime - b.finishTime;
  if (a.finished !== b.finished) return a.finished ? -1 : 1;
  return b.u - a.u;
};

// ------------------------------------------------------------------ HUD, Mario Kart style (10 Hz, cached DOM writes)
let hudCards = [];
function buildHud() {
  const racing = phase === 'countdown' || phase === 'race';
  const hc = racing ? humanCars() : [];
  const hud = $('hud');
  const show = hc.length <= 2 ? hc : [];   // 3–4 players share one view: the phones show each player's details
  hud.innerHTML = show.map((c) => `<div class="card" style="--pc:${c.color}"><div class="citem"></div><div class="cinfo"><div class="cname">${escapeHtml(c.name)}</div><div class="clap"></div><div class="ccoin"></div></div><div class="cpos"></div></div>`).join('');
  hudCards = show.map((c, i) => {
    const el = hud.children[i];
    return { car: c, el, pos: el.querySelector('.cpos'), lap: el.querySelector('.clap'), coin: el.querySelector('.ccoin'), item: el.querySelector('.citem'), cache: {} };
  });
  $('minimap').style.display = racing ? 'block' : 'none';
}
const setText = (cache, key, el, v, html = false) => { if (cache[key] !== v) { cache[key] = v; if (html) el.innerHTML = v; else el.textContent = v; } };
function updateHud() {
  const roll = Object.values(ITEMS);
  for (const hcd of hudCards) {
    const c = hcd.car, k = hcd.cache;
    setText(k, 'pos', hcd.pos, `${c.place}<small>${sfx2(c.place)}</small>`, true);
    setText(k, 'lap', hcd.lap, c.finished ? 'FINISH!' : `LAP ${c.lap}<small>/${LAPS}</small>`, true);
    setText(k, 'coin', hcd.coin, `🪙 × ${c.coins}`);
    const itm = c.itemRoll > 0 ? roll[Math.floor(performance.now() / 110) % roll.length] : itemLabel(c);
    if (k.itm !== itm) { k.itm = itm; hcd.item.textContent = itm; hcd.item.classList.toggle('has', !!itm); }
    if (k.fin !== c.finished) { k.fin = c.finished; hcd.el.classList.toggle('fin', c.finished); }
  }
}
let msgTimer = 0;
function showMsg(text, color = '#fff') { const el = $('msg'); el.textContent = text; el.style.color = color; el.classList.add('on'); msgTimer = 1.6; }

let mmBase = null, mmT = null;
function drawMinimap() {
  const cv = $('minimap'), g = cv.getContext('2d'), S = cv.width;
  if (!mmBase) {
    let minx = Infinity, maxx = -Infinity, minz = Infinity, maxz = -Infinity;
    for (let i = 0; i < track.n; i++) { minx = Math.min(minx, track.x[i]); maxx = Math.max(maxx, track.x[i]); minz = Math.min(minz, track.z[i]); maxz = Math.max(maxz, track.z[i]); }
    const sc = (S - 24) / Math.max(maxx - minx, maxz - minz);
    mmT = { sc, ox: (S - (maxx - minx) * sc) / 2 - minx * sc, oz: (S - (maxz - minz) * sc) / 2 - minz * sc };
    mmBase = document.createElement('canvas'); mmBase.width = mmBase.height = S;
    const b = mmBase.getContext('2d');
    b.fillStyle = 'rgba(8,6,22,0.6)'; b.beginPath(); b.roundRect(0, 0, S, S, 18); b.fill();
    b.lineJoin = 'round';
    for (const [w, col] of [[9, 'rgba(255,255,255,0.15)'], [4, 'rgba(255,255,255,0.75)']]) {
      b.lineWidth = w; b.strokeStyle = col; b.beginPath();
      for (let i = 0; i <= track.n; i += 4) { const k = i % track.n; const x = track.x[k] * sc + mmT.ox, y = track.z[k] * sc + mmT.oz; i ? b.lineTo(x, y) : b.moveTo(x, y); }
      b.closePath(); b.stroke();
    }
    b.fillStyle = '#fff'; b.fillRect(track.x[0] * sc + mmT.ox - 3, track.z[0] * sc + mmT.oz - 3, 6, 6);
  }
  g.clearRect(0, 0, S, S);
  g.drawImage(mmBase, 0, 0);
  for (let pass = 0; pass < 2; pass++) for (const c of cars) {
    if ((pass === 1) !== c.human) continue;
    const x = c.x * mmT.sc + mmT.ox, y = c.z * mmT.sc + mmT.oz;
    g.fillStyle = c.color; g.beginPath(); g.arc(x, y, c.human ? 6 : 4, 0, Math.PI * 2); g.fill();
    if (c.human) { g.lineWidth = 2; g.strokeStyle = '#fff'; g.stroke(); }
  }
}
function showCenter(text) { const el = $('center'); el.textContent = text; el.classList.remove('hidden', 'pop'); void el.offsetWidth; el.classList.add('pop'); }

// ------------------------------------------------------------------ camera: one shared view for everyone
let snapCam = true, camShake = 0;
const camPos = new THREE.Vector3(), camLook = new THREE.Vector3(), tgtPos = new THREE.Vector3(), tgtLook = new THREE.Vector3();
let camYaw = 0, camFov = 62;
function updateCamera(dt, t) {
  if (introT > 0 && phase === 'countdown') { introCamera(dt); snapCam = true; return; }
  if (podiumOn) { podiumCamera(dt, t); return; }
  const racing = phase === 'countdown' || phase === 'race';
  const active = racing ? cars.filter((c) => c.human && !c.finished) : [];
  const followers = active.length ? active : (racing ? humanCars() : []);
  let fov = 60;
  if (!followers.length || !racing) {
    // lobby / results: hover in front of the starting grid, inside the road, swaying gently
    const g = track.at(track.L - 18), gx = g.x, gz = g.z;
    const e = track.at(track.L - 18 + 15 + 3 * Math.sin(t * 0.21), 5.5 * Math.sin(t * 0.13));
    tgtPos.set(e.x, 3.6 + Math.sin(t * 0.3) * 0.8, e.z);
    tgtLook.set(gx, 0.8, gz);
    snapCam = true; fov = 50;
  } else if (followers.length === 1) {
    const c = followers[0];
    if (snapCam) camYaw = c.h;
    camYaw += wrapA(c.h - camYaw) * (1 - Math.exp(-dt * 6));
    const sp = c.speed, back = 6.8 + sp * 0.03, up = 2.5 + sp * 0.012;
    tgtPos.set(c.x - Math.sin(camYaw) * back, up, c.z - Math.cos(camYaw) * back);
    tgtLook.set(c.x + Math.sin(camYaw) * 6, 1.1, c.z + Math.cos(camYaw) * 6);
    fov = 60 + Math.min(sp, 60) * 0.2 + (c.boostFx ? (c.rocketT > 0 ? 12 : 8) : 0);
    camPos.copy(tgtPos); camLook.copy(tgtLook);
  } else {
    // pack camera: frame every racing human, looking down the track from behind the group
    let uMax = -Infinity, uMin = Infinity, latSum = 0, spMax = 0;
    for (const c of followers) { uMax = Math.max(uMax, c.u); uMin = Math.min(uMin, c.u); latSum += c.d; spMax = Math.max(spMax, c.speed); }
    const spread = Math.min(uMax - uMin, CATCH_UP);
    const uMid = (uMax + uMin) / 2, lat = clamp(latSum / followers.length, -5, 5);
    const ctr = track.at(uMid, lat), cx = ctr.x, cz = ctr.z;
    const h = track.heading(uMid + 10 + spread * 0.2);
    if (snapCam) camYaw = h;
    camYaw += wrapA(h - camYaw) * (1 - Math.exp(-dt * 3));
    const back = 9 + spread * 0.62 + spMax * 0.03, up = 4.2 + spread * 0.32;
    tgtPos.set(cx - Math.sin(camYaw) * back, up, cz - Math.cos(camYaw) * back);
    tgtLook.set(cx + Math.sin(camYaw) * (5 + spread * 0.25), 1, cz + Math.cos(camYaw) * (5 + spread * 0.25));
    fov = 62 + Math.min(spMax, 50) * 0.12;
  }
  const k = snapCam ? 1 : 1 - Math.exp(-dt * (followers.length > 1 ? 4 : 8));
  if (!(racing && followers.length === 1)) { camPos.lerp(tgtPos, k); camLook.lerp(tgtLook, k); }
  camera.position.copy(camPos);
  if (camShake > 0) { camShake -= dt; camera.position.x += (Math.random() - 0.5) * camShake; camera.position.y += (Math.random() - 0.5) * camShake; }
  camera.lookAt(camLook);
  camFov += (fov - camFov) * (snapCam ? 1 : 1 - Math.exp(-dt * 3));
  if (Math.abs(camera.fov - camFov) > 0.05) { camera.fov = camFov; camera.updateProjectionMatrix(); }
  snapCam = false;
  if (splitActive()) updateSplitCams(dt);
}
// name tags keep a readable size from whichever camera is drawing
function updateTags(cam) {
  const racing = phase === 'countdown' || phase === 'race';
  for (const c of cars) if (c.tag) { const d = cam.position.distanceTo(c.group.position); const s = clamp(d * 0.14, 3, 14); c.tag.scale.set(s, s * 0.25, 1); c.tag.visible = racing && c.group.visible && !(quiz && quiz.active); }
}

// ------------------------------------------------------------------ split screen: exactly 2 players get left/right halves
// Draws the scene twice (same total pixels, double the draw calls). If the TV can't hold the frame rate,
// it switches back to the shared camera for the rest of the session.
let splitOff = false, splitAge = 0, splitLow = 0;
const splitViews = [0, 1].map(() => ({ cam: new THREE.PerspectiveCamera(72, 1, 0.5, 1400), yaw: 0, fov: 72, car: null }));
function splitActive() {
  if (introT > 0 || splitOff || (phase !== 'countdown' && phase !== 'race')) return false;
  let n = 0; for (const c of cars) if (c.human) n++;
  return n === 2;
}
function updateSplitCams(dt) {
  const hc = humanCars();
  splitViews.forEach((v, i) => {
    const c = hc[i], cam = v.cam, snap = v.car !== c;
    v.car = c;
    if (snap) v.yaw = c.h;
    v.yaw += wrapA(c.h - v.yaw) * (1 - Math.exp(-dt * 6));
    const sp = c.speed, back = 7.6 + sp * 0.035, up = 2.8 + sp * 0.012;
    cam.position.set(c.x - Math.sin(v.yaw) * back, up, c.z - Math.cos(v.yaw) * back);
    if (c.shake > 0) { c.shake -= dt; cam.position.x += (Math.random() - 0.5) * c.shake; cam.position.y += (Math.random() - 0.5) * c.shake; }
    cam.lookAt(c.x + Math.sin(v.yaw) * 6, 1.1, c.z + Math.cos(v.yaw) * 6);
    const fov = 70 + Math.min(sp, 60) * 0.15 + (c.boostFx ? (c.rocketT > 0 ? 10 : 6) : 0);
    v.fov += (fov - v.fov) * (snap ? 1 : 1 - Math.exp(-dt * 3));
    const aspect = (innerWidth / 2) / innerHeight;
    if (Math.abs(cam.fov - v.fov) > 0.05 || Math.abs(cam.aspect - aspect) > 1e-3) { cam.fov = v.fov; cam.aspect = aspect; cam.updateProjectionMatrix(); }
  });
}
let splitShown = false;
// one-line reports to the Mac terminal even without ?debug=1 (rare events only)
function reportAlways(type, msg) { try { fetch('/__log', { method: 'POST', body: JSON.stringify([{ type, msg }]) }).catch(() => {}); } catch {} }
function setSplitUi(on) {
  if (on === splitShown) return;
  if (on) reportAlways('split', `split screen on (2 players), ${fps.toFixed(0)} fps before`);
  splitShown = on;
  document.body.classList.toggle('split', on);
  if (!on) splitViews.forEach((v) => { v.car = null; });
  splitAge = 0; splitLow = 0;
}
function renderFrame() {
  const split = splitActive();
  setSplitUi(split);
  renderer.info.reset();
  if (!split) {
    skyGroup.position.copy(camera.position); updateTags(camera);
    renderer.render(scene, camera);
    return;
  }
  const w = innerWidth, h = innerHeight;
  renderer.setScissorTest(true);
  splitViews.forEach((v, i) => {
    renderer.setViewport(i * w / 2, 0, w / 2, h); renderer.setScissor(i * w / 2, 0, w / 2, h);
    skyGroup.position.copy(v.cam.position); updateTags(v.cam);
    renderer.render(scene, v.cam);
  });
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, w, h);
}

// shared screen: if a human falls far behind the leading human, warp them up behind the pack
function catchUp() {
  const hc = cars.filter((c) => c.human && !c.finished);
  if (hc.length < 2) return;
  let lead = hc[0]; for (const c of hc) if (c.u > lead.u) lead = c;
  for (const c of hc) {
    if (c !== lead && lead.u - c.u > CATCH_UP) {
      c.respawn(lead.u - 22, clamp(lead.d + (Math.random() < 0.5 ? -3 : 3), -5, 5));
      const sp = lead.speed * 0.8, a = track.at(c.s);
      c.vx = a.tx * sp; c.vz = a.tz * sp; c.h = a.h;
      c.fx('catchup');
      showMsg(`${c.name}: 🌀 CATCH UP!`, c.color);
    }
  }
}

// ------------------------------------------------------------------ main loop
const FIXED = 1 / 60;
let acc = 0, last = performance.now(), padT = 0, hudT = 0, lastCount = -1;
const order = [];

function update(dt) {
  phaseT += dt;
  const t = performance.now() / 1000;
  if (phase === 'countdown' && introT > 0) { introT -= dt; phaseT = 0; if (introT <= 0) endIntro(); }
  else if (phase === 'countdown') {
    const n = Math.ceil(3 - phaseT + 0.5);
    // rocket start: press gas during "1" (not before) for a boost off the line. Holding gas early just starts normally.
    for (const c of cars) {
      const g = c.human && c.player ? (c.player.id === 'kb' ? keyboardInput().g : c.player.input.g) : 0;
      if (g && n >= 2) c.gasEarly = true;
      if (g && n === 1) c.gasOnOne = true;
    }
    if (n !== lastCount) {
      lastCount = n;
      if (n >= 1 && n <= 3) { showCenter(String(n)); sound.sfx('beep', () => sound.beep(440, 0.2), 0.6); sound.announce('a_' + n); for (const c of cars) c.fx('count', n); startLights(4 - n); }
      else if (n <= 0) {
        showCenter('GO!'); sound.sfx('go', () => sound.beep(880, 0.45), 0.7); sound.announce('a_go'); phase = 'race'; phaseT = 0; startLights(4); setTimeout(() => { if (phase === 'race' && !paused) sound.startMusic(); }, 700);
        { const h = humanCars(); if (h.length) setTimeout(() => sound.voice(h[0].racer, 'start'), 1300); }
        for (const c of cars) {
          c.fx('go');
          const good = c.human ? (c.gasOnOne && !c.gasEarly) : Math.random() < 0.35;
          if (good) { c.turboT = 1.1; c.fx('rocketStart'); if (c.human) showMsg(`${c.name}: 🚀 ROCKET START!`, c.color); }
        }
      }
    }
  } else lastCount = -1;

  if (resumeT > 0) {
    resumeT -= dt;
    const n = Math.ceil(resumeT);
    if (n !== lastResumeN) {
      lastResumeN = n;
      if (n >= 1) { showCenter(String(n)); sound.sfx('beep', () => sound.beep(440, 0.2), 0.6); for (const c of cars) c.fx('count', n); }
      else { showCenter('GO!'); sound.sfx('go', () => sound.beep(880, 0.45), 0.7); for (const c of cars) c.fx('go'); }
    }
  }

  if (phase === 'race' && phaseT > 2.5 && lightsOn) startLights(0);
  if (phase === 'race' && resumeT <= 0) {
    raceTime += dt;
    acc = Math.min(acc + dt, 0.1);
    let lead = -1e9;
    for (const c of cars) if (c.human && c.u > lead) lead = c.u;
    for (const c of cars) {
      if (!c.human) c.speedMul = botSpeedMul(LV(), c.u, lead);   // rubber band, tuned per level
      else if (c.finished) c.speedMul = 0.9;
    }
    while (acc >= FIXED) {
      acc -= FIXED;
      for (const c of cars) {
        const inp = (c.human && !c.finished && c.player && c.player.connected) ? (c.player.id === 'kb' ? keyboardInput() : c.player.input) : c.aiInput();   // locked/away phones: autopilot
        if (c.player && c.player.id === 'kb' && c.item && c.itemRoll <= 0 && (c.kbItemT = (c.kbItemT || 0) + FIXED) > 0.8) { inp.i = 1; c.kbItemT = 0; }   // remote has no item key
        c.input = inp;
        const prevLap = c.lap;
        c.step(FIXED, inp, c.human && !c.finished);
        pickups.collide(c);
        if (c.lap > prevLap && c.lap === LAPS && c.human) sound.finalLap();
        if (c.lap > prevLap) { c.lapFlash = 1.6; c.fx(c.lap === LAPS ? 'final' : 'lap', c.lap); if (c.human) showMsg(`${c.name}: ${c.lap === LAPS ? 'FINAL LAP!' : 'LAP ' + c.lap}`, c.color); }
        if (!c.finished && c.u >= LAPS * track.L) {
          c.finished = true; c.finishTime = raceTime;
          c.fx('finish', c.place);
          if (c.human) {
            sound.sfx('finish', () => { sound.beep(660, 0.15); setTimeout(() => sound.beep(990, 0.4), 160); }, 0.8);
            sound.announce('a_finish');
            setTimeout(() => { sound.sfx(c.place <= 3 ? 'win' : 'lose', null, 0.8); sound.voice(c.racer, c.place === 1 ? 'win' : c.place <= 3 ? 'start' : 'lose', true); }, 1600);
            if (c.place <= 3) c.cheerT = 3;
            showMsg(`${c.name}: ${c.place === 1 ? '🏆 WINNER!' : 'FINISHED ' + ord(c.place).toUpperCase() + '!'}`, c.color);
          }
        }
      }
      for (let i = 0; i < cars.length; i++) for (let j = i + 1; j < cars.length; j++) {
        const a = cars[i], b = cars[j], dx = b.x - a.x, dz = b.z - a.z, d2 = dx * dx + dz * dz, R = 2.6;
        if (d2 < R * R && d2 > 1e-6) {
          const d = Math.sqrt(d2), nx = dx / d, nz = dz / d, push = (R - d) / 2;
          a.x -= nx * push; a.z -= nz * push; b.x += nx * push; b.z += nz * push;
          const rv = (b.vx - a.vx) * nx + (b.vz - a.vz) * nz;
          if (rv < 0) {
            const ma = a.starT > 0 ? 50 : a.phys.mass, mb = b.starT > 0 ? 50 : b.phys.mass, J = -rv * 1.2 / (1 / ma + 1 / mb);
            a.vx -= nx * J / ma; a.vz -= nz * J / ma; b.vx += nx * J / mb; b.vz += nz * J / mb;
            if ((a.starT > 0 || a.rocketT > 0) && b.spinOut(a)) { /* knocked aside */ }
            else if ((b.starT > 0 || b.rocketT > 0) && a.spinOut(b)) { /* knocked aside */ }
            else if (-rv > 4) { if (a.starT <= 0) a.onHit(-rv); if (b.starT <= 0) b.onHit(-rv); }
          }
        }
      }
      projectiles.step(FIXED);
    }
    // who is right ahead / behind (by race distance) → AI item use, homing target, slipstream
    for (const c of cars) { c.ahead = null; c.aheadGap = 1e9; c.behindGap = 1e9; }
    for (const a of cars) for (const b of cars) {
      if (a === b) continue;
      const gap = b.u - a.u;
      if (gap > 0 && gap < a.aheadGap) { a.aheadGap = gap; a.ahead = b; }
      if (gap < 0 && -gap < a.behindGap) a.behindGap = -gap;
    }
    for (const c of cars) {
      const b = c.ahead;
      const inDraft = b && c.aheadGap > 2.5 && c.aheadGap < 14 && Math.abs(b.d - c.d) < 1.8 && c.speed > 15 && c.spinT <= 0;
      if (inDraft) { c.draftCharge += dt; if (c.draftCharge > 1.1) { c.draftCharge = 0; c.draftT = 1.2; c.fx('draft'); if (c.human) sound.sfx('whoosh', () => sound.whoosh(), 0.7); } }
      else c.draftCharge = Math.max(0, c.draftCharge - dt * 2);
    }
    order.length = 0; for (const c of cars) order.push(c);
    order.sort(raceOrder);
    for (let i = 0; i < order.length; i++) {
      const c = order[i], np = i + 1;
      if (c.human && np < c.place && raceTime > 5 && !c.finished && (c.passT || 0) < raceTime) { c.passT = raceTime + 10; sound.voice(c.racer, 'pass'); sound.sfx('whoosh', null, 0.4); }
      c.place = np;
    }
    for (const c of cars) {
      if (!c.human) continue;
      const w = c.wrongWay > 0.8; if (w && !c.wrongSent) { c.fx('wrong'); showMsg(`${c.name}: ⟲ WRONG WAY`, '#ffdd33'); sound.announce('a_wrong'); } c.wrongSent = w;
    }
    if (!splitActive()) catchUp();   // in split screen everyone has their own view
    const hc = humanCars();
    let allDone = hc.length > 0, lastFin = 0;
    for (const c of hc) { if (!c.finished) allDone = false; else lastFin = Math.max(lastFin, c.finishTime); }
    if ((allDone && raceTime - lastFin > 3.5) || raceTime > 480 || (!hc.length && raceTime > 2)) showResults();
    for (const c of hc) sound.engine(c);
  }

  for (const c of cars) c.sync(dt, t);
  updateCamera(dt, t);
  if (quiz && quiz.active) quiz.update(dt, t);

  fx.shadow.begin(); fx.glow.begin();
  for (const c of cars) c.drawFx(t);
  projectiles.sync(t);
  drawStartLights();
  fx.shadow.end(); fx.glow.end();
  sparks.update(dt);
  camYawNow = Math.atan2(camera.position.x - camLook.x, camera.position.z - camLook.z) + Math.PI;
  fx.puffs.update(dt);
  if (confetti) confetti.update(dt, t);
  pickups.update(dt, t);
  if (msgTimer > 0 && (msgTimer -= dt) <= 0) $('msg').classList.remove('on');

  hudT += dt;
  if (hudT > 0.1) {
    hudT = 0;
    if (phase === 'race' || phase === 'countdown') { updateHud(); drawMinimap(); }
  }
  padT += dt;
  if (padT > 0.25) {
    padT = 0; syncPads();
    if (phase === 'race' || phase === 'countdown') for (const p of players.values()) {
      const c = p.car; if (!c) continue;
      sendPad(p.id, { t: 'hud', pos: c.place, of: cars.length, lap: c.lap, laps: LAPS, coins: c.coins, nitro: Math.round(c.nitro * 20) / 20,
        item: c.itemRoll > 0 ? 'roll' : c.item, n: c.itemN, fin: c.finished, star: c.starT > 0, rocket: c.rocketT > 0, magnet: c.magnetT > 0 });
    }
  }
}

// ------------------------------------------------------------------ frame + stats
let fpsT = 0, fpsN = 0, fps = 0, lowFor = 0, statT = 0, worstMs = 0, jsMs = 0, glMs = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const raw = (now - last) / 1000; last = now;
  const dt = Math.min(0.05, raw);
  const a = performance.now();
  if (phase !== 'loading' && !paused) update(dt);
  const b = performance.now();
  renderFrame();
  const c2 = performance.now();
  jsMs += b - a; glMs += c2 - b;
  fpsT += raw; fpsN++; worstMs = Math.max(worstMs, raw * 1000);
  if (fpsT >= 1) {
    fps = fpsN / fpsT; fpsT = 0; fpsN = 0;
    // only ever step DOWN (never above the device's target resolution)
    // split screen too slow? go back to the shared camera first (ignore the first 2 s: shader warm-up)
    if (splitShown && ++splitAge > 2) {
      splitLow = fps < targetFps ? splitLow + 1 : 0;
      if (splitLow >= 3) { splitOff = true; setSplitUi(false); snapCam = true; showMsg('Shared screen for smoother racing', '#9ff4ff'); reportAlways('perf', `split screen too slow (${fps.toFixed(1)} fps) → switched to the shared camera`); }
    }
    lowFor = fps < targetFps && !splitShown ? lowFor + 1 : 0;
    if (lowFor >= 3 && renderH > 360) { renderH = Math.round(renderH * 0.85); lowFor = 0; resize(); dbgLog('perf', `low fps ${fps.toFixed(1)} → render height ${renderH}`); }
    if (DEBUG) {
      const i = renderer.info.render;
      const n = Math.max(1, Math.round(fps));
      $('dbg').textContent = `${fps.toFixed(1)} fps  worst ${worstMs.toFixed(0)} ms\ncalls ${i.calls}  tris ${i.triangles}\njs ${(jsMs / n).toFixed(1)} ms  render-submit ${(glMs / n).toFixed(1)} ms\nres ${renderer.domElement.width}×${renderer.domElement.height}  ${phase}`;
      window.__perf = { fps, js: jsMs / n, gl: glMs / n, calls: i.calls, tris: i.triangles };
      if ((statT += 1) >= 5) {
        statT = 0;
        dbgLog('stats', `fps=${fps.toFixed(1)} worst=${worstMs.toFixed(0)}ms js=${(jsMs / Math.max(1, Math.round(fps))).toFixed(1)}ms submit=${(glMs / Math.max(1, Math.round(fps))).toFixed(1)}ms calls=${i.calls} tris=${i.triangles} res=${renderer.domElement.width}x${renderer.domElement.height} phase=${phase} cars=${cars.length} humans=${humanCars().length} progs=${renderer.info.programs.length} geos=${renderer.info.memory.geometries} tex=${renderer.info.memory.textures}`);
      }
    }
    worstMs = 0; jsMs = 0; glMs = 0;
  }
}

// TV self-check (debug): nothing in the scene may need features the TV lacks
function selfCheck() {
  const problems = [];
  scene.traverse((o) => {
    if (o.isInstancedMesh) problems.push('InstancedMesh ' + o.name);
    if (o.geometry && o.geometry.index && o.geometry.index.array instanceof Uint32Array) problems.push('uint32 index ' + (o.name || o.type));
    if (o.geometry && o.geometry.attributes.position && o.geometry.attributes.position.count > 65535) problems.push('>65535 verts ' + o.name);
    const m = o.material;
    if (m && (m.isMeshPhysicalMaterial || m.isMeshStandardMaterial)) problems.push('PBR material ' + m.name);
  });
  dbgLog(problems.length ? 'error' : 'selfcheck', problems.length ? 'TV problems: ' + problems.join(', ') : 'ok: no instancing, no uint32 indices, no PBR materials');
}

// ------------------------------------------------------------------ boot
(async () => {
  const t0 = performance.now();
  try {
    createRenderer();
  } catch (e) {
    window.__fatal('This screen cannot run 3D graphics (WebGL could not start). ' + (e && e.message ? e.message : ''));
    dbgLog('error', 'renderer: ' + (e && e.stack ? e.stack : e));
    return;
  }
  scene = new THREE.Scene();
  scene.background = new THREE.Color(FOG_COLOR);
  scene.fog = new THREE.Fog(FOG_COLOR, 160, 900);
  camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.5, 1400);
  makeTextures();
  setupSky();
  fx = {
    shadow: new QuadBatch(16, new THREE.MeshBasicMaterial({ map: canvasTex(64, 128, (g, w, h) => { const r = g.createRadialGradient(w / 2, h / 2, 6, w / 2, h / 2, w / 2); r.addColorStop(0, 'rgba(0,0,0,0.85)'); r.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = r; g.fillRect(0, 0, w, h); }), transparent: true, depthWrite: false, color: 0x000000 }), false),
    glow: new QuadBatch(160, additive({ map: glowAtlas })),
  };
  fx.shadow.mesh.material.color.set(0xffffff);
  fx.shadow.mesh.renderOrder = 1; fx.glow.mesh.renderOrder = 3;
  scene.add(fx.shadow.mesh, fx.glow.mesh);
  sparks = new Sparks(160); sparks.mesh.renderOrder = 4; scene.add(sparks.mesh);
  fx.puffs = new Puffs(48); scene.add(fx.puffs.batch.mesh);
  if (DEBUG) $('dbg').classList.remove('hidden');
  requestAnimationFrame(frame);
  sound.prefetch();
  try {
    await loadAll();
  } catch (e) {
    window.__fatal('Could not load the game files: ' + (e && e.message ? e.message : e));
    dbgLog('error', 'load: ' + (e && e.stack ? e.stack : e));
    return;
  }
  quiz = new Quiz({
    THREE, scene, camera, track, theme: 'sunny', s0: 30,
    players: () => [...players.values()].filter((p) => p.car && p.connected).map((p) => ({ id: p.id, name: p.name, color: pColor(p), car: p.car })),
    cars: () => cars, sendPad, refreshPads: () => syncPads(true),
    audioCtx: () => sound.ctx, audioOut: () => sound.voiceBus || sound.master,
    sfx: (n) => {
      if (n === 'tick') sound.play('select', 0.4, 1.3);
      else if (n === 'correct') { sound.play('itemget', 0.7); sound.play('cheer', 0.5); }
      else if (n === 'wrong') sound.play('slip', 0.7);
      else sound.play(n, 0.7);
    },
    onCheer: (c) => { c.cheerT = 1.6; }, onSpin: (c) => { c.dizzyT = 2.2; },
    onStart: () => { podiumOff(); sound.music('music_menu'); if (sound.musicGain) sound.musicGain.gain.value = 0.15; },
    onDone: () => { if (phase === 'results') { podiumShow(lastOrder); $('results').classList.remove('hidden'); } },
  });
  window.__booted = true;
  $('loading').classList.add('hidden');
  $('lobby').classList.remove('hidden');
  sound.start();   // try sound right away; the hint only shows if the browser still blocks it
  phase = 'lobby';
  sound.music('music_menu');
  loadJoinInfo();
  rebuildGrid();
  refreshLobby();
  connectWS();
  renderer.compile(scene, camera);
  dbgLog('boot', `ready ${(performance.now() / 1000).toFixed(1)} s after page start (assets ${((performance.now() - t0) / 1000).toFixed(1)} s)`);
  if (DEBUG) selfCheck();
  window.__game = { quiz: () => quiz, podiumShow: () => { phase = 'results'; podiumShow([...cars].sort(raceOrder)); }, sound, camera: () => camera, scene: () => scene, fx: () => fx, get phase() { return phase; }, get fps() { return fps; }, get pickups() { return pickups; }, renderer, track: () => track, cars: () => cars, players, startCountdown, keys };
})();
