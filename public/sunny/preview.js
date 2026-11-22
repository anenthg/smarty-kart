// Sunny Kart phone preview: a live 3D turntable of the kart you're building (racer + body + wheels + colour).
// Same parts and matcap shading as the TV. Drag to spin; renders only while visible.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { BODY_IDS, WHEEL_IDS, RACER_IDS, sanitizeKart, kartColor } from '/sunny/racers.js';
import { KartModel, preparePart } from '/sunny/kartlook.js';
const KART_DIR = '/sunny/assets/v2/';

THREE.ColorManagement.enabled = false;

export class KartPreview {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.setPixelRatio(Math.min(2, devicePixelRatio || 1));
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
    this.camera.position.set(0, 2.9, 8.6); this.camera.lookAt(0, 0.45, 0);   // kart sits between the title and the stats panel
    this.model = null;
    this.root = new THREE.Group(); this.scene.add(this.root);
    // soft round shadow under the kart
    const sc = document.createElement('canvas'); sc.width = sc.height = 64;
    const sg = sc.getContext('2d'), gr = sg.createRadialGradient(32, 32, 4, 32, 32, 32);
    gr.addColorStop(0, 'rgba(0,0,0,0.45)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); sg.fillStyle = gr; sg.fillRect(0, 0, 64, 64);
    const shadow = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 3.4), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(sc), transparent: true, depthWrite: false }));
    shadow.rotation.x = -Math.PI / 2; shadow.position.y = 0.01; this.scene.add(shadow);
    this.parts = null; this.cfg = null; this.angle = -0.7; this.spinV = 0.35; this.running = false;
    this.loader = new GLTFLoader();
    this.ready = this._load();
    // drag to spin
    let lastX = null;
    canvas.addEventListener('pointerdown', (e) => { lastX = e.clientX; this.spinV = 0; try { canvas.setPointerCapture(e.pointerId); } catch {} });
    canvas.addEventListener('pointermove', (e) => { if (lastX === null) return; const dx = e.clientX - lastX; lastX = e.clientX; this.angle += dx * 0.012; this.spinV = dx * 0.6; });
    const up = () => { lastX = null; if (Math.abs(this.spinV) < 0.2) this.spinV = 0.35; };
    canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up);
  }
  async _load() {
    const glb = (n) => this.loader.loadAsync(KART_DIR + n + '.glb').then((g) => preparePart(g.scene));
    const [info, bodies, wheels, drivers, steer] = await Promise.all([
      fetch(KART_DIR + 'kart_parts.json').then((r) => r.json()),
      Promise.all(BODY_IDS.map((id) => glb('body_' + id))), Promise.all(WHEEL_IDS.map((id) => glb('wheels_' + id))), Promise.all(RACER_IDS.map((id) => glb('driver_' + id))),
      glb('steer'),
    ]);
    this.parts = { info, body: {}, wheels: {}, driver: {}, steer };
    BODY_IDS.forEach((id, k) => { this.parts.body[id] = bodies[k]; });
    WHEEL_IDS.forEach((id, k) => { this.parts.wheels[id] = wheels[k]; });
    RACER_IDS.forEach((id, k) => { this.parts.driver[id] = drivers[k]; });
    if (this.cfg) this._build();
  }
  set(cfg) {
    const k = sanitizeKart(cfg);
    if (this.cfg && JSON.stringify(k) === JSON.stringify(this.cfg)) return;
    const pop = this.cfg && (this.cfg.body !== k.body || this.cfg.wheels !== k.wheels || this.cfg.racer !== k.racer);
    this.cfg = k;
    if (this.parts) this._build(pop);
  }
  _build(pop = false) {
    const k = this.cfg, P = this.parts;
    this.root.clear();
    if (this.model) this.model.dispose();
    this.model = new KartModel({ body: P.body[k.body], steer: P.steer, wheels: P.wheels[k.wheels], driver: P.driver[k.racer], lift: P.info.wheels[k.wheels].lift, color: kartColor(k) });
    this.root.add(this.model.group);
    if (pop) this.popT = 0.25;
    this.draw();
  }
  resize() {
    const r = this.canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    if (r.width !== this._w || r.height !== this._h) {
      this._w = r.width; this._h = r.height;
      this.renderer.setSize(r.width, r.height, false);
      this.camera.aspect = r.width / r.height; this.camera.updateProjectionMatrix();
    }
  }
  draw() {
    this.resize();
    const s = this.popT > 0 ? 1 + Math.sin((1 - this.popT / 0.25) * Math.PI) * 0.08 : 1;
    this.root.scale.setScalar(s);
    this.root.rotation.y = this.angle;
    this.renderer.render(this.scene, this.camera);
  }
  start() {
    if (this.running) return; this.running = true;
    let last = performance.now();
    const loop = (now) => {
      if (!this.running) return;
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      this.angle += this.spinV * dt;
      if (this.spinV > 0.35) this.spinV = Math.max(0.35, this.spinV - dt * 3); else if (this.spinV < -0.35) this.spinV = Math.min(-0.35, this.spinV + dt * 3);
      if (this.popT > 0) this.popT -= dt;
      if (this.model) { this.wig = (this.wig || 0) + dt; this.model.update(dt, Math.sin(this.wig * 1.3) * 0.6, 0, 0.38); }   // front wheels and steering wheel turn gently
      this.draw();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
  stop() { this.running = false; }
}
