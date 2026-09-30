/**
 * WHAT: Runs authoritative Pong rooms and authenticated state streams.
 * WHY: Clients may move their paddle, but cannot choose scores or results.
 * HOW: A single leased server advances each room, saves snapshots, rechecks
 * access and pauses for reconnects. Every asynchronous DB callback keeps scope.
 */
const { randomUUID } = require('node:crypto');
const Match = require('../models/PongMatch');
const Profile = require('../models/PongProfile');
const User = require('../models/User');
const service = require('./pong.service');
const physics = require('./pongPhysics');
const { runInSchool, schoolId } = require('../utils/schoolScope');
const OWNER = randomUUID(), LEASE_MS = 8000, GRACE_MS = 20000, SILENCE_MS = 3000;
const rooms = new Map(), loading = new Map();
const sideFor = (room, id) => String(room.match.player1Id) === String(id) ? 0 : 1;
function frame(room, side, extra = {}) {
  return { ...room.views[side], status: room.match.status, reason: room.match.reason, state: physics.view(room.state), paused: room.paused,
    waiting: room.waiting, reconnectSeconds: room.waitingSince ? Math.max(0, Math.ceil((GRACE_MS - (Date.now() - room.waitingSince)) / 1000)) : 0, ...extra };
}
function write(res, data) {
  if (res.destroyed || res.writableEnded) return;
  // WHY: A slow connection gets a reconnect, never an unbounded state backlog.
  if (res.writableLength > 65536) return res.destroy();
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}
function broadcast(room) {
  for (const [side, connection] of room.connections.entries()) if (connection) write(connection.res, frame(room, side));
}
function dispose(room) {
  clearInterval(room.timer);
  for (const connection of room.connections) connection?.res.end();
  rooms.delete(room.match.handle);
}
async function finish(room, status, reason = '') {
  await service.endMatch(room.match._id, status, reason, structuredClone(room.state), OWNER);
  const saved = await Match.findById(room.match._id);
  if (!saved || saved.status === 'active') throw service.fail(503, 'PONG_LEASE_LOST', 'The game connection changed. Please reconnect.');
  room.match = saved; room.state = saved.state; broadcast(room); dispose(room);
}
async function tick(room) {
  if (room.busy) return;
  room.busy = true;
  try {
    const now = Date.now(), dt = Math.min(0.05, (now - room.lastTick) / 1000); room.lastTick = now;
    if (now - room.lastSaved >= 1000) {
      const ids = [room.match.player1Id, room.match.player2Id].filter(Boolean);
      const profiles = await Profile.find({ studentId: { $in: ids } }).lean();
      const count = await User.countDocuments({ _id: { $in: ids }, role: 'student', isArchived: { $ne: true } });
      if (count !== ids.length || profiles.length !== ids.length || profiles.some(p => !service.allowed(p, room.match.mode, room.state.ruleset))) return await finish(room, 'disabled', 'Your teacher has turned this game mode off.');
      const saved = await Match.updateOne({ _id: room.match._id, status: 'active', engineOwner: OWNER, leaseUntil: { $gt: new Date() } }, { $set: { state: structuredClone(room.state), leaseUntil: new Date(now + LEASE_MS) } });
      if (saved.matchedCount !== 1) {
        const current = await Match.findById(room.match._id);
        if (current?.status !== 'active') { room.match = current; broadcast(room); dispose(room); return; }
        throw service.fail(503, 'PONG_LEASE_LOST', 'The game connection changed. Please reconnect.');
      }
      room.lastSaved = now;
      const presentIds = ids.filter((_id, side) => room.connections[side] && now - room.lastSeen[side] <= SILENCE_MS);
      if (presentIds.length) await Profile.updateMany({ studentId: { $in: presentIds } }, { $set: { presenceAt: new Date(now) } });
    }
    const sides = room.match.mode === 'pvp' ? [0, 1] : [0];
    room.waiting = sides.some(side => !room.connections[side] || now - room.lastSeen[side] > SILENCE_MS);
    if (room.waiting) {
      room.waitingSince ||= now;
      if (now - room.waitingSince > GRACE_MS) return await finish(room, 'abandoned', 'The connection ended. No winner was recorded.');
    } else room.waitingSince = null;
    if (!room.waiting && !room.paused) physics.step(room.state, room.inputs, dt);
    if (['complete', 'lost'].includes(room.state.phase)) return await finish(room, 'complete');
    broadcast(room);
  } catch (error) {
    console.error('[pong] Room paused after persistence error', { code: error.code || 'PERSISTENCE_ERROR' });
    for (const [side, connection] of room.connections.entries()) if (connection) write(connection.res, frame(room, side, { connectionError: 'Connection interrupted. Reconnecting…' }));
    dispose(room); // Persisted lease must expire before another process resumes.
  } finally { room.busy = false; }
}
async function loadRoom(match) {
  const existing = rooms.get(match.handle);
  if (existing) return existing;
  if (loading.has(match.handle)) return loading.get(match.handle);
  const tenant = String(schoolId());
  const promise = (async () => {
    const claimed = await Match.findOneAndUpdate({ _id: match._id, status: 'active', $or: [{ engineOwner: OWNER }, { engineOwner: null }, { leaseUntil: { $lt: new Date() } }] }, { $set: { engineOwner: OWNER, leaseUntil: new Date(Date.now() + LEASE_MS) } }, { returnDocument: 'after' });
    if (!claimed) throw service.fail(503, 'PONG_RECONNECT', 'This game is reconnecting. Try again in a moment.');
    const room = { match: claimed, state: structuredClone(claimed.state), views: [], connections: [null, null], inputs: [{}, {}], lastSeen: [0, 0], seq: [-1, -1], paused: false, waiting: true, waitingSince: Date.now(), lastTick: Date.now(), lastSaved: Date.now(), busy: false };
    room.views[0] = await service.matchView(claimed.player1Id, claimed);
    room.views[1] = claimed.player2Id ? await service.matchView(claimed.player2Id, claimed) : null;
    rooms.set(match.handle, room);
    room.timer = setInterval(() => runInSchool(tenant, () => tick(room)), 50);
    room.timer.unref();
    return room;
  })();
  loading.set(match.handle, promise);
  try { return await promise; } finally { loading.delete(match.handle); }
}
async function connect(id, handle, res) {
  const match = await service.ownedMatch(id, handle);
  if (match.status !== 'active') {
    res.setHeader('Content-Type', 'text/event-stream'); write(res, await service.matchView(id, match)); res.end(); return;
  }
  const p = await service.profile(id);
  if (!service.allowed(p, match.mode, match.state.ruleset)) throw service.fail(403, 'PONG_DISABLED', 'Your teacher has turned this game mode off.');
  const room = await loadRoom(match), side = sideFor(room, id), token = randomUUID();
  res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Cache-Control', 'no-cache, no-transform'); res.setHeader('X-Accel-Buffering', 'no'); res.flushHeaders();
  room.connections[side]?.res.end();
  const connection = { res, token }; room.connections[side] = connection; room.lastSeen[side] = Date.now(); room.seq[side] = -1; room.inputs[side] = {};
  write(res, frame(room, side, { controlToken: token }));
  res.on('close', () => { if (room.connections[side] === connection) room.connections[side] = null; });
}
async function input(id, handle, payload) {
  // WHY: Ownership is established by the scoped query on every input; guessed
  // room handles and tokens cannot steer another student's paddle.
  const match = await service.ownedMatch(id, handle);
  const room = rooms.get(handle);
  if (match.status !== 'active' || !room) throw service.fail(409, 'PONG_RECONNECT', 'Reconnect to this game.');
  const side = sideFor(room, id), connection = room.connections[side];
  if (!connection || payload.controlToken !== connection.token) throw service.fail(409, 'PONG_CONTROL_CHANGED', 'This game is open in another tab.');
  if (payload.seq <= room.seq[side]) return { accepted: false };
  const now = Date.now();
  if (now - room.lastSeen[side] < 25 && !(payload.direction === 0 && payload.targetY == null)) return { accepted: false };
  room.seq[side] = payload.seq; room.lastSeen[side] = now;
  room.inputs[side] = { ...(payload.targetY == null ? { direction: payload.direction || 0 } : { targetY: payload.targetY }), forward: payload.forward || 0 };
  return { accepted: true };
}
async function control(id, handle, action) {
  const match = await service.ownedMatch(id, handle);
  if (action === 'leave') { await service.endMatch(match._id, 'abandoned', 'A player left. No winner was recorded.'); return { status: 'abandoned' }; }
  if (match.mode !== 'computer' || match.status !== 'active') throw service.fail(409, 'PONG_CONTROL_UNAVAILABLE', 'This control is only available in computer games.');
  const room = rooms.get(handle);
  if (!room) throw service.fail(409, 'PONG_RECONNECT', 'Reconnect to this game.');
  room.paused = action === 'pause'; return { paused: room.paused };
}
function stopAll() { for (const room of rooms.values()) dispose(room); }
module.exports = { connect, input, control, stopAll, GRACE_MS, SILENCE_MS };
