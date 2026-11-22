// Shared by the TV (game.js) and the phone garage (garage.js).
// Car list + stats, paint options, and the paint material / pattern painter.

export const CARS = {
  viper: { name: 'Viper', tag: 'All-rounder', file: 'car_viper.glb', stats: { speed: 3, accel: 3, grip: 3 },
    phys: { maxV: 44, acc: 17, turn: 2.0, grip: 7.0, mass: 1.0 } },
  bolt: { name: 'Bolt', tag: 'Super fast', file: 'car_bolt.glb', stats: { speed: 5, accel: 2, grip: 3 },
    phys: { maxV: 47.5, acc: 15, turn: 1.9, grip: 6.6, mass: 1.0 } },
  tank: { name: 'Tank', tag: 'Big & strong', file: 'car_tank.glb', stats: { speed: 3, accel: 5, grip: 2 },
    phys: { maxV: 43, acc: 19.5, turn: 1.85, grip: 6.8, mass: 1.6 } },
  zip: { name: 'Zip', tag: 'Twisty turns', file: 'car_zip.glb', stats: { speed: 2, accel: 4, grip: 5 },
    phys: { maxV: 41.5, acc: 18.5, turn: 2.35, grip: 8.6, mass: 0.85 } },
};
export const CAR_IDS = Object.keys(CARS);

export const PAINTS = ['#e8102a', '#ff6a00', '#ffcc00', '#7dff2b', '#00c853', '#00e5c0',
  '#00b8ff', '#2a5bff', '#8a2dff', '#ff2d95', '#f2f2f5', '#16161a'];
export const PATTERNS = [
  { id: 'none', name: 'Plain', icon: '⬜' }, { id: 'stripes', name: 'Stripes', icon: '🏎️' },
  { id: 'flames', name: 'Flames', icon: '🔥' }, { id: 'bolt', name: 'Lightning', icon: '⚡' },
  { id: 'checker', name: 'Checkers', icon: '🏁' }, { id: 'stars', name: 'Stars', icon: '⭐' },
];
export const FINISHES = [
  { id: 'gloss', name: 'Shiny' }, { id: 'metal', name: 'Metallic' }, { id: 'matte', name: 'Matte' },
  { id: 'chrome', name: 'Chrome' }, { id: 'pearl', name: 'Pearl' },
];
export const GLOWS = ['off', '#ff2d95', '#00e5ff', '#7dff2b', '#ffcc00', '#8a2dff', '#ffffff'];

export const DEFAULT_CFG = { car: 'viper', paint: '#ff2d95', pattern: 'stripes', accent: '#f2f2f5', finish: 'gloss', glow: '#ff2d95' };

const HEX = /^#[0-9a-f]{6}$/i;
export function sanitizeCfg(c = {}) {
  const d = DEFAULT_CFG;
  return {
    car: CARS[c.car] ? c.car : d.car,
    paint: HEX.test(c.paint) ? c.paint : d.paint,
    pattern: PATTERNS.some((p) => p.id === c.pattern) ? c.pattern : d.pattern,
    accent: HEX.test(c.accent) ? c.accent : d.accent,
    finish: FINISHES.some((f) => f.id === c.finish) ? c.finish : d.finish,
    glow: c.glow === 'off' || HEX.test(c.glow) ? c.glow : d.glow,
  };
}

export function randomCfg(rand = Math.random) {
  const pick = (a) => a[Math.floor(rand() * a.length)];
  const paint = pick(PAINTS.slice(0, 11));
  let accent = pick(PAINTS); if (accent === paint) accent = '#f2f2f5';
  return { car: pick(CAR_IDS), paint, pattern: pick(PATTERNS).id, accent, finish: pick(['gloss', 'gloss', 'metal', 'matte', 'pearl']), glow: rand() < 0.5 ? paint : 'off' };
}

// ---------------------------------------------------------------- pattern painter
// Car body UVs (from blender/build_car.py): x = around the body (0.25 = roof centre line,
// 0 / 0.5 = the two sides, 0.75 = belly), y = 0 nose → 1 tail. Belly (0.62–0.88) stays plain.
const SIZE = 512;
function star(g, x, y, r) {
  g.beginPath();
  for (let k = 0; k < 10; k++) {
    const a = -Math.PI / 2 + (k * Math.PI) / 5, rr = k % 2 ? r * 0.45 : r;
    g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  g.closePath(); g.fill();
}
function onSides(g, draw) {
  // the body side centred on u = 0 wraps around the texture edge, so draw it at both ends
  for (const cx of [0, 0.5, 1]) { g.save(); g.translate(cx * SIZE, 0); draw(cx === 0.5 ? -1 : 1); g.restore(); }
}
export function paintPattern(canvas, cfg) {
  canvas.width = canvas.height = SIZE;
  const g = canvas.getContext('2d');
  g.fillStyle = cfg.paint; g.fillRect(0, 0, SIZE, SIZE);
  const A = cfg.accent, S = SIZE;
  switch (cfg.pattern) {
    case 'stripes':
      g.fillStyle = A;
      for (const o of [-0.042, 0.016]) g.fillRect((0.25 + o) * S, 0, 0.026 * S, S);
      break;
    case 'checker': {
      const q = 0.022 * S;
      for (let i = 0; i < 10; i++) for (let j = 0; j < 9; j++) {
        if ((i + j) % 2) continue;
        g.fillStyle = A; g.fillRect(0.25 * S - 5 * q + i * q, 0.03 * S + j * q, q, q);
      }
      onSides(g, () => { for (let i = 0; i < 4; i++) for (let j = 0; j < 30; j++) if ((i + j) % 2 === 0) { g.fillStyle = A; g.fillRect(-0.02 * S + i * 0.012 * S - 0.012 * S, 0.62 * S + j * 0.011 * S, 0.012 * S, 0.011 * S); } });
      break;
    }
    case 'flames':
      onSides(g, () => {
        for (let k = 0; k < 6; k++) {
          const across = (-0.11 + k * 0.042) * S, len = (0.28 + 0.16 * Math.sin(k * 2.3 + 1)) * S;
          const grad = g.createLinearGradient(0, 0, 0, len);
          grad.addColorStop(0, '#fff3a0'); grad.addColorStop(0.35, A); grad.addColorStop(1, A);
          g.fillStyle = grad;
          g.beginPath();
          g.moveTo(across - 0.03 * S, 0.02 * S);
          g.quadraticCurveTo(across - 0.04 * S, len * 0.6, across + 0.012 * S, len);
          g.quadraticCurveTo(across + 0.02 * S, len * 0.55, across + 0.03 * S, 0.02 * S);
          g.closePath(); g.fill();
        }
      });
      break;
    case 'bolt':
      onSides(g, () => {
        g.fillStyle = A; g.strokeStyle = '#ffffff'; g.lineWidth = 0.004 * S;
        const P = [[0.03, 0.12], [-0.03, 0.42], [0.0, 0.42], [-0.04, 0.82], [0.05, 0.36], [0.015, 0.36], [0.06, 0.12]];
        g.beginPath(); P.forEach(([u, v], i) => (i ? g.lineTo : g.moveTo).call(g, u * S, v * S)); g.closePath(); g.fill(); g.stroke();
      });
      break;
    case 'stars': {
      let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      g.fillStyle = A;
      for (let k = 0; k < 70; k++) {
        let u = rnd(); if (u > 0.6 && u < 0.9) continue;
        star(g, u * S, (0.05 + rnd() * 0.9) * S, (0.008 + rnd() * 0.012) * S);
      }
      break;
    }
  }
  return canvas;
}

// ---------------------------------------------------------------- paint material (TV-friendly)
// MeshMatcapMaterial: one matcap texture (lit sphere rendered in Blender, with neon reflections) gives the
// shiny / metallic / matte / chrome / pearl looks on a WebGL 1 GPU. Colour management is off in the game,
// so textures are used exactly as authored (NoColorSpace) and nothing is converted on the CPU.
export const MATCAP_NAMES = ['gloss', 'metal', 'matte', 'chrome', 'pearl', 'detail', 'gold'];
let matcapPromise = null;
export function loadMatcaps(THREE) {
  if (!matcapPromise) {
    const loader = new THREE.TextureLoader();
    matcapPromise = Promise.all(MATCAP_NAMES.map((n) => loader.loadAsync(`/assets/matcap_${n}.png`).then((t) => { t.colorSpace = THREE.NoColorSpace; return [n, t]; })))
      .then((list) => Object.fromEntries(list));
  }
  return matcapPromise;
}

const texCache = new Map();
export function makePaintMaterial(THREE, cfg, matcaps) {
  const finish = cfg.finish;
  const m = new THREE.MeshMatcapMaterial({ matcap: matcaps[finish] || matcaps.gloss, vertexColors: true });
  const base = new THREE.Color(cfg.paint);
  if (finish === 'chrome') base.lerp(new THREE.Color(1, 1, 1), 0.45);
  if (cfg.pattern === 'none') m.color.copy(base);
  else {
    const key = `${base.getHexString()}|${cfg.pattern}|${cfg.accent}`;
    let tex = texCache.get(key);
    if (!tex) {
      const c = paintPattern(document.createElement('canvas'), { ...cfg, paint: '#' + base.getHexString() });
      tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.NoColorSpace; tex.flipY = false;
      texCache.set(key, tex);
    }
    m.map = tex;
  }
  m.userData.base = m.color.clone();
  m.name = 'Paint';
  return m;
}
