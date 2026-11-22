// Difficulty levels, shared by Smarty Kart, Neon Racer and the phone controller.
// One level per race, chosen in the lobby (TV remote ◀ ▶ or any phone) and remembered by the TV (localStorage kr_level).
// Normal = how the games played before levels existed. Levels change the computer racers and how much the game helps
// the kid; the kid's own kart handles the same on every level.
export const LEVELS = {
  easy: {
    name: 'Easy', icon: '🐢', cc: '50cc',
    bot: { start: 0.84, even: 0.8, ahead: 0.62, behind: 0.98 },   // speed multipliers: level with / far ahead of / far behind the kids
    drift: 0.02,          // chance per frame a bot starts a drift in a big corner (normal 0.08)
    itemUse: 0.4,         // how eagerly bots use items
    noRedAtKids: true,    // bots never get red shells / homing orbs
    assist: 1.7,          // steering help for the kid (multiplier)
    wallLoss: 0.45,       // share of the usual speed lost on a wall hit; no stun
    offroad: 0.5,         // share of the usual sand slowdown
    luck: 0.35,           // kids roll items as if further back in the pack
  },
  normal: {
    name: 'Normal', icon: '🐰', cc: '100cc',
    bot: { start: 0.9, even: 0.92, ahead: 0.82, behind: 1.06 },
    drift: 0.08, itemUse: 1, noRedAtKids: false, assist: 1, wallLoss: 1, offroad: 1, luck: 0,
  },
  hard: {
    name: 'Hard', icon: '🔥', cc: '150cc',
    bot: { start: 0.97, even: 1.0, ahead: 0.92, behind: 1.14 },
    drift: 0.16, itemUse: 1.7, noRedAtKids: false, assist: 0.6, wallLoss: 1, offroad: 1, luck: 0,
  },
};
export const LEVEL_IDS = ['easy', 'normal', 'hard'];
export const sanitizeLevel = (v) => (LEVEL_IDS.includes(v) ? v : 'normal');

// TV side: current level, remembered across visits
export function loadLevel() { try { return sanitizeLevel(localStorage.getItem('kr_level')); } catch { return 'normal'; } }
export function saveLevel(v) { try { localStorage.setItem('kr_level', v); } catch {} }

// bot speed multiplier from its distance to the leading kid (lead = −1e9 when no kid is racing)
export function botSpeedMul(L, u, lead) {
  const b = L.bot;
  return lead === -1e9 ? b.start + 0.05 : u > lead + 40 ? b.ahead : u < lead - 80 ? b.behind : b.even;
}

// HTML for the TV lobby strip (plain HTML; styled by .lvlstrip in each game's CSS)
export function levelStripHTML(cur, hint) {
  return `<span class="lab">LEVEL</span>` + LEVEL_IDS.map((id) => {
    const L = LEVELS[id];
    return `<span class="lv lv-${id}${id === cur ? ' on' : ''}">${L.icon} ${L.name.toUpperCase()}<small>${L.cc}</small></span>`;
  }).join('') + `<span class="rh">${hint}</span>`;
}
