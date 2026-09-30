/**
 * WHAT: Defines temporary Pong boosts, fair drops and one-slot ownership.
 * WHY: Both players must collect the same server-owned opportunities by contact.
 * HOW: Seeded mirrored drops, simulation-time expiry and bounded paddle modifiers.
 * WHO: The Pong service owns authoritative boosts and drop collection.
 */
const TYPES = Object.freeze(['speed', 'wide', 'power', 'shield', 'rush', 'curve', 'focus']);
const DURATIONS = Object.freeze({ speed: 5000, wide: 6000, power: 8000, shield: 10000, rush: 4000, curve: 8000, focus: 3000 });
const STORED = new Set(['power', 'shield', 'curve']);
const MAX_DEPTH = 110; // 22% of a half-court; never reach the centre.
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
function pool(mode, level, ruleset) {
  if (mode === 'pvp') return ruleset === 'power' ? TYPES : [];
  return TYPES.slice(0, Math.max(0, Math.min(TYPES.length, level - 1)));
}
function init(state, config) {
  // WHY: Older recovery snapshots acquire additive defaults without resetting
  // their score, elapsed time, level, player permissions or saved profile.
  state.ruleset ||= state.mode === 'computer' ? 'power' : 'classic';
  state.boosts ||= [{}, {}]; state.slots ||= [null, null]; state.drops ||= [];
  state.depths ||= [0, 0]; state.paddleVelocities ||= [0, 0];
  state.paddleWidths ||= [config.paddleHeight, config.aiPaddleHeight];
  state.nextDropAt ??= state.elapsedMs + 10000; state.dropSequence ||= 0;
  state.eventSequence ||= 0; state.events ||= []; state.spin ||= 0;
  state.behaviour ||= { hits: 0, meanOffset: 0, meanMotion: 0, collections: 0 };
}
function active(state, side, type) { return (state.boosts[side][type] || 0) > state.elapsedMs; }
function event(state, type, x, y, side = null, power = null) {
  state.events.push({ id: ++state.eventSequence, type, x, y, side, power, at: state.elapsedMs });
  state.events = state.events.filter(e => state.elapsedMs - e.at < 600).slice(-8);
}
function collect(state, side, type) {
  if (STORED.has(type)) {
    // A stored shield/shot never stacks or silently replaces another choice.
    if (state.slots[side]) return false;
    state.slots[side] = { type, until: state.elapsedMs + DURATIONS[type] };
  } else state.boosts[side][type] = state.elapsedMs + DURATIONS[type];
  if (side === 0) state.behaviour.collections++;
  event(state, 'pickup', side === 0 ? 28 + state.depths[0] : 972 - state.depths[1], state.paddles[side], side, type);
  return true;
}
function consume(state, side, type) {
  const slot = state.slots[side];
  if (slot?.type !== type || slot.until <= state.elapsedMs) return false;
  state.slots[side] = null; return true;
}
function update(state, config, inputs, dt, random) {
  for (const side of [0, 1]) {
    if (state.slots[side]?.until <= state.elapsedMs) state.slots[side] = null;
    const normal = side === 0 ? config.paddleHeight : config.aiPaddleHeight;
    const desired = normal * (active(state, side, 'wide') ? 1.35 : 1);
    const width = state.paddleWidths[side];
    state.paddleWidths[side] += clamp(desired - width, -normal * dt * 1.6, normal * dt * 1.6);
    const rush = active(state, side, 'rush');
    const forward = clamp(inputs[side]?.forward || 0, -1, 1);
    // Holding nothing retreats smoothly; a lost connection cannot leave a
    // paddle camping in the court. All motion stops when the game is paused.
    const velocity = rush && forward > 0 ? 170 : -220;
    state.depths[side] = clamp(state.depths[side] + velocity * dt, 0, MAX_DEPTH);
  }
  const available = pool(state.mode, state.level, state.ruleset);
  if (available.length && state.elapsedMs >= state.nextDropAt && state.drops.length === 0) {
    const type = available[Math.floor(random(state) * available.length)];
    const y = 85 + random(state) * 390, id = ++state.dropSequence;
    // Equal type, travel time and mirrored positions: neither end is favoured.
    state.drops = [0, 1].map(side => ({ id: `${id}-${side}`, type, side, x: side === 0 ? 460 : 540, y: side === 0 ? y : 560 - y, expiresAt: state.elapsedMs + 9000 }));
    state.nextDropAt = state.elapsedMs + 10000 + random(state) * (state.level >= 10 ? 4000 : 8000);
  }
  state.drops = state.drops.filter(drop => {
    drop.x += (drop.side === 0 ? -1 : 1) * 62 * dt;
    const x = drop.side === 0 ? 28 + state.depths[0] : 972 - state.depths[1];
    if (Math.abs(drop.x - x) < 23 && Math.abs(drop.y - state.paddles[drop.side]) < state.paddleWidths[drop.side] / 2 + 12) {
      if (collect(state, drop.side, drop.type)) return false;
    }
    return drop.expiresAt > state.elapsedMs && drop.x > 0 && drop.x < 1000;
  });
}
function view(state) {
  return { ruleset: state.ruleset, depths: state.depths, drops: state.drops.map(({ id, type, side, x, y }) => ({ id, type, side, x, y })),
    boosts: state.boosts.map((boosts, side) => ({
      active: Object.entries(boosts).filter(([, until]) => until > state.elapsedMs).map(([type, until]) => ({ type, seconds: Math.ceil((until - state.elapsedMs) / 1000) })),
      slot: state.slots[side] ? { type: state.slots[side].type, seconds: Math.max(0, Math.ceil((state.slots[side].until - state.elapsedMs) / 1000)) } : null,
    })), events: state.events.filter(e => state.elapsedMs - e.at < 600), powerPool: pool(state.mode, state.level, state.ruleset) };
}
module.exports = { TYPES, DURATIONS, MAX_DEPTH, pool, init, active, event, collect, consume, update, view };
