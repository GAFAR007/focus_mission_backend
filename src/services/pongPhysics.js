/**
 * WHAT: Runs the deterministic, one-ball Pong simulation and all 15 levels.
 * WHY: Scores, collisions and unlock conditions must be owned by the server.
 * HOW: Advance a fixed-step world using bounded paddle input, delayed imperfect
 * computer decisions and circle/segment collisions. No database or academic XP.
 */
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
  maxSpeed: Math.min(590, speed * 1.35), maxAngle: i >= 3 ? 1.0 : 0.72,
  aiReaction: 0.46 - i * 0.026, aiSpeed: 235 + i * 17,
  aiError: 65 - i * 3.7, aiPaddleHeight: 132 - i * 2,
})));
const PVP = Object.freeze({ level: 0, name: 'Student battle', goal: 7, speed: 315, paddleHeight: 112, aiPaddleHeight: 112, arena: 'plain', maxSpeed: 540, maxAngle: 0.88 });
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
  state.phase = 'ready'; state.serveIn = 0.8; state.rally = 0; state.speedZoneUntil = 0;
}
function createState(mode, level = 1, seed = 1) {
  const config = configFor(mode, level);
  const state = { mode, level: config.level, seed: seed || 1, phase: 'ready', paddles: [280, 280], score: [0, 0], returns: 0, rally: 0, longestRally: 0, elapsedMs: 0, aiWait: 0, aiTarget: 280, winner: null, completed: false };
  serve(state, config); return state;
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
  if (distance >= WORLD.radius || distance < 0.00001) return;
  const nx = nx0/distance, ny = ny0/distance, toward = ball.vx*nx+ball.vy*ny;
  if (toward < 0) { ball.vx -= 2*toward*nx; ball.vy -= 2*toward*ny; }
  ball.x += nx*(WORLD.radius-distance+0.1); ball.y += ny*(WORLD.radius-distance+0.1);
  // WHY: Avoid a near-vertical obstacle bounce that would trap a rally forever.
  if (Math.abs(ball.vx) < 90) ball.vx = (ball.vx < 0 ? -1 : 1) * 90;
}
function reflectedY(y) { const size = WORLD.height-2*WORLD.radius; const n = ((y-WORLD.radius)%(2*size)+2*size)%(2*size); return WORLD.radius + (n>size?2*size-n:n); }
function movePaddle(state, side, input, height, dt, speed) {
  const current = state.paddles[side];
  const desired = Number.isFinite(input?.targetY) ? input.targetY : current + clamp(input?.direction || 0,-1,1)*speed*dt;
  state.paddles[side] = clamp(current + clamp(desired-current,-speed*dt,speed*dt), height/2, WORLD.height-height/2);
}
function step(state, inputs, seconds) {
  const config = configFor(state.mode, state.level);
  if (['complete','lost'].includes(state.phase)) return state;
  // Large wall-clock jumps never fast-forward through an unplayable sequence.
  let remaining = clamp(seconds,0,0.1);
  while (remaining > 0.000001 && !['complete','lost'].includes(state.phase)) {
    const dt = Math.min(remaining,1/120); remaining -= dt; state.elapsedMs += dt*1000;
    movePaddle(state,0,inputs[0],config.paddleHeight,dt,WORLD.playerSpeed);
    if (state.mode === 'computer') {
      state.aiWait -= dt;
      if (state.aiWait <= 0) {
        state.aiWait = config.aiReaction;
        const flight = state.ball.vx > 0 ? (WORLD.right-state.ball.x)/state.ball.vx : 0;
        const predicted = flight > 0 ? reflectedY(state.ball.y + state.ball.vy * flight) : 280;
        const mistake = random(state) < 0.12 ? 1.8 : 1;
        state.aiTarget = clamp(predicted + (random(state)*2-1)*config.aiError*mistake,40,520);
      }
      movePaddle(state,1,{targetY:state.aiTarget},config.aiPaddleHeight,dt,config.aiSpeed);
    } else movePaddle(state,1,inputs[1],config.paddleHeight,dt,WORLD.playerSpeed);
    if (state.phase === 'ready') { state.serveIn -= dt; if(state.serveIn <= 0) state.phase='playing'; continue; }
    const ball = state.ball;
    if (config.arena === 'gravity' && Math.hypot(ball.x-500,ball.y-280)<155) {
      ball.vy += clamp((280-ball.y)*0.65,-95,95)*dt;
    }
    let factor = 1;
    if(config.arena === 'speed' && ((ball.x>270&&ball.x<350)||(ball.x>650&&ball.x<730))) factor = 1.22;
    ball.x += ball.vx*dt*factor; ball.y += ball.vy*dt*factor;
    if(ball.y<WORLD.radius) { ball.y=WORLD.radius;ball.vy=Math.abs(ball.vy); }
    if(ball.y>WORLD.height-WORLD.radius) { ball.y=WORLD.height-WORLD.radius;ball.vy=-Math.abs(ball.vy); }
    for(const line of segments(state,config)) reflectSegment(ball,line);
    for(const side of [0,1]) {
      const x = side === 0 ? WORLD.left : WORLD.right;
      const height = side === 0 ? config.paddleHeight : config.aiPaddleHeight;
      const toward = side===0 ? ball.vx<0 : ball.vx>0;
      if(toward && Math.abs(ball.x-x)<=WORLD.paddleWidth/2+WORLD.radius && Math.abs(ball.y-state.paddles[side])<=height/2+WORLD.radius) {
        const offset = clamp((ball.y-state.paddles[side])/(height/2),-1,1);
        const speed = Math.min(config.maxSpeed,Math.hypot(ball.vx,ball.vy)*(config.arena==='accelerate'||state.mode==='pvp'?1.035:1.006));
        ball.vx = (side===0?1:-1)*Math.cos(offset*config.maxAngle)*speed;
        ball.vy = Math.sin(offset*config.maxAngle)*speed;
        ball.x = x+(side===0?1:-1)*(WORLD.paddleWidth/2+WORLD.radius+0.1);
        state.rally++;state.longestRally=Math.max(state.longestRally,state.rally);
        if(side===0) state.returns++;
        if(state.mode==='computer'&&state.returns>=config.goal) { state.phase='complete';state.completed=true;state.winner=0; }
      }
    }
    if(ball.x < -WORLD.radius || ball.x > WORLD.width+WORLD.radius) {
      const winner = ball.x < 0 ? 1 : 0; state.score[winner]++;
      if(state.mode==='computer'&&winner===1) { state.phase='lost';state.winner=1; }
      else if(state.mode==='pvp'&&state.score[winner]>=7) { state.phase='complete';state.completed=true;state.winner=winner; }
      else serve(state,config,winner===0?-1:1);
    }
  }
  return state;
}
function view(state) {
  const config = configFor(state.mode,state.level);
  return { mode:state.mode,level:state.level,phase:state.phase,paddles:state.paddles,ball:{x:state.ball.x,y:state.ball.y},score:state.score,returns:state.returns,goal:config.goal,longestRally:state.longestRally,elapsedMs:Math.round(state.elapsedMs),winner:state.winner,completed:state.completed,paddleHeights:[config.paddleHeight,config.aiPaddleHeight],barriers:segments(state,config),arena:config.arena };
}
module.exports = { WORLD, LEVELS, PVP, createState, step, view, configFor, reflectedY };
