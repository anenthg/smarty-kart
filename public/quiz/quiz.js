// After-race quiz, shared by Smarty Kart and Neon Racer (TV side).
// Five general-knowledge questions (public/quiz/questions.json, from the owner's SKGKO Class 3 practice set), one each from five
// different sections, answer order shuffled, no question repeats until all 100 have been asked (sections with unseen questions are preferred).
// The answers are four giant item boxes on the track; each player's kart drives into the box they pick on their phone
// (or with the TV remote). Right = the box bursts into confetti and the kid earns a star; wrong = a gentle spin-out and the
// right box lights up. The next race unlocks only when every player has attempted all five; stars become bonus coins.
// Built for the TV: 4 box meshes + 1 Points draw for confetti, canvas textures made once per question, DOM text at question
// changes only.

const SHAPES = ['▲', '◆', '●', '■'];
const COLORS = ['#e8202a', '#1f7bff', '#e0a800', '#1fa64a'];
const N_Q = 5;
const T_INTRO = 2.8, T_DRIVE = 1.1, T_REVEAL = 3.4, T_DONE = 4.2;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const ease = (x) => x * x * (3 - 2 * x);

let bankP = null;
const loadBank = () => bankP || (bankP = fetch('/quiz/questions.json').then((r) => r.json()));

export class Quiz {
  constructor(o) {
    this.o = o; this.THREE = o.THREE;
    this.state = 'off'; this.pending = false; this.active = false; this.t = 0;
    this.qs = []; this.qi = 0; this.res = new Map();   // player id -> { stars, picks: [], name }
    this.buf = {}; this.voiceSrc = null; this.kbSel = 0;
    loadBank().catch(() => {});
    fetch('/quiz/audio/manifest.json').then((r) => r.ok ? r.json() : {}).then((m) => { this.audioMan = m; }).catch(() => { this.audioMan = {}; });
    if (!document.getElementById('quizcss')) {
      const l = document.createElement('link'); l.id = 'quizcss'; l.rel = 'stylesheet'; l.href = '/quiz/quiz.css'; document.head.appendChild(l);
    }
  }

  // ---------------------------------------------------------------- lifecycle
  get locked() { return this.pending || this.active; }
  // call when the race ends; start() follows after the podium/results moment
  arm() {
    const ps = this.o.players();
    this.pending = ps.length > 0;
    return this.pending;
  }
  async start() {
    if (!this.pending) return;
    const bank = await loadBank().catch(() => null);
    const ps = this.o.players();
    if (!bank || !ps.length) { this.pending = false; this.o.onDone && this.o.onDone(); return; }
    this.bank = bank;
    this.qs = this.pick(bank);
    this.qi = -1; this.res.clear();
    for (const p of ps) this.res.set(p.id, { stars: 0, picks: [], name: p.name, color: p.color });
    this.pending = false; this.active = true;
    this.buildScene(); this.buildDom();
    this.dom.root.classList.remove('hidden'); document.body.classList.add('quizzing');
    this.loadAudio();
    this.setState('intro');
    this.o.onStart && this.o.onStart();
  }
  finish() {
    this.active = false; this.state = 'off';
    if (this.root3) this.root3.visible = false;
    if (this.dom) this.dom.root.classList.add('hidden');
    document.body.classList.remove('quizzing');
    for (const p of this.o.players()) if (p.car) p.car.group.visible = true;
    this.o.onDone && this.o.onDone();
    this.o.refreshPads();
  }
  cancel() { this.pending = false; if (this.active) { this.active = false; this.state = 'off'; if (this.root3) this.root3.visible = false; if (this.dom) this.dom.root.classList.add('hidden'); document.body.classList.remove('quizzing'); } }
  bonus(id) { const r = this.res.get(id); return r ? r.stars : 0; }

  // five sections out of six (random), one unseen question from each; seen-list per section in localStorage
  pick(bank) {
    let seen = []; try { seen = JSON.parse(localStorage.getItem('kr_quiz_seen') || '[]'); } catch {}
    if (bank.questions.filter((q) => !seen.includes(q.n)).length < N_Q) seen = [];   // all asked: start a fresh round
    const bySec = {};
    for (const q of bank.questions) if (!seen.includes(q.n)) (bySec[q.sec] = bySec[q.sec] || []).push(q);
    // one question from each of five different sections where possible; top up from any section once the small ones run out
    const chosen = [];
    for (const s of shuffle(Object.keys(bySec)).slice(0, N_Q)) chosen.push(bySec[s].splice(Math.floor(Math.random() * bySec[s].length), 1)[0]);
    const rest = shuffle(Object.values(bySec).flat());
    while (chosen.length < N_Q) chosen.push(rest.pop());
    const out = [];
    for (const q of shuffle(chosen)) {
      seen.push(q.n);
      const order = shuffle([0, 1, 2, 3]);
      out.push({ n: q.n, q: q.q, sec: q.sec, cat: bank.sections[q.sec], opts: order.map((i) => q.o[i]), correct: order.indexOf(q.a), answer: q.o[q.a], why: q.why || '' });
    }
    try { localStorage.setItem('kr_quiz_seen', JSON.stringify(seen)); } catch {}
    return out;
  }

  // ---------------------------------------------------------------- players / answers
  required() { const ids = new Set(this.o.players().map((p) => p.id)); return [...this.res.keys()].filter((id) => ids.has(id)); }
  answer(id, k) {
    if (this.state !== 'ask' || !this.res.has(id) || k < 0 || k > 3) return;
    const r = this.res.get(id);
    if (r.picks[this.qi] !== undefined) return;
    r.picks[this.qi] = k;
    this.o.sfx && this.o.sfx('select');
    this.renderPlayers(); this.o.refreshPads();
  }
  allAnswered() { const req = this.required(); return req.length > 0 && req.every((id) => this.res.get(id).picks[this.qi] !== undefined); }
  key(e) {
    if (!this.active) return false;
    if (!this.res.has('kb')) return e.key === 'Enter' || e.code === 'Enter';   // swallow OK during the quiz
    const k = e.key;
    if (this.state === 'ask' && this.res.get('kb').picks[this.qi] === undefined) {
      if (k === 'ArrowLeft' || k === 'ArrowUp') { this.kbSel = (this.kbSel + 3) % 4; this.o.sfx && this.o.sfx('tick'); }
      else if (k === 'ArrowRight' || k === 'ArrowDown') { this.kbSel = (this.kbSel + 1) % 4; this.o.sfx && this.o.sfx('tick'); }
      else if (k === 'Enter' || e.code === 'NumpadEnter') this.answer('kb', this.kbSel);
      else return false;
      this.renderPlayers();
      return true;
    }
    return ['Enter', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(k);
  }
  // what a phone should show during the quiz (merged into the game's normal state message)
  padState(p, base) {
    if (this.pending) return { ...base, phase: 'results', locked: true, title: base.title, sub: '🧠 Quiz time next! Answer 5 questions to unlock the next race.' };
    if (!this.active) return null;
    const r = this.res.get(p.id);
    if (!r) return { ...base, phase: 'quizwait', title: 'Quiz time!', sub: 'The racers are answering questions. You can join the next race.' };
    const q = this.qs[this.qi];
    const st = { ...base, phase: 'quiz', status: `🧠 ${Math.max(1, this.qi + 1)}/${N_Q} · ⭐ ${r.stars}`, stars: r.stars, of: N_Q };
    if (this.state === 'intro' || !q) return { ...st, qstate: 'intro' };
    if (this.state === 'done') return { ...st, qstate: 'done', waiting: [] };
    const pick = r.picks[this.qi];
    const reveal = this.state === 'reveal' || this.state === 'drive';
    return { ...st, qstate: this.state === 'ask' ? (pick === undefined ? 'ask' : 'locked') : 'reveal', qi: this.qi, q: q.q, cat: q.cat.icon + ' ' + q.cat.name, opts: q.opts,
      pick: pick === undefined ? -1 : pick, correct: this.state === 'reveal' ? q.correct : -1,
      waiting: this.state === 'ask' ? this.required().filter((id) => this.res.get(id).picks[this.qi] === undefined && id !== p.id).map((id) => this.res.get(id).name) : [],
      ok: reveal && pick === q.correct };
  }

  // ---------------------------------------------------------------- state machine
  setState(s) {
    this.state = s; this.t = 0;
    const d = this.dom, q = this.qs[this.qi];
    if (s === 'intro') {
      this.banner('🧠 QUIZ TIME!', 'Answer all 5 questions to unlock the next race', 'big'); d.card.classList.add('hidden');
      this.boxesVisible(false); this.voice('quiz_start');
    } else if (s === 'ask') {
      this.qi++;
      const nq = this.qs[this.qi];
      this.banner(); d.card.classList.remove('hidden');
      d.cat.textContent = `${nq.cat.icon} ${nq.cat.name.toUpperCase()} · QUESTION ${this.qi + 1} OF ${N_Q}`;
      d.qtext.textContent = nq.q;
      d.why.textContent = ''; d.why.classList.add('hidden');
      this.drawBoxes(nq); this.boxesVisible(true); this.kbSel = 0;
      this.placeKarts();
      if (this.qi === N_Q - 1) { this.voice('last'); setTimeout(() => { if (this.state === 'ask' && this.qs[this.qi] === nq) this.voice('q' + nq.n); }, 1300); }
      else this.voice('q' + nq.n);
      this.o.sfx && this.o.sfx('itembox');
    } else if (s === 'drive') {
      this.o.sfx && this.o.sfx('whoosh');
    } else if (s === 'reveal') {
      let anyWrong = false, anyRight = false;
      for (const id of this.required()) {
        const r = this.res.get(id), ok = r.picks[this.qi] === q.correct;
        if (ok) { r.stars++; anyRight = true; } else anyWrong = true;
      }
      for (const k of this.karts) {
        const ok = k.pick === q.correct;
        k.ok = ok; k.t0 = 0;
        if (ok) { this.burst(this.boxes[k.pick]); this.o.onCheer && this.o.onCheer(k.car); }
        else this.o.onSpin && this.o.onSpin(k.car);
      }
      this.boxes.forEach((b, i) => { b.userData.glow = i === q.correct; });
      const solo = this.karts.length === 1;
      d.card.classList.add('hidden');   // the result takes the card's place so the boxes stay visible
      if (solo) this.banner(anyRight ? '⭐ CORRECT! +1 STAR' : 'GOOD TRY!', anyRight ? '' : `The answer is ${q.answer}`, anyRight ? 'ok' : 'try');
      else this.banner(anyWrong ? `The answer is ${q.answer}` : '⭐ EVERYONE GOT IT!', this.karts.map((k) => `${k.name} ${k.ok ? '⭐' : '💫'}`).join('   '), anyWrong ? 'try' : 'ok');
      if (q.why) { d.why.textContent = '💡 ' + q.why; d.why.classList.remove('hidden'); }
      this.o.sfx && this.o.sfx(anyRight && !anyWrong ? 'correct' : anyRight ? 'correct' : 'wrong');
      if (anyWrong) this.voice('a' + q.n); else this.voice('ok' + (1 + Math.floor(Math.random() * 4)));
      this.renderDots();
    } else if (s === 'done') {
      d.card.classList.add('hidden'); this.boxesVisible(false);
      const rs = this.required().map((id) => this.res.get(id));
      const perfect = rs.length && rs.every((r) => r.stars === N_Q);
      this.banner('🏁 QUIZ COMPLETE! RACE UNLOCKED!', rs.map((r) => `${r.name}: ${'⭐'.repeat(r.stars)}${'☆'.repeat(N_Q - r.stars)}`).join('    ') + '<br><small>Every star = a bonus coin 🪙 at the start of the next race</small>', 'ok big', true);
      this.voice(perfect ? 'perfect' : 'done');
      this.o.sfx && this.o.sfx('win');
      if (this.karts) for (const k of this.karts) this.o.onCheer && this.o.onCheer(k.car);
    }
    this.renderPlayers();
    this.o.refreshPads();
  }

  update(dt, t) {
    if (!this.active) return;
    this.t += dt;
    const s = this.state;
    if (s === 'intro' && this.t > T_INTRO) this.setState('ask');
    else if (s === 'ask') {
      if (!this.required().length) { this.finish(); return; }   // everyone left
      if (this.allAnswered() && this.t > 0.6) {
        for (const k of this.karts) k.pick = this.res.get(k.id).picks[this.qi];
        this.setState('drive');
      }
    } else if (s === 'drive' && this.t > T_DRIVE) this.setState('reveal');
    else if (s === 'reveal' && this.t > T_REVEAL) { if (this.qi < N_Q - 1) this.setState('ask'); else this.setState('done'); }
    else if (s === 'done' && this.t > T_DONE) { this.finish(); return; }
    this.animate(dt, t);
  }

  // ---------------------------------------------------------------- 3D: boxes, karts, confetti, camera
  buildScene() {
    const THREE = this.THREE, o = this.o, tr = o.track;
    const S0 = this.S0 = o.s0 || 30, gap = this.gap = Math.min(4.4, Math.max(2.6, tr.roadHalf * 0.38)), size = Math.min(3.7, gap * 0.86);
    this.size = size;
    if (!this.root3) {
      this.root3 = new THREE.Group(); o.scene.add(this.root3);
      this.cvs = []; this.texs = []; this.boxes = [];
      const geo = new THREE.BoxGeometry(size, size, size);
      for (let i = 0; i < 4; i++) {
        const c = document.createElement('canvas'); c.width = c.height = 256;
        const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.NoColorSpace;
        const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex, fog: false }));
        this.cvs.push(c); this.texs.push(tex); this.boxes.push(m); this.root3.add(m);
      }
      // confetti: one Points draw
      const n = 160, pos = new Float32Array(n * 3).fill(-999), col = new Float32Array(n * 3);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      this.conf = { pts: new THREE.Points(g, new THREE.PointsMaterial({ size: 0.42, vertexColors: true, fog: false })), pos, col, vel: new Float32Array(n * 3), life: new Float32Array(n), n, head: 0 };
      this.conf.pts.frustumCulled = false; this.root3.add(this.conf.pts);
    }
    const h = tr.at(S0 + 10, 0).h;
    this.boxes.forEach((b, i) => {
      const p = tr.at(S0 + 10, (i - 1.5) * gap);
      b.userData = { x: p.x, z: p.z, h, gone: 0, glow: false, scale: 1 };
      b.position.set(p.x, 1.6, p.z); b.rotation.set(0, h + Math.PI, 0); b.visible = false;
    });
    this.root3.visible = true; this.camCfg = null;
    // karts: one per player, spread across the road at the start mark
    const ps = this.o.players().filter((p) => this.res.has(p.id) && p.car);
    this.karts = ps.map((p, i) => ({ id: p.id, name: p.name, car: p.car, lat: (i - (ps.length - 1) / 2) * 2.6, pick: -1, ok: false }));
  }
  placeKarts() { for (const k of this.karts) { k.pick = -1; k.ok = false; } }
  boxesVisible(v) { if (!this.boxes) return; this.boxes.forEach((b) => { b.visible = v; b.userData.gone = 0; b.userData.glow = false; b.userData.rise = v ? 0 : 1; b.scale.setScalar(1); }); }
  drawBoxes(q) {
    q.opts.forEach((txt, i) => {
      const c = this.cvs[i], g = c.getContext('2d'), col = COLORS[i];
      g.clearRect(0, 0, 256, 256);
      const gr = g.createLinearGradient(0, 0, 256, 256); gr.addColorStop(0, '#ffffff'); gr.addColorStop(1, '#dfe8ff');
      g.fillStyle = gr; g.fillRect(0, 0, 256, 256);
      g.lineWidth = 18; g.strokeStyle = col; g.strokeRect(9, 9, 238, 238);
      g.fillStyle = col; g.font = '900 64px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(SHAPES[i], 128, 62);
      // answer text, wrapped to fit (up to 3 lines)
      let fs = 40, lines;
      const wrap = () => { g.font = `900 ${fs}px system-ui, sans-serif`; const words = String(txt).split(' '); lines = ['']; for (const w of words) { const t = lines[lines.length - 1] ? lines[lines.length - 1] + ' ' + w : w; if (g.measureText(t).width > 214 && lines[lines.length - 1]) lines.push(w); else lines[lines.length - 1] = t; } };
      for (wrap(); (lines.length > 3 || lines.some((l) => g.measureText(l).width > 214)) && fs > 18; fs -= 2) wrap();
      const lh = fs * 1.1, top = 178 - (lines.length - 1) * lh / 2;
      g.fillStyle = col; const ph = lines.length * lh + 18; g.beginPath(); g.roundRect ? g.roundRect(18, top - lh / 2 - 9, 220, ph, 16) : g.rect(18, top - lh / 2 - 9, 220, ph); g.fill();
      g.fillStyle = '#fff'; lines.forEach((l, j) => g.fillText(l, 128, top + j * lh));
      this.texs[i].needsUpdate = true;
    });
  }
  burst(box) {
    const C = this.conf, cols = [[1, 0.3, 0.3], [1, 0.84, 0.15], [0.25, 0.85, 0.35], [0.3, 0.6, 1], [1, 0.45, 0.8], [1, 1, 1]];
    box.userData.gone = 0.001;
    for (let k = 0; k < 70; k++) {
      const i = C.head; C.head = (C.head + 1) % C.n;
      C.pos[i * 3] = box.position.x; C.pos[i * 3 + 1] = box.position.y; C.pos[i * 3 + 2] = box.position.z;
      const a = Math.random() * Math.PI * 2, sp = 3 + Math.random() * 6;
      C.vel[i * 3] = Math.cos(a) * sp; C.vel[i * 3 + 1] = 4 + Math.random() * 7; C.vel[i * 3 + 2] = Math.sin(a) * sp;
      const c = cols[k % cols.length]; C.col[i * 3] = c[0]; C.col[i * 3 + 1] = c[1]; C.col[i * 3 + 2] = c[2];
      C.life[i] = 1.6 + Math.random() * 1.2;
    }
    C.pts.geometry.attributes.color.needsUpdate = true;
    this.o.sfx && this.o.sfx('coin');
  }
  animate(dt, t) {
    const tr = this.o.track, S0 = this.S0, cam = this.o.camera;
    // camera: behind the karts, looking at the boxes
    // framing tuned on Smarty Kart's wide road; narrower roads (Neon) pull the camera in so the boxes stay big
    const f = Math.max(0.55, Math.min(1, (3 * this.gap + this.size) / 16.9));
    const C0 = this.camCfg || (this.camCfg = { back: 2 + 9 * f, y: 2.4 + 2.8 * f, lookY: 2.0 + 0.6 * f, fov: 52 });
    const cp = tr.at(S0 - C0.back + Math.sin(t * 0.4) * 0.3, Math.sin(t * 0.3) * 0.5); cam.position.set(cp.x, C0.y, cp.z);
    const lp = tr.at(S0 + 10, 0); cam.lookAt(lp.x, C0.lookY, lp.z);
    if (Math.abs(cam.fov - C0.fov) > 0.05) { cam.fov = C0.fov; cam.updateProjectionMatrix(); }
    // boxes: rise in, bob, gently turn; the right one glows during the reveal; smashed ones pop away
    this.boxes.forEach((b, i) => {
      const u = b.userData; if (!b.visible) return;
      u.rise = Math.min(1, (u.rise || 0) + dt * 2.4);
      let s = ease(u.rise);
      if (u.gone) { u.gone += dt; s *= Math.max(0, 1 + u.gone * 2.5 - u.gone * u.gone * 18); if (u.gone > 0.35) s = 0; }
      if (u.glow && !u.gone) s *= 1.18 + Math.sin(t * 10) * 0.06;
      const sel = this.state === 'ask' && this.res.has('kb') && this.res.get('kb').picks[this.qi] === undefined && this.kbSel === i;
      b.scale.setScalar(Math.max(0.001, s * (sel ? 1.12 : 1)));
      b.position.y = 2.0 + Math.sin(t * 2 + i) * 0.12 + (sel ? 0.25 : 0);
      b.rotation.y = u.h + Math.PI + Math.sin(t * 0.9 + i) * 0.1;
      b.material.color.setScalar(u.glow ? 1.0 : (this.state === 'reveal' ? 0.6 : 1));
    });
    // karts
    const st = this.state, T = this.t;
    for (const k of this.karts) {
      const g = k.car.group;
      const start = tr.at(S0, k.lat); let x = start.x, z = start.z, h = start.h, y = 0, spin = 0;
      if ((st === 'drive' || st === 'reveal') && k.pick >= 0) {
        const bx = this.boxes[k.pick].userData;
        const tgt = tr.at(S0 + 10 - this.size * 0.9, (k.pick - 1.5) * this.gap);
        const u = st === 'drive' ? ease(Math.min(1, T / T_DRIVE)) : 1;
        x = start.x + (tgt.x - start.x) * u; z = start.z + (tgt.z - start.z) * u;
        h = Math.atan2(tgt.x - start.x, tgt.z - start.z) * (1 - u * 0.6) + bx.h * u * 0.6;
        if (st === 'drive') y = Math.max(0, Math.sin(Math.max(0, (u - 0.75) / 0.25) * Math.PI)) * 0.9;
        if (st === 'reveal') {
          if (k.ok) { spin = ease(Math.min(1, T / 0.9)) * Math.PI * 2; y = Math.abs(Math.sin(Math.min(T, 1.2) * Math.PI / 0.6)) * 0.5; }
          else { const b = ease(Math.min(1, T / 0.8)); const back = tr.at(S0 + 10 - this.size * 0.9 - 4.5 * b, (k.pick - 1.5) * this.gap);
            x = back.x; z = back.z; spin = b * Math.PI * 4; y = Math.sin(Math.min(1, T / 0.5) * Math.PI) * 0.6; }
        }
      }
      k.car.x = x; k.car.z = z; k.car.h = h;
      g.position.set(x, y, z); g.rotation.set(0, h + spin, 0); g.visible = true;
      if (k.car.tag) k.car.tag.visible = false;   // the name tag would cover the boxes; names are in the corner panel
    }
    // everyone else hides during the quiz
    const mine = new Set(this.karts.map((k) => k.car));
    for (const c of this.o.cars()) if (!mine.has(c)) { c.group.visible = false; if (c.tag) c.tag.visible = false; }
    // confetti
    const C = this.conf; let any = false;
    for (let i = 0; i < C.n; i++) {
      if (C.life[i] <= 0) continue;
      C.life[i] -= dt; any = true;
      if (C.life[i] <= 0) { C.pos[i * 3 + 1] = -999; continue; }
      C.vel[i * 3 + 1] -= 9 * dt; C.vel[i * 3] *= 0.985; C.vel[i * 3 + 2] *= 0.985;
      C.pos[i * 3] += C.vel[i * 3] * dt; C.pos[i * 3 + 1] = Math.max(0.05, C.pos[i * 3 + 1] + C.vel[i * 3 + 1] * dt); C.pos[i * 3 + 2] += C.vel[i * 3 + 2] * dt;
    }
    if (any || this._confAny) C.pts.geometry.attributes.position.needsUpdate = true;
    this._confAny = any;
  }

  // ---------------------------------------------------------------- DOM (question card, banner, players)
  buildDom() {
    if (this.dom) { this.dom.root.className = `quiz qz-${this.o.theme} ui hidden`; this.renderDots(); return; }
    const root = document.createElement('div'); root.className = `quiz qz-${this.o.theme} ui hidden`;
    root.innerHTML = `<div class="qz-top"><div class="qz-badge">🧠 QUIZ TIME · answer all 5 to unlock the next race</div><div class="qz-dots"></div></div>
      <div class="qz-card hidden"><div class="qz-cat"></div><div class="qz-q"></div></div>
      <div class="qz-banner hidden"><div class="qz-b1"></div><div class="qz-b2"></div></div>
      <div class="qz-why hidden"></div>
      <div class="qz-players"></div><div class="qz-hint"></div>`;
    document.body.appendChild(root);
    const $ = (s) => root.querySelector(s);
    this.dom = { root, dots: $('.qz-dots'), card: $('.qz-card'), cat: $('.qz-cat'), qtext: $('.qz-q'), banner: $('.qz-banner'), b1: $('.qz-b1'), b2: $('.qz-b2'), why: $('.qz-why'), players: $('.qz-players'), hint: $('.qz-hint') };
    this.renderDots();
  }
  banner(t1, t2 = '', kind = '', html = false) {
    const d = this.dom; if (!t1) { d.banner.classList.add('hidden'); return; }
    d.banner.className = 'qz-banner ' + kind; d.b1.textContent = t1;
    if (html) d.b2.innerHTML = t2; else d.b2.textContent = t2;
    void d.banner.offsetWidth; d.banner.classList.add('pop');
  }
  renderDots() {
    const r = this.res.get(this.required()[0]) || { picks: [] };
    let h = '';
    for (let i = 0; i < N_Q; i++) {
      const q = this.qs[i], p = r.picks[i];
      const done = q && p !== undefined && (i < this.qi || (i === this.qi && this.state === 'reveal'));
      h += `<i class="${done ? (p === q.correct ? 'ok' : 'no') : i === this.qi ? 'now' : ''}"></i>`;
    }
    this.dom.dots.innerHTML = h;
  }
  renderPlayers() {
    if (!this.dom) return;
    const ask = this.state === 'ask';
    this.dom.players.innerHTML = this.required().map((id) => {
      const r = this.res.get(id), picked = r.picks[this.qi] !== undefined;
      return `<div class="qz-pl" style="--c:${esc(r.color || '#fff')}">${esc(r.name.toUpperCase())} ${'⭐'.repeat(r.stars)}<small>${ask ? (picked ? '✓ locked in' : 'thinking…') : '&nbsp;'}</small></div>`;
    }).join('');
    this.dom.hint.textContent = this.res.has('kb') && ask ? 'Remote: ◀ ▶ choose a box · OK to answer' : '🔊 Answer on your phone';
    this.renderDots();
  }

  // ---------------------------------------------------------------- audio (announcer clips; decoded with the game's AudioContext)
  loadAudio() {
    const names = ['quiz_start', 'ok1', 'ok2', 'ok3', 'ok4', 'last', 'done', 'perfect'];
    for (const q of this.qs) names.push('q' + q.n, 'a' + q.n);
    for (const n of names) {
      if (this.buf[n] || (this.audioMan && !(n in this.audioMan))) continue;
      fetch(`/quiz/audio/${n}.mp3`).then((r) => r.ok ? r.arrayBuffer() : null).then((ab) => {
        const ctx = this.o.audioCtx(); if (!ab || !ctx) return;
        ctx.decodeAudioData(ab, (b) => { this.buf[n] = b; if (this.wantVoice === n) this.voice(n); }, () => {});
      }).catch(() => {});
    }
  }
  voice(n) {
    const ctx = this.o.audioCtx(), b = this.buf[n];
    this.wantVoice = b ? null : n;   // not decoded yet: play it as soon as it is (if still current)
    if (!ctx || ctx.state !== 'running' || !b) return;
    if (this.voiceSrc) { try { this.voiceSrc.stop(); } catch {} }
    const s = ctx.createBufferSource(), g = ctx.createGain(); g.gain.value = 1.1;
    s.buffer = b; s.connect(g); g.connect(this.o.audioOut() || ctx.destination); s.start();
    this.voiceSrc = s;
  }
}
