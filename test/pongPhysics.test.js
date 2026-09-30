/**
 * WHAT: Verifies the one-ball engine, fair controls and all computer levels.
 * WHY: Progression needs playable, deterministic levels rather than UI labels.
 * HOW: Simulated legal paddle inputs complete levels and test collision edges.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const p = require('../src/services/pongPhysics');
function playLevel(level, seed = 1) {
  const state = p.createState('computer', level, seed);
  for (let i = 0; i < 60000 && !['complete', 'lost'].includes(state.phase); i++) {
    const flight = state.ball.vx < 0 ? (state.ball.x - p.WORLD.left) / -state.ball.vx : 0;
    const targetY = flight > 0 ? p.reflectedY(state.ball.y + state.ball.vy * flight) : state.ball.y;
    p.step(state, [{ targetY }], 1 / 60);
    assert.equal(Array.isArray(state.ball), false);
    assert.ok(Number.isFinite(state.ball.x) && Number.isFinite(state.ball.y));
    assert.ok(state.paddles[0] >= p.LEVELS[level - 1].paddleHeight / 2);
  }
  return state;
}
for (let level = 1; level <= 15; level++) test(`Pong level ${level} is beatable with legal controls and one ball`, () => {
  const state = playLevel(level);
  assert.equal(state.phase, 'complete'); assert.equal(state.returns, p.LEVELS[level - 1].goal);
  assert.equal(state.winner, 0); assert.equal(state.completed, true);
});
test('computer reacts gradually; higher levels retain reaction delay and prediction error', () => {
  for (let i = 1; i < 15; i++) {
    assert.ok(p.LEVELS[i].aiReaction < p.LEVELS[i - 1].aiReaction);
    assert.ok(p.LEVELS[i].aiSpeed > p.LEVELS[i - 1].aiSpeed);
    assert.ok(p.LEVELS[i].aiError > 0);
  }
  const state = p.createState('computer', 1, 5); state.ball.y = 20;
  p.step(state, [{ targetY: -5000 }], 1 / 60);
  assert.ok(Math.abs(state.paddles[1] - 280) <= p.LEVELS[0].aiSpeed / 60 + 0.01);
  assert.ok(Math.abs(state.paddles[0] - 280) <= p.WORLD.playerSpeed / 60 + 0.01);
});
test('PvP uses equal paddles, server points and first to seven', () => {
  const state = p.createState('pvp');
  assert.deepEqual(p.view(state).paddleHeights, [112, 112]);
  for (let point = 1; point <= 7; point++) {
    state.phase = 'playing'; state.ball = { x: 1007, y: 10, vx: 315, vy: 0 };
    p.step(state, [{}, {}], 1 / 60);
    assert.equal(state.score[0], point);
    assert.equal(state.completed, point === 7);
  }
  const saved = structuredClone(state); p.step(state, [{ targetY: 0 }], 99);
  assert.deepEqual(state, saved);
});
test('plain wall and paddle collisions remain bounded and deterministic', () => {
  const first = p.createState('computer', 1, 123), second = p.createState('computer', 1, 123);
  for (let i = 0; i < 200; i++) { p.step(first, [{ direction: -1 }], 1 / 60); p.step(second, [{ direction: -1 }], 1 / 60); }
  assert.deepEqual(first, second);
  assert.equal(first.paddles[0], 75);
  assert.ok(!('seed' in p.view(first)) && !('vx' in p.view(first).ball));
});
module.exports = { playLevel };

const boosts = require('../src/services/pongPowerUps');
function rally(mode = 'pvp', level = 0, ruleset = 'power') {
  const s = p.createState(mode, level, 77, ruleset); s.phase = 'playing'; s.nextDropAt = Infinity;
  s.ball = { x: 500, y: 280, vx: -315, vy: 0 }; return s;
}
function impact({ movement = 0, offset = 0, type = null, speed = 250 } = {}) {
  const s = rally(); s.ball = { x: 44, y: 280 + movement * p.WORLD.playerSpeed / 120 + offset * 56, vx: -speed, vy: 0 };
  if (type) boosts.collect(s, 0, type);
  p.step(s, [{ direction: movement }, {}], 1/120); return s;
}
test('moving strikes change speed, angle and spin; paddle edges aim predictable diagonals', () => {
  const center = impact(), right = impact({ movement: 1 }), left = impact({ movement: -1 });
  assert.ok(right.ball.vy > center.ball.vy); assert.ok(left.ball.vy < center.ball.vy);
  assert.ok(Math.hypot(right.ball.vx, right.ball.vy) > Math.hypot(center.ball.vx, center.ball.vy) * 1.15);
  assert.ok(right.spin > 0 && left.spin < 0);
  assert.ok(impact({ offset: .8 }).ball.vy > 0); assert.ok(impact({ offset: -.8 }).ball.vy < 0);
});
test('all impact and arena multipliers obey the normal and absolute velocity caps', () => {
  const s = impact({ movement: 1, type: 'power', speed: 2000 });
  assert.ok(Math.hypot(s.ball.vx, s.ball.vy) <= p.PVP.maxSpeed + .001);
  assert.ok(Math.hypot(s.ball.vx, s.ball.vy) <= p.ABSOLUTE_MAX_SPEED);
  for (const level of [8, 13, 15]) {
    const state = rally('computer', level); state.ball = { x: 300, y: 280, vx: 650, vy: 300 }; state.spin = 160;
    for (let n = 0; n < 90; n++) { p.step(state, [{ targetY: state.ball.y }], 1/120); assert.ok((state.effectiveSpeed || 0) <= p.LEVELS[level - 1].maxSpeed + .001); }
  }
});
test('speed and wide are bounded, temporary and expand/contract smoothly', () => {
  const normal = rally(), fast = rally(); boosts.collect(fast, 0, 'speed'); boosts.collect(fast, 0, 'wide');
  p.step(normal, [{ direction: 1 }], .1); p.step(fast, [{ direction: 1 }], .1);
  assert.ok(Math.abs((fast.paddles[0] - 280) / (normal.paddles[0] - 280) - 1.3) < .001);
  assert.ok(fast.paddleWidths[0] > 112 && fast.paddleWidths[0] <= 112 * 1.35);
  fast.elapsedMs = 6100; const before = fast.paddleWidths[0]; p.step(fast, [{}], 1/120);
  assert.ok(fast.paddleWidths[0] < before && fast.paddleWidths[0] >= 112);
  assert.equal(boosts.active(fast, 0, 'speed'), false);
});
test('forward rush uses each own half, has a hard depth limit and returns on expiry', () => {
  const s = rally(); boosts.collect(s, 0, 'rush'); boosts.collect(s, 1, 'rush');
  s.phase = 'ready'; s.serveIn = 99;
  for (let n = 0; n < 20; n++) p.step(s, [{ forward: 1 }, { forward: 1 }], .1);
  assert.deepEqual(s.depths, [boosts.MAX_DEPTH, boosts.MAX_DEPTH]);
  s.elapsedMs = 4010; p.step(s, [{ forward: 1 }, { forward: 1 }], .1);
  assert.ok(s.depths[0] > 0 && s.depths[0] < boosts.MAX_DEPTH);
  for (let n = 0; n < 10; n++) p.step(s, [{ forward: 1 }, { forward: 1 }], .1);
  assert.deepEqual(s.depths, [0, 0]);
});
test('one stored power shot or curve is consumed once and unused slots expire', () => {
  const plain = impact(), power = impact({ type: 'power' }), curve = impact({ type: 'curve', offset: .3 });
  assert.ok(Math.hypot(power.ball.vx, power.ball.vy) > Math.hypot(plain.ball.vx, plain.ball.vy) * 1.3);
  assert.equal(power.slots[0], null); assert.ok(power.hotUntil > power.elapsedMs);
  assert.ok(curve.spin > 100); assert.equal(curve.slots[0], null);
  const straight = structuredClone(curve); straight.spin = 0;
  p.step(curve, [{}], .1); p.step(straight, [{}], .1); assert.ok(curve.ball.y > straight.ball.y);
  const s = rally(); assert.equal(boosts.collect(s, 0, 'power'), true); assert.equal(boosts.collect(s, 0, 'shield'), false);
  s.elapsedMs = 8100; p.step(s, [{}], .01); assert.equal(s.slots[0], null);
});
test('shield saves exactly one miss, cannot stack, and does not award points', () => {
  const s = rally(); boosts.collect(s, 0, 'shield'); assert.equal(boosts.collect(s, 0, 'shield'), false);
  s.ball = { x: -7, y: 20, vx: -300, vy: 0 }; p.step(s, [{}, {}], .02);
  assert.deepEqual(s.score, [0, 0]); assert.ok(s.ball.vx > 0); assert.equal(s.slots[0], null);
  s.ball = { x: -7, y: 20, vx: -300, vy: 0 }; p.step(s, [{}, {}], .02); assert.deepEqual(s.score, [0, 1]);
});
test('focus slows the incoming half authoritatively while paddle responsiveness stays unchanged', () => {
  const normal = rally(), focus = rally(); normal.ball.x = focus.ball.x = 300;
  boosts.collect(focus, 0, 'focus'); p.step(normal, [{ direction: 1 }], .1); p.step(focus, [{ direction: 1 }], .1);
  assert.ok(focus.ball.x > normal.ball.x); assert.equal(focus.paddles[0], normal.paddles[0]);
  assert.ok(p.view(focus).ballSpeed < p.view(normal).ballSpeed);
  focus.elapsedMs = 3100; p.step(focus, [{}], .01); assert.equal(boosts.active(focus, 0, 'focus'), false);
});
test('power drops are paired fairly, sparse, visible and require physical paddle contact', () => {
  const s = rally(); s.nextDropAt = 0; p.step(s, [{}, {}], .01);
  assert.equal(s.drops.length, 2); const [a, b] = s.drops;
  assert.equal(a.type, b.type); assert.ok(Math.abs(a.x + b.x - 1000) < .001); assert.equal(a.y + b.y, 560);
  assert.ok(s.nextDropAt >= s.elapsedMs + 9900 && s.nextDropAt <= s.elapsedMs + 18000);
  assert.ok(s.boosts.every(e => Object.keys(e).length === 0)); assert.deepEqual(s.slots, [null, null]);
  s.drops = [{ id: 'contact', type: 'speed', side: 0, x: 28, y: s.paddles[0], expiresAt: 9000 }];
  p.step(s, [{}], .01); assert.equal(s.drops.length, 0); assert.equal(boosts.active(s, 0, 'speed'), true);
});
test('gradual introduction and Classic never spawn boosts', () => {
  assert.deepEqual(boosts.pool('computer', 1), []); assert.deepEqual(boosts.pool('computer', 2), ['speed']);
  assert.equal(boosts.pool('computer', 8).length, 7);
  const s = rally('pvp', 0, 'classic'); s.nextDropAt = 0; p.step(s, [{}, {}], .1); assert.equal(s.drops.length, 0);
});
test('AI collects only by contact, retains level caps and runs without any external strategy service', () => {
  const s = rally('computer', 15); s.phase = 'ready'; s.serveIn = 99;
  s.drops = [{ id: 'far', type: 'speed', side: 1, x: 600, y: 40, expiresAt: 9000 }];
  p.step(s, [{}], .1); assert.equal(boosts.active(s, 1, 'speed'), false); assert.ok(Math.abs(s.paddles[1] - 280) <= p.LEVELS[14].aiSpeed * .1 + .01);
  s.drops = [{ id: 'near', type: 'speed', side: 1, x: 972, y: s.paddles[1], expiresAt: 9000 }];
  p.step(s, [{}], .01); assert.equal(boosts.active(s, 1, 'speed'), true);
  s.behaviour.hits = 100; s.aiWait = 0; p.step(s, [{}], 1/120);
  assert.ok(s.aiWait >= p.LEVELS[14].aiReaction - .01);
});
test('older active snapshots gain additive defaults without resetting match or saved counters', () => {
  const s = { mode: 'pvp', level: 0, seed: 1, phase: 'playing', paddles: [250, 300], ball: { x: 500, y: 280, vx: 315, vy: 0 }, score: [3, 4], returns: 8, longestRally: 9, rally: 4, elapsedMs: 5000, winner: null, completed: false };
  p.step(s, [{}, {}], .01); assert.deepEqual(s.score, [3, 4]); assert.equal(s.ruleset, 'classic'); assert.equal(s.returns, 8);
  const publicFrame = JSON.stringify(p.view(s)); assert.ok(!publicFrame.includes('meanOffset') && !publicFrame.includes('aiTarget'));
});
