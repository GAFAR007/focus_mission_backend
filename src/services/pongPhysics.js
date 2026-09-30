/**
 * WHAT: Runs the deterministic, one-ball Pong simulation and all 15 levels.
 * WHY: Scores, collisions and unlock conditions must be owned by the server.
 * HOW: Advance a fixed-step world using bounded paddle input, delayed imperfect
 * computer decisions and circle/segment collisions. No database or academic XP.
 */
const powers = require('./pongPowerUps');
const ABSOLUTE_MAX_SPEED = 680;
const WORLD = Object.freeze({ width: 1000, height: 560, radius: 8, paddleWidth: 14, left: 28, right: 972, playerSpeed: 650 });
const definitions = [
  ['Getting Started', 5, 220, 150, 'plain'], ['A Little Faster', 8, 245, 145, 'plain'],
  ['Picking Up Speed', 10, 275, 138, 'plain'], ['Sharp Angles', 12, 285, 138, 'angles'],
  ['Smaller Paddle', 12, 300, 118, 'plain'], ['Centre Wall', 15, 300, 118, 'wall'],
  ['Moving Wall', 15, 315, 115, 'moving'], ['Speed Zones', 18, 310, 112, 'speed'],
  ['Narrow Defence', 18, 330, 95, 'plain'], ['Zigzag Arena', 20, 330, 105, 'zigzag'],
  ['Fast Returns', 22, 335, 102, 'accelerate'], ['Moving Barriers', 25, 345, 100, 'barriers'],
  ['Gravity Zone', 25, 345, 100, 'gravity'], ['Expert Arena', 30, 380, 85, 'moving'],
  ['Final Challenge', 35, 410, 80, 'final'],
];
const LEVELS = Object.freeze(definitions.map(([name, goal, speed, paddleHeight, arena], i) => Object.freeze({
  level: i + 1, name, goal, speed, paddleHeight, arena,
  minSpeed: speed * .72, maxSpeed: Math.min(590, speed * 1.5), maxAngle: i >= 3 ? 1.0 : 0.72,
  aiReaction: 0.46 - i * 0.026, aiSpeed: 235 + i * 17,
  aiError: 65 - i * 3.7, aiPaddleHeight: 132 - i * 2,
})));
const PVP = Object.freeze({ level: 0, name: 'Student battle', goal: 7, speed: 315, paddleHeight: 112, aiPaddleHeight: 112, arena: 'plain', minSpeed: 225, maxSpeed: 580, maxAngle: 0.88 });
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
function random(state) { let x = state.seed; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; state.seed = x >>> 0; return state.seed / 4294967296; }
function configFor(mode, level) {
  if (mode === 'pvp') return PVP;
  const config = LEVELS[level - 1];
  if (!config) throw new Error('Choose a level from 1 to 15.');
  return config;
}
function serve(state, config, direction = 1) {
  const angle = (random(state) - 0.5) * 0.65;
  state.ball = { x: 500, y: 120 + random(state) * 320, vx: Math.cos(angle) * config.speed * direction, vy: Math.sin(angle) * config.speed };
  state.phase = 'ready'; state.serveIn = 0.8; state.rally = 0; state.spin = 0; state.hotUntil = 0; state.speedZoneUntil = 0;
}
function createState(mode, level = 1, seed = 1, ruleset = mode === 'computer' ? 'power' : 'classic') {
  const config = configFor(mode, level);
  const state = { mode, ruleset, level: config.level, seed: seed || 1, phase: 'ready', paddles: [280, 280], score: [0, 0], returns: 0, rally: 0, longestRally: 0, elapsedMs: 0, aiWait: 0, aiTarget: 280, winner: null, completed: false };
  serve(state, config); powers.init(state, config); return state;
}
function segments(state, config) {
  const time = state.elapsedMs / 1000;
  const wall = (x, y, height, width = 18) => [[x-width/2,y-height/2,x+width/2,y-height/2],[x+width/2,y-height/2,x+width/2,y+height/2],[x+width/2,y+height/2,x-width/2,y+height/2],[x-width/2,y+height/2,x-width/2,y-height/2]];
  if (config.arena === 'wall') return wall(500, 280, 90);
  if (['moving', 'final'].includes(config.arena)) return wall(500, 280 + Math.sin(time * 0.7) * 155, config.arena === 'final' ? 70 : 90);
  if (config.arena === 'barriers') return [...wall(380, 180 + Math.sin(time * 0.6) * 100, 70), ...wall(620, 380 + Math.sin(time * 0.6 + Math.PI) * 100, 70)];
  if (config.arena === 'zigzag') return [[380,110,465,190], [535,370,620,450]];
  return [];
}
function reflectSegment(ball, line) {
  const [ax, ay, bx, by] = line; const dx = bx-ax, dy = by-ay;
  const t = clamp(((ball.x-ax)*dx+(ball.y-ay)*dy)/(dx*dx+dy*dy),0,1);
  const nx0 = ball.x-(ax+t*dx), ny0 = ball.y-(ay+t*dy), distance = Math.hypot(nx0,ny0);
  if (distance >= WORLD.radius || distance < 0.00001) return false;
  const nx = nx0/distance, ny = ny0/distance, toward = ball.vx*nx+ball.vy*ny;
  if (toward < 0) { ball.vx -= 2*toward*nx; ball.vy -= 2*toward*ny; }
  ball.x += nx*(WORLD.radius-distance+0.1); ball.y += ny*(WORLD.radius-distance+0.1);
  // WHY: Avoid a near-vertical obstacle bounce that would trap a rally forever.
  if (Math.abs(ball.vx) < 90) ball.vx = (ball.vx < 0 ? -1 : 1) * 90;
  return toward < 0;
}
function reflectedY(y) { const size = WORLD.height-2*WORLD.radius; const n = ((y-WORLD.radius)%(2*size)+2*size)%(2*size); return WORLD.radius + (n>size?2*size-n:n); }
function movePaddle(state, side, input, height, dt, speed) {
  const current = state.paddles[side];
  const desired = Number.isFinite(input?.targetY) ? input.targetY : current + clamp(input?.direction || 0,-1,1)*speed*dt;
  state.paddles[side] = clamp(current + clamp(desired-current,-speed*dt,speed*dt), height/2, WORLD.height-height/2);
  state.paddleVelocities[side] = (state.paddles[side] - current) / dt;
}
// WHY: Every multiplier (moving strike, power shot, curve and speed zone)
// passes the same cap. A minimum forward component keeps rallies defendable.
function limitVelocity(ball, config) {
  const speed = clamp(Math.hypot(ball.vx, ball.vy), config.minSpeed, Math.min(config.maxSpeed, ABSOLUTE_MAX_SPEED));
  const angle = clamp(Math.atan2(ball.vy, Math.abs(ball.vx)), -1.08, 1.08);
  ball.vx = (ball.vx < 0 ? -1 : 1) * Math.cos(angle) * speed;
  ball.vy = Math.sin(angle) * speed;
}
function computerInput(state, config, dt) {
  state.aiWait -= dt;
  if (state.aiWait <= 0) {
    // Game-only aggregates stay inside this match. Adaptation can approach,
    // never exceed, the level's published reaction/error/speed capabilities.
    const adaptation = Math.min(1, state.behaviour.hits / 25);
    state.aiWait = config.aiReaction * (1.15 - .15 * adaptation);
    const flight = state.ball.vx > 0 ? (WORLD.right - state.depths[1] - state.ball.x) / state.ball.vx : 0;
    const predicted = flight > 0 ? reflectedY(state.ball.y + state.ball.vy * flight) : 280 + state.behaviour.meanOffset * Math.min(18, state.level);
    const mistake = random(state) < .12 ? 1.8 : 1;
    state.aiTarget = clamp(predicted + (random(state) * 2 - 1) * config.aiError * (1.15 - .15 * adaptation) * mistake, 40, 520);
    const drop = state.drops.find(d => d.side === 1);
    if (drop && state.aiDropId !== drop.id) {
      state.aiDropId = drop.id;
      state.aiChase = random(state) < Math.min(.8, .04 + state.level * .05);
    }
    // The AI must physically move to catch a drop. It abandons the chase when
    // a return is imminent, with a level-bounded willingness to take risks.
    if (drop && state.aiChase && (flight <= 0 || flight > .9 + (15 - state.level) * .04)) state.aiTarget = drop.y;
  }
  return { targetY: state.aiTarget, forward: powers.active(state, 1, 'rush') && state.ball.x < 700 && state.level >= 6 ? 1 : 0 };
}
function step(state, inputs, seconds) {
  const config = configFor(state.mode, state.level);
  if (['complete','lost'].includes(state.phase)) return state;
  powers.init(state, config);
  let remaining = clamp(seconds, 0, .1);
  while (remaining > .000001 && !['complete','lost'].includes(state.phase)) {
    const dt = Math.min(remaining, 1/120); remaining -= dt; state.elapsedMs += dt * 1000;
    const controls = [inputs[0] || {}, state.mode === 'computer' ? computerInput(state, config, dt) : inputs[1] || {}];
    powers.update(state, config, controls, dt, random);
    for (const side of [0, 1]) {
      const speed = side === 1 && state.mode === 'computer' ? config.aiSpeed : WORLD.playerSpeed;
      movePaddle(state, side, controls[side], state.paddleWidths[side], dt, speed * (powers.active(state, side, 'speed') ? 1.3 : 1));
    }
    if (state.phase === 'ready') { state.serveIn -= dt; if (state.serveIn <= 0) state.phase = 'playing'; continue; }
    const ball = state.ball;
    // Controlled curvature is deterministic, decays and cannot make a shot
    // reverse direction or exceed the same safety cap as a straight return.
    state.spin *= Math.exp(-1.15 * dt);
    ball.vy += state.spin * dt;
    if (config.arena === 'gravity' && Math.hypot(ball.x - 500, ball.y - 280) < 155) ball.vy += clamp((280 - ball.y) * .65, -95, 95) * dt;
    limitVelocity(ball, config);
    const receiver = ball.vx < 0 ? 0 : 1;
    const focus = powers.active(state, receiver, 'focus') && (receiver === 0 ? ball.x < 500 : ball.x > 500);
    // Focus changes the authoritative displacement for BOTH clients; paddles
    // remain responsive. Speed zones are also capped after their multiplier.
    let factor = focus ? .65 : 1;
    if (config.arena === 'speed' && ((ball.x > 270 && ball.x < 350) || (ball.x > 650 && ball.x < 730))) factor *= 1.18;
    factor = Math.min(factor, Math.min(config.maxSpeed, ABSOLUTE_MAX_SPEED) / Math.hypot(ball.vx, ball.vy));
    state.effectiveSpeed = Math.hypot(ball.vx, ball.vy) * factor;
    ball.x += ball.vx * dt * factor; ball.y += ball.vy * dt * factor;
    if (ball.y < WORLD.radius || ball.y > WORLD.height - WORLD.radius) {
      ball.y = clamp(ball.y, WORLD.radius, WORLD.height - WORLD.radius); ball.vy *= -1; state.spin *= -.65;
      powers.event(state, 'wall', ball.x, ball.y);
    }
    for (const line of segments(state, config)) if (reflectSegment(ball, line)) powers.event(state, 'wall', ball.x, ball.y);
    limitVelocity(ball, config);
    for (const side of [0,1]) {
      const sign = side === 0 ? 1 : -1;
      const x = side === 0 ? WORLD.left + state.depths[0] : WORLD.right - state.depths[1];
      const height = state.paddleWidths[side];
      if (ball.vx * sign < 0 && Math.abs(ball.x - x) <= WORLD.paddleWidth/2 + WORLD.radius && Math.abs(ball.y - state.paddles[side]) <= height/2 + WORLD.radius) {
        const offset = clamp((ball.y - state.paddles[side]) / (height/2), -1, 1);
        const motion = clamp(state.paddleVelocities[side] / WORLD.playerSpeed, -1, 1);
        const power = powers.consume(state, side, 'power'), curve = powers.consume(state, side, 'curve');
        const escalation = 1.012 + Math.min(.025, Math.floor(state.rally / 5) * .007);
        const speed = Math.hypot(ball.vx, ball.vy) * escalation * (1 + .22 * Math.abs(motion)) * (power ? 1.35 : 1);
        const angle = clamp(offset * config.maxAngle + motion * .2, -1.05, 1.05);
        ball.vx = sign * Math.cos(angle) * speed; ball.vy = Math.sin(angle) * speed;
        state.spin = motion * 48 + (curve ? (Math.sign(offset || motion) || 1) * 160 : 0);
        limitVelocity(ball, config);
        state.effectiveSpeed = Math.hypot(ball.vx, ball.vy);
        if (power) state.hotUntil = state.elapsedMs + 1200;
        ball.x = x + sign * (WORLD.paddleWidth/2 + WORLD.radius + .1);
        powers.event(state, power || state.effectiveSpeed / config.maxSpeed > .9 ? 'strongHit' : 'hit', ball.x, ball.y, side);
        state.rally++; state.longestRally = Math.max(state.longestRally, state.rally);
        if (side === 0) {
          state.returns++;
          const stats = state.behaviour, weight = 1 / Math.min(20, ++stats.hits);
          stats.meanOffset += (offset - stats.meanOffset) * weight;
          stats.meanMotion += (Math.abs(motion) - stats.meanMotion) * weight;
        }
        if (state.mode === 'computer' && state.returns >= config.goal) { state.phase = 'complete'; state.completed = true; state.winner = 0; }
      }
    }
    if (ball.x < -WORLD.radius || ball.x > WORLD.width + WORLD.radius) {
      const missed = ball.x < 0 ? 0 : 1;
      if (powers.consume(state, missed, 'shield')) {
        ball.x = missed === 0 ? 12 : 988; ball.vx = Math.abs(ball.vx) * (missed === 0 ? 1 : -1); state.spin = 0;
        powers.event(state, 'shield', ball.x, ball.y, missed); continue;
      }
      const winner = 1 - missed; state.score[winner]++;
      powers.event(state, 'point', ball.x, ball.y, winner);
      if (state.mode === 'computer' && winner === 1) { state.phase = 'lost'; state.winner = 1; }
      else if (state.mode === 'pvp' && state.score[winner] >= 7) { state.phase = 'complete'; state.completed = true; state.winner = winner; }
      else serve(state, config, winner === 0 ? -1 : 1);
    }
  }
  return state;
}
function view(state) {
  const config = configFor(state.mode,state.level);
  powers.init(state, config);
  return { mode:state.mode,level:state.level,phase:state.phase,paddles:state.paddles,ball:{x:state.ball.x,y:state.ball.y},score:state.score,returns:state.returns,goal:config.goal,longestRally:state.longestRally,elapsedMs:Math.round(state.elapsedMs),winner:state.winner,completed:state.completed,paddleHeights:state.paddleWidths,barriers:segments(state,config),arena:config.arena,rally:state.rally,ballSpeed:state.effectiveSpeed || Math.hypot(state.ball.vx,state.ball.vy),maxSpeed:config.maxSpeed,hot:state.hotUntil>state.elapsedMs,...powers.view(state) };
}
module.exports = { WORLD, LEVELS, PVP, ABSOLUTE_MAX_SPEED, createState, step, view, configFor, reflectedY };
