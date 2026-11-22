// Smarty Kart kart look (version 2), shared by the TV game, the phone preview and the kart lab page.
// Each kart is: body (Paint / Trim / Chrome sharing one baked texture), driver (baked texture), a steering wheel that turns,
// two front wheels that steer and spin, and a rear wheel pair that spins. Materials are matcaps drawn in code (no lights;
// cheap on the TV's Mali-450): glossy 'candy' paint with a bright rim, satin trim, sky-reflecting chrome, soft driver and
// rubber. An optional cartoon outline (inverted hull) can be switched on per kart.
import * as THREE from 'three';

// ---------------------------------------------------------------- matcaps
const cache = {};
function canvas(draw, S = 128) {
  const c = document.createElement('canvas'); c.width = c.height = S;
  draw(c.getContext('2d'), S);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.NoColorSpace; return t;
}
function radial(g, S, x, y, r0, r1, stops) {
  const gr = g.createRadialGradient(S * x, S * y, S * r0, S * x, S * y, S * r1);
  for (const [o, c] of stops) gr.addColorStop(o, c);
  g.fillStyle = gr; g.fillRect(0, 0, S, S);
}
export function matcaps() {
  if (cache.m) return cache.m;
  const m = {};
  // glossy car paint: bright body, crisp highlight up-left, soft secondary, cool sky rim, warm road bounce at the bottom
  m.candy = canvas((g, S) => {
    radial(g, S, 0.45, 0.4, 0.02, 0.56, [[0, '#ffffff'], [0.5, '#e6e6e6'], [0.8, '#a9a9ad'], [1, '#6a6a72']]);
    radial(g, S, 0.5, 1.05, 0.05, 0.5, [[0, 'rgba(255,200,150,0.35)'], [1, 'rgba(255,200,150,0)']]);
    g.globalCompositeOperation = 'lighter';
    radial(g, S, 0.5, 0.5, 0.38, 0.5, [[0, 'rgba(150,200,255,0)'], [0.75, 'rgba(150,205,255,0.55)'], [1, 'rgba(150,205,255,0)']]);
    radial(g, S, 0.33, 0.26, 0, 0.12, [[0, 'rgba(255,255,255,1)'], [0.5, 'rgba(255,255,255,0.6)'], [1, 'rgba(255,255,255,0)']]);
    radial(g, S, 0.62, 0.3, 0, 0.2, [[0, 'rgba(255,255,255,0.25)'], [1, 'rgba(255,255,255,0)']]);
  });
  // satin plastic / fabric: softer, small highlight
  m.satin = canvas((g, S) => {
    radial(g, S, 0.45, 0.42, 0.02, 0.56, [[0, '#ffffff'], [0.55, '#e2e2e2'], [0.85, '#a8a8ac'], [1, '#77777e']]);
    g.globalCompositeOperation = 'lighter';
    radial(g, S, 0.35, 0.3, 0, 0.16, [[0, 'rgba(255,255,255,0.35)'], [1, 'rgba(255,255,255,0)']]);
    radial(g, S, 0.5, 0.5, 0.4, 0.5, [[0, 'rgba(170,210,255,0)'], [0.8, 'rgba(170,210,255,0.3)'], [1, 'rgba(170,210,255,0)']]);
  });
  // chrome: sky above, a dark horizon band, warm ground below, hard highlights
  m.chrome = canvas((g, S) => {
    const gr = g.createLinearGradient(0, 0, 0, S);
    gr.addColorStop(0, '#ffffff'); gr.addColorStop(0.3, '#cfe6ff'); gr.addColorStop(0.5, '#ffffff'); gr.addColorStop(0.53, '#4d5560');
    gr.addColorStop(0.62, '#9a8f84'); gr.addColorStop(1, '#4a443f');
    g.fillStyle = gr; g.fillRect(0, 0, S, S);
    g.globalCompositeOperation = 'lighter';
    radial(g, S, 0.32, 0.25, 0, 0.1, [[0, 'rgba(255,255,255,1)'], [1, 'rgba(255,255,255,0)']]);
    g.globalCompositeOperation = 'multiply';
    radial(g, S, 0.5, 0.5, 0.3, 0.5, [[0, '#ffffff'], [0.85, '#d0d0d0'], [1, '#808080']]);
  });
  // driver: like satin, a bit warmer and glossier (helmet)
  m.skin = canvas((g, S) => {
    radial(g, S, 0.45, 0.42, 0.02, 0.56, [[0, '#ffffff'], [0.55, '#ebe6e2'], [0.85, '#b3aaa6'], [1, '#7c7378']]);
    g.globalCompositeOperation = 'lighter';
    radial(g, S, 0.34, 0.28, 0, 0.1, [[0, 'rgba(255,255,255,0.75)'], [1, 'rgba(255,255,255,0)']]);
    radial(g, S, 0.5, 0.5, 0.4, 0.5, [[0, 'rgba(170,210,255,0)'], [0.8, 'rgba(170,210,255,0.35)'], [1, 'rgba(170,210,255,0)']]);
  });
  // rubber: flat and dull (the texture brings tread and rims)
  m.rubber = canvas((g, S) => {
    radial(g, S, 0.45, 0.42, 0.02, 0.56, [[0, '#ffffff'], [0.6, '#e8e8e8'], [0.9, '#a0a0a0'], [1, '#808080']]);
    g.globalCompositeOperation = 'lighter';
    radial(g, S, 0.35, 0.3, 0, 0.12, [[0, 'rgba(255,255,255,0.3)'], [1, 'rgba(255,255,255,0)']]);
  });
  cache.m = m;
  return m;
}

// ---------------------------------------------------------------- parts
const raw = (t) => { if (t) { t.colorSpace = THREE.NoColorSpace; t.anisotropy = 1; } return t; };
export const PIVOT = new THREE.Vector3(0, 0.62, -0.3);   // driver's seat (three.js coordinates)

// one loaded glTF scene → { Paint, Trim, Chrome, Driver geometries (baked transforms), map, nodes: { Steer, Wheel_FL, ... } }
export function preparePart(root) {
  const out = { nodes: {}, rearZ: -1.5 };
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    if (!o.isMesh) return;
    const n = o.material.name.replace(/\.\d+$/, '');
    const node = o.name.replace(/\.\d+$/, '');
    if (/^(Wheel_|Steer)/.test(node)) {      // moving parts keep their own pivot
      out.nodes[node] = { geo: o.geometry, pos: o.position.clone(), quat: o.quaternion.clone(), map: raw(o.material.map) };
      return;
    }
    const g = o.geometry.clone().applyMatrix4(o.matrixWorld);
    g.computeBoundingSphere();
    if (n === 'Driver') g.translate(-PIVOT.x, -PIVOT.y, -PIVOT.z);
    if (o.material.map) out.map = raw(o.material.map);
    out[n] = g;
  });
  out.rearZ = new THREE.Box3().setFromObject(root).min.z;
  return out;
}

// ---------------------------------------------------------------- outline (inverted hull along smoothed normals)
const outlineCache = new WeakMap();
function smoothNormals(geo) {
  if (outlineCache.has(geo)) return outlineCache.get(geo);
  const p = geo.attributes.position, n = geo.attributes.normal, map = new Map(), out = new Float32Array(p.count * 3);
  const key = (i) => `${Math.round(p.getX(i) * 500)},${Math.round(p.getY(i) * 500)},${Math.round(p.getZ(i) * 500)}`;
  for (let i = 0; i < p.count; i++) {
    const k = key(i); let s = map.get(k);
    if (!s) map.set(k, s = [0, 0, 0]);
    s[0] += n.getX(i); s[1] += n.getY(i); s[2] += n.getZ(i);
  }
  for (let i = 0; i < p.count; i++) {
    const s = map.get(key(i)), l = Math.hypot(s[0], s[1], s[2]) || 1;
    out[i * 3] = s[0] / l; out[i * 3 + 1] = s[1] / l; out[i * 3 + 2] = s[2] / l;
  }
  const g2 = new THREE.BufferGeometry();
  g2.setAttribute('position', p); g2.setAttribute('onormal', new THREE.BufferAttribute(out, 3));
  if (geo.index) g2.setIndex(geo.index);
  g2.boundingSphere = geo.boundingSphere;
  outlineCache.set(geo, g2);
  return g2;
}
let outlineMat = null;
function getOutlineMat() {
  if (outlineMat) return outlineMat;
  outlineMat = new THREE.MeshBasicMaterial({ color: 0x1a1420, side: THREE.BackSide });
  outlineMat.onBeforeCompile = (s) => {
    s.uniforms.uThick = { value: 0.03 };
    s.vertexShader = 'attribute vec3 onormal;\nuniform float uThick;\n' + s.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed += onormal * uThick;');
  };
  return outlineMat;
}
export function outlineOf(geo) { const m = new THREE.Mesh(smoothNormals(geo), getOutlineMat()); m.matrixAutoUpdate = false; return m; }

// ---------------------------------------------------------------- one kart
const sharedMats = {};
function mat(kind, map) {
  const key = kind + ':' + (map ? map.uuid : '');
  if (!sharedMats[key]) sharedMats[key] = new THREE.MeshMatcapMaterial({ matcap: matcaps()[kind], map: map || null, vertexColors: !map });
  return sharedMats[key];
}

export class KartModel {
  // parts: { body: preparePart(body glb), steer: preparePart(steer glb), driver: preparePart(driver glb), wheels: preparePart(wheel glb) }
  // lift: chassis height change for the wheel set; color: paint colour; outline: cartoon edge
  constructor({ body, steer, driver, wheels, lift = 0, color = '#e8202a', outline = false }) {
    this.group = new THREE.Group();
    this.paintMat = new THREE.MeshMatcapMaterial({ matcap: matcaps().candy, map: body.map, color });   // own copy: colour per kart
    this.trimMat = mat('satin', body.map); this.chromeMat = mat('chrome', body.map);
    this.driverMat = mat('skin', driver.map);
    const chassis = this.chassis = new THREE.Group(); chassis.position.y = lift;
    const add = (parent, geo, m, ol) => { const me = new THREE.Mesh(geo, m); parent.add(me); if (outline && ol) parent.add(outlineOf(geo)); return me; };
    add(chassis, body.Paint, this.paintMat, true); add(chassis, body.Trim, this.trimMat, true);
    if (body.Chrome) add(chassis, body.Chrome, this.chromeMat, false);
    this.driver = new THREE.Group(); this.driver.position.copy(PIVOT);
    add(this.driver, driver.Driver, this.driverMat, true);
    chassis.add(this.driver);
    const st = steer.nodes.Steer;
    this.steerPivot = new THREE.Group(); this.steerPivot.position.copy(st.pos); this.steerPivot.quaternion.copy(st.quat);
    this.steerMesh = new THREE.Mesh(st.geo, mat('satin', null)); this.steerPivot.add(this.steerMesh); chassis.add(this.steerPivot);
    this.wheels = {};
    for (const k of ['FL', 'FR', 'R']) {
      const w = wheels.nodes['Wheel_' + k]; if (!w) continue;
      const pivot = new THREE.Group(); pivot.position.copy(w.pos);
      const mesh = new THREE.Mesh(w.geo, mat('rubber', w.map)); pivot.add(mesh);
      this.group.add(pivot); this.wheels[k] = { pivot, mesh };
    }
    this.group.add(chassis);
    this.spin = 0; this.squash = 0; this.squashV = 0;
  }
  setPaint(color) { this.paintMat.color.set(color); }
  // steer −1..1, speed m/s (forward +), rearR for the spin rate; bump adds a suspension kick
  update(dt, steer, speed, rearR = 0.38) {
    this.spin += (speed / Math.max(0.2, rearR)) * dt;
    for (const k in this.wheels) {
      const w = this.wheels[k];
      w.mesh.rotation.x = this.spin;
      if (k !== 'R') w.pivot.rotation.y = -steer * 0.42;   // the game's steer > 0 turns right (towards −X)
    }
    this.steerMesh.rotation.y = -steer * 1.6;
    // suspension: a damped spring on the chassis
    this.squashV += (-this.squash * 160 - this.squashV * 14) * dt; this.squash += this.squashV * dt;
    this.chassis.scale.set(1 + this.squash * 0.25, 1 - this.squash, 1 + this.squash * 0.25);
  }
  bump(k = 1) { this.squashV += 1.8 * k; }
  dispose() { this.paintMat.dispose(); }
}
