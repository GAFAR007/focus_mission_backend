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
