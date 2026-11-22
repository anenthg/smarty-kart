// Smarty Kart racers, shared by the TV and the phones.
// Physics follow Mario Kart 3.js: speed eases towards maxV (rate = acc), turning is a yaw rate that scales with speed,
// drifting biases the turn by ±1.4 like its driftDirection. Values are small multipliers around 1 so balance is easy.
export const RACERS = {
  ruby:  { name: 'Ruby',  color: '#e8202a', tag: 'All-rounder',     stats: { speed: 3, accel: 3, handling: 3 }, phys: { maxV: 31,   acc: 1.6, turn: 1.0,  mass: 1.0 } },
  lime:  { name: 'Lime',  color: '#2bb34a', tag: 'Turns tight',     stats: { speed: 3, accel: 3, handling: 5 }, phys: { maxV: 30.5, acc: 1.6, turn: 1.15, mass: 0.95 } },
  sunny: { name: 'Sunny', color: '#ffc21a', tag: 'Fast off the line', stats: { speed: 2, accel: 5, handling: 3 }, phys: { maxV: 30.5, acc: 2.0, turn: 1.05, mass: 0.9 } },
  plum:  { name: 'Plum',  color: '#8a3dcc', tag: 'Top speed, heavy', stats: { speed: 5, accel: 2, handling: 2 }, phys: { maxV: 32.5, acc: 1.4, turn: 0.95, mass: 1.4 } },
};
export const RACER_IDS = Object.keys(RACERS);
export const sanitizeRacer = (id) => (RACERS[id] ? id : 'ruby');

// Kart parts (Mario Kart style): each nudges the stats a little, so there's no wrong choice.
// mod: speed / accel / handling / offroad in "bar" steps; weight adds to the racer's mass.
export const BODIES = {
  classic: { name: 'Classic', icon: '🏎️', tag: 'all-round',    mod: {} },
  buggy:   { name: 'Buggy',   icon: '🛻', tag: '+zoom −speed', mod: { speed: -1, accel: 1, offroad: 1 }, weight: 0.1 },
  rocket:  { name: 'Rocket',  icon: '🚀', tag: '+speed −turn', mod: { speed: 1, handling: -1 }, weight: 0.1 },
  bubble:  { name: 'Bubble',  icon: '🛁', tag: '+turn, light', mod: { handling: 1 }, weight: -0.15 },
};
export const WHEELS = {
  standard: { name: 'Standard', icon: '⚫', tag: 'all-round',    mod: {} },
  big:      { name: 'Big',      icon: '🛞', tag: 'sand is easy', mod: { offroad: 2, accel: -1 }, weight: 0.15 },
  slick:    { name: 'Slick',    icon: '🔴', tag: '+speed −sand', mod: { speed: 1, offroad: -1 } },
  roller:   { name: 'Roller',   icon: '🩷', tag: '+zoom +turn',  mod: { accel: 1, handling: 1, speed: -1 }, weight: -0.1 },
};
export const BODY_IDS = Object.keys(BODIES), WHEEL_IDS = Object.keys(WHEELS);
// paint: '' = the racer's own colour, otherwise one of these
export const KPAINTS = ['', '#e8202a', '#ff8a1a', '#ffc21a', '#2bb34a', '#1f7bff', '#ff5fb0', '#8a3dcc', '#f2f2f2', '#2a2a30'];

const HEX = /^#[0-9a-f]{6}$/i;
export function sanitizeKart(c = {}) {
  return {
    racer: sanitizeRacer(c.racer),
    body: BODIES[c.body] ? c.body : 'classic',
    wheels: WHEELS[c.wheels] ? c.wheels : 'standard',
    kpaint: HEX.test(c.kpaint || '') ? c.kpaint : '',
  };
}
export const kartColor = (k) => k.kpaint || RACERS[sanitizeRacer(k.racer)].color;
const mods = (k) => { const b = BODIES[k.body] || BODIES.classic, w = WHEELS[k.wheels] || WHEELS.standard; return [(key) => (b.mod[key] || 0) + (w.mod[key] || 0), (b.weight || 0) + (w.weight || 0)]; };

// stats as bars 1..5 (with the racer's own values in .base, so the phone can show what the parts changed)
export function kartStats(k) {
  const r = RACERS[sanitizeRacer(k.racer)], [m] = mods(k), c = (v) => Math.max(1, Math.min(5, v));
  return { speed: c(r.stats.speed + m('speed')), accel: c(r.stats.accel + m('accel')), handling: c(r.stats.handling + m('handling')), offroad: c(3 + m('offroad')),
    base: { speed: r.stats.speed, accel: r.stats.accel, handling: r.stats.handling, offroad: 3 } };
}
export function kartPhys(k) {
  const r = RACERS[sanitizeRacer(k.racer)], [m, wt] = mods(k);
  return {
    maxV: r.phys.maxV + 0.55 * m('speed'),
    acc: r.phys.acc * (1 + 0.1 * m('accel')),
    turn: r.phys.turn * (1 + 0.06 * m('handling')),
    mass: Math.max(0.6, r.phys.mass + wt),
    offroad: 0.5 + 0.07 * m('offroad'),       // top-speed multiplier on sand (standard parts: 0.5)
  };
}

// Items, Mario Kart style. Counts (×3) come from the roll table on the TV.
export const ITEM_ICONS = { banana: '🍌', green: '🟢', red: '🔴', mushroom: '🍄', star: '⭐', bullet: '🚀', coin: '🪙', horn: '📯' };
export const ITEM_NAMES = { banana: 'Banana', green: 'Green Shell', red: 'Red Shell', mushroom: 'Mushroom', star: 'Star', bullet: 'Bullet', coin: 'Coins', horn: 'Super Horn' };
