// Phone garage: live 3D turntable of the chosen car with its paint job. Drag to spin.
// Uses exactly the same materials as the TV (matcap paint, dark-gloss detail, textured wheels),
// so what the kid paints here is what appears on the TV.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { CARS, makePaintMaterial, loadMatcaps } from '/js/garage-data.js';

THREE.ColorManagement.enabled = false;

export class GaragePreview {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.scene = new THREE.Scene();

    const c = document.createElement('canvas'); c.width = c.height = 128;
    const g = c.getContext('2d'), r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(0.5, 'rgba(255,255,255,0.35)'); r.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = r; g.fillRect(0, 0, 128, 128);
    const glowTex = new THREE.CanvasTexture(c);
    this.disc = new THREE.Mesh(new THREE.CircleGeometry(3.4, 48).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x0b0920 }));
    this.scene.add(this.disc);
    this.glow = new THREE.Mesh(new THREE.PlaneGeometry(4.2, 6.6).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: glowTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.glow.position.y = 0.01; this.scene.add(this.glow);
    this.shadow = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 5).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: glowTex, color: 0x000000, transparent: true, opacity: 0.8, depthWrite: false }));
    this.shadow.position.y = 0.012; this.scene.add(this.shadow);

    this.pivot = new THREE.Group(); this.scene.add(this.pivot);
    this.camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
    this.loader = new GLTFLoader(); this.cache = {}; this.cur = null; this.carId = null;
    this.angle = 0.7; this.vel = 0.35; this.drag = null; this.running = false; this.last = 0; this.spin = 0;
    this.matcaps = loadMatcaps(THREE);

    canvas.addEventListener('pointerdown', (e) => { this.drag = { x: e.clientX, a: this.angle }; canvas.setPointerCapture(e.pointerId); this.vel = 0; });
    canvas.addEventListener('pointermove', (e) => { if (!this.drag) return; const na = this.drag.a + (e.clientX - this.drag.x) * 0.012; this.vel = (na - this.angle) * 30; this.angle = na; });
    const end = () => { this.drag = null; if (Math.abs(this.vel) < 0.2) this.vel = 0.35; };
    canvas.addEventListener('pointerup', end); canvas.addEventListener('pointercancel', end);
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    this.loop = this.loop.bind(this);
  }
  resize() {
    const w = this.canvas.parentElement.clientWidth, h = this.canvas.parentElement.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    const dist = this.camera.aspect > 1.15 ? 10 : 11.5 / Math.max(0.6, this.camera.aspect);
    this.camera.position.set(0, dist * 0.3, dist);
    this.camera.lookAt(0, 0.35, 0);
    this.camera.updateProjectionMatrix();
  }
  async load(id) {
    if (!this.cache[id]) {
      this.cache[id] = Promise.all([this.loader.loadAsync('/assets/' + CARS[id].file), this.matcaps]).then(([gltf, mc]) => {
        const root = gltf.scene;
        root.traverse((o) => {
          if (!o.isMesh) return;
          const n = o.material.name;
          if (n === 'Detail') o.material = new THREE.MeshMatcapMaterial({ matcap: mc.detail, vertexColors: true });
          else if (n === 'Wheel') {
            const t = o.material.map; t.colorSpace = THREE.NoColorSpace; t.center.set(0.5, 0.5);
            o.material = new THREE.MeshBasicMaterial({ map: t, vertexColors: true });
          }
        });
        return root;
      });
    }
    return this.cache[id];
  }
  async set(cfg) {
    this.cfg = { ...cfg };
    const id = cfg.car, tpl = await this.load(id);
    const mc = await this.matcaps;
    if (this.cfg.car !== id) return;   // a newer choice arrived while loading
    if (this.carId !== id) {
      if (this.cur) this.pivot.remove(this.cur);
      this.cur = tpl; this.carId = id;
      this.pivot.add(this.cur);
      this.pop = 1;
    }
    const old = this.paint;
    this.paint = makePaintMaterial(THREE, this.cfg, mc);
    this.cur.traverse((o) => { if (o.isMesh && o.material.name === 'Paint') o.material = this.paint; });
    old?.dispose();
    const glowOn = this.cfg.glow !== 'off';
    this.glow.visible = glowOn;
    if (glowOn) this.glow.material.color.set(this.cfg.glow);
    if (!this.running) this.renderOnce();
  }
  start() { if (this.running) return; this.running = true; this.resize(); this.last = performance.now(); requestAnimationFrame(this.loop); }
  stop() { this.running = false; }
  renderOnce() { this.resize(); this.renderer.render(this.scene, this.camera); }
  loop(now) {
    if (!this.running) return;
    requestAnimationFrame(this.loop);
    const dt = Math.min(0.05, (now - this.last) / 1000); this.last = now;
    if (!this.drag) { this.angle += this.vel * dt; this.vel += (0.35 - this.vel) * Math.min(1, dt * 1.5); }
    this.pivot.rotation.y = this.angle;
    this.glow.rotation.y = this.shadow.rotation.y = this.angle;
    if (this.pop > 0) { this.pop = Math.max(0, this.pop - dt * 4); const s = 1 - 0.15 * Math.sin(this.pop * Math.PI); this.pivot.scale.setScalar(s); this.pivot.position.y = this.pop * 0.4; }
    this.renderer.render(this.scene, this.camera);
  }
}
