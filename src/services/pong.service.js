/**
 * WHAT: Owns Pong permissions, invitations, progress and match lifecycle.
 * WHY: School isolation, explicit consent and exactly-once results are server rules.
 * HOW: Existing school context scopes every query; Mongo transactions reserve
 * players and publish game-only results without writing academic XP or evidence.
 */
const mongoose = require('mongoose');
const { randomInt } = require('node:crypto');
const User = require('../models/User');
const Profile = require('../models/PongProfile');
const Match = require('../models/PongMatch');
const Challenge = require('../models/PongChallenge');
const physics = require('./pongPhysics');
const { runInSchool } = require('../utils/schoolScope');
mongoose.set('transactionAsyncLocalStorage', true);
const PRESENCE_MS = 30000, CHALLENGE_MS = 90000, COOLDOWN_MS = 5000;
const fail = (statusCode, code, message) => Object.assign(new Error(message), { statusCode, code });
const transaction = fn => mongoose.connection.transaction(fn);
const same = (a, b) => String(a) === String(b);
function privateName(name) {
  const parts = String(name || 'Student').trim().split(/\s+/);
  return `${parts[0]}${parts.length > 1 ? ` ${Array.from(parts.at(-1))[0]}.` : ''}`;
}
async function activeStudent(id) {
  const student = await User.findOne({ _id: id, role: 'student', isArchived: { $ne: true } }).lean();
  if (!student) throw fail(404, 'STUDENT_UNAVAILABLE', 'This student is unavailable.');
  return student;
}
async function profile(id) {
  await activeStudent(id);
  try {
    return await Profile.findOneAndUpdate({ studentId: id }, { $setOnInsert: { studentId: id } }, { upsert: true, returnDocument: 'after' });
  } catch (error) {
    if (error.code !== 11000) throw error;
    return Profile.findOne({ studentId: id });
  }
}
function allowed(p, mode, ruleset = 'classic') {
  return p?.access.enabled && (mode === 'computer' ? p.access.computer : p.access.battles && p.access.lobbyVisible && (ruleset !== 'power' || p.access.powerBattle === true));
}
function requireAccess(p, mode, ruleset = 'classic') {
  if (!allowed(p, mode, ruleset)) throw fail(403, 'PONG_DISABLED', 'Your teacher has turned this game mode off.');
}
function progress(p) {
  return Object.fromEntries(['highestUnlocked', 'completedLevels', 'bestRally', 'computerWins', 'multiplayerWins', 'multiplayerLosses', 'matchesPlayed'].map(k => [k, p[k]]));
}
async function staffAccess(actorId, studentId) {
  const actor = await User.findOne({ _id: actorId, isArchived: { $ne: true } }).lean();
  if (!actor || (actor.role !== 'management' && !(actor.role === 'teacher' && actor.assignedStudents.some(id => same(id, studentId))))) {
    throw fail(403, 'PONG_STAFF_REQUIRED', 'Only the assigned teacher or management can change game access.');
  }
  return profile(studentId);
}
async function getAccess(actorId, studentId) {
  const p = await staffAccess(actorId, studentId);
  return { access: p.access.toObject(), progress: progress(p) };
}
async function setAccess(actorId, studentId, access) {
  await staffAccess(actorId, studentId);
  const update = Object.fromEntries(Object.entries(access).map(([k, v]) => [`access.${k}`, v]));
  const p = await Profile.findOneAndUpdate({ studentId }, { $set: { ...update, updatedBy: actorId } }, { returnDocument: 'after' });
  if (p.activeMatchId) {
    const match = await Match.findById(p.activeMatchId);
    if (match && !allowed(p, match.mode, match.state.ruleset)) await endMatch(match._id, 'disabled', 'Your teacher has turned this game mode off.');
  }
  if (!allowed(p, 'pvp')) await Challenge.updateMany({ status: 'pending', $or: [{ challengerId: studentId }, { opponentId: studentId }] }, { $set: { status: 'cancelled' } });
  if (!p.access.powerBattle) await Challenge.updateMany({ ruleset: 'power', status: 'pending', $or: [{ challengerId: studentId }, { opponentId: studentId }] }, { $set: { status: 'cancelled' } });
  console.info('[pong] Access updated', { enabled: p.access.enabled, computer: p.access.computer, battles: p.access.battles });
  return { access: p.access.toObject(), progress: progress(p) };
}
async function expireChallenges() {
  await Challenge.updateMany({ status: 'pending', expiresAt: { $lte: new Date() } }, { $set: { status: 'expired' } });
}
async function me(id) {
  const p = await profile(id);
  await Profile.updateOne({ _id: p._id }, { $set: { presenceAt: new Date() } });
  let active = p.activeMatchId ? await Match.findById(p.activeMatchId).lean() : null;
  // WHY: A crashed process must not leave a student permanently busy. An expired
  // lease has a generous reconnect window before a no-winner cancellation.
  if (active?.status === 'active' && Date.now() - new Date(active.leaseUntil || active.createdAt).getTime() > 60000) {
    await endMatch(active._id, 'abandoned', 'The connection ended. You can start again.'); active = null;
  }
  return { handle: p.handle, access: p.access.toObject(), progress: progress(p), activeMatch: active?.status === 'active' ? active.handle : null,
    levels: physics.LEVELS.map(({ level, name, goal, arena }) => ({ level, name, goal, arena, powerUps: require('./pongPowerUps').pool('computer', level, 'power') })) };
}
async function lobby(id, search = '') {
  const p = await profile(id); requireAccess(p, 'pvp');
  await Profile.updateOne({ _id: p._id }, { $set: { presenceAt: new Date() } });
  await expireChallenges();
  const profiles = await Profile.find({ 'access.enabled': true, 'access.battles': true, 'access.lobbyVisible': true, studentId: { $ne: id } }).lean();
  const users = await User.find({ _id: { $in: profiles.map(x => x.studentId) }, role: 'student', isArchived: { $ne: true } }).select('name').lean();
  const names = new Map(users.map(u => [String(u._id), privateName(u.name)]));
  const students = profiles.filter(p => names.has(String(p.studentId))).map(p => ({ handle: p.handle, name: names.get(String(p.studentId)), level: p.highestUnlocked, wins: p.multiplayerWins, powerBattle: p.access.powerBattle === true,
    availability: Date.now() - new Date(p.presenceAt || 0).getTime() > PRESENCE_MS ? 'Offline' : p.activeMatchId ? 'In game' : 'Available' })).filter(p => p.name.toLowerCase().includes(search.toLowerCase())).slice(0, 100);
  const invitations = await Challenge.find({ $or: [{ challengerId: id }, { opponentId: id }], createdAt: { $gt: new Date(Date.now() - 180000) } }).sort({ createdAt: -1 }).limit(30).lean();
  const challenges = [];
  for (const c of invitations) {
    const otherId = same(c.challengerId, id) ? c.opponentId : c.challengerId;
    const other = await User.findById(otherId).select('name').lean();
    const match = c.matchId ? await Match.findById(c.matchId).select('handle').lean() : null;
    challenges.push({ handle: c.handle, name: privateName(other?.name), incoming: same(c.opponentId, id), status: c.status, ruleset: c.ruleset || 'classic', expiresIn: Math.max(0, Math.ceil((c.expiresAt - Date.now()) / 1000)), match: match?.handle || null });
  }
  return { students, challenges, powerBattle: p.access.powerBattle === true };
}
async function eligible(id, online = false, ruleset = 'classic') {
  await activeStudent(id);
  const p = await Profile.findOne({ studentId: id });
  requireAccess(p, 'pvp', ruleset);
  if (p.activeMatchId) throw fail(409, 'PONG_BUSY', 'This student is already in a game.');
  if (online && Date.now() - new Date(p.presenceAt || 0).getTime() > PRESENCE_MS) throw fail(409, 'PONG_OFFLINE', 'This student is offline.');
  return p;
}
async function challenge(id, targetHandle, rematchHandle, ruleset = 'classic') {
  if (!['classic', 'power'].includes(ruleset)) throw fail(400, 'PONG_RULESET', 'Choose Classic or Power Battle.');
  await expireChallenges();
  return transaction(async () => {
    const target = await Profile.findOne({ handle: targetHandle });
    if (!target || same(target.studentId, id)) throw fail(404, 'OPPONENT_UNAVAILABLE', 'Choose an available student from your school.');
    const self = await eligible(id, false, ruleset), other = await eligible(target.studentId, true, ruleset);
    if (self.challengeAfter > new Date()) throw fail(429, 'PONG_COOLDOWN', 'Wait a moment before sending another challenge.');
    let rematch = null;
    if (rematchHandle) {
      rematch = await Match.findOne({ handle: rematchHandle, mode: 'pvp', status: 'complete', $or: [{ player1Id: id, player2Id: other.studentId }, { player2Id: id, player1Id: other.studentId }] });
      if (rematch && (rematch.state.ruleset || 'classic') !== ruleset) throw fail(409, 'PONG_RULESET', 'A rematch uses the same game mode.');
      if (!rematch) throw fail(404, 'REMATCH_UNAVAILABLE', 'That rematch is unavailable.');
    }
    const pairKey = [String(id), String(other.studentId)].sort().join(':');
    if (await Challenge.exists({ pairKey, status: 'pending' })) throw fail(409, 'CHALLENGE_PENDING', 'A challenge is already waiting for this student.');
    await Profile.updateOne({ _id: self._id }, { $set: { challengeAfter: new Date(Date.now() + COOLDOWN_MS), presenceAt: new Date() } });
    // WHY: Touch both permission records so a concurrent disable/start conflicts
    // with this transaction instead of publishing a stale invitation.
    await Profile.updateOne({ _id: other._id }, { $set: { updatedAt: new Date() } });
    const c = await Challenge.create({ challengerId: id, opponentId: other.studentId, pairKey, ruleset, expiresAt: new Date(Date.now() + CHALLENGE_MS), rematchOf: rematch?._id || null });
    return { handle: c.handle };
  });
}
async function reserveMatch(player1Id, player2Id, mode, level, ruleset = mode === 'computer' ? 'power' : 'classic') {
  const match = await Match.create({ player1Id, player2Id, mode, level, state: physics.createState(mode, level, randomInt(1, 2147483647), ruleset) });
  for (const id of [player1Id, player2Id].filter(Boolean)) {
    const locked = await Profile.updateOne({ studentId: id, activeMatchId: null }, { $set: { activeMatchId: match._id } });
    if (locked.modifiedCount !== 1) throw fail(409, 'PONG_BUSY', 'A player is already in a game.');
  }
  await Challenge.updateMany({ status: 'pending', $or: [{ challengerId: { $in: [player1Id, player2Id].filter(Boolean) } }, { opponentId: { $in: [player1Id, player2Id].filter(Boolean) } }] }, { $set: { status: 'cancelled' } });
  return match;
}
async function startComputer(id, level) {
  await profile(id);
  return transaction(async () => {
    await activeStudent(id);
    const p = await Profile.findOne({ studentId: id }); requireAccess(p, 'computer');
    if (!Number.isInteger(level) || level < 1 || level > 15 || level > p.highestUnlocked) throw fail(403, 'LEVEL_LOCKED', 'Complete the previous level to unlock this one.');
    const match = await reserveMatch(id, null, 'computer', level);
    return { match: match.handle };
  });
}
async function respond(id, handle, action, acceptedRuleset) {
  await expireChallenges();
  return transaction(async () => {
    const c = await Challenge.findOne({ handle });
    if (!c || !same(action === 'cancel' ? c.challengerId : c.opponentId, id)) throw fail(404, 'CHALLENGE_UNAVAILABLE', 'This challenge is unavailable.');
    if (action === 'accept' && c.ruleset === 'power' && acceptedRuleset !== 'power') throw fail(409, 'PONG_RULESET', 'Accept the Power Battle rules to play this invitation.');
    if (action === 'accept' && acceptedRuleset && acceptedRuleset !== (c.ruleset || 'classic')) throw fail(409, 'PONG_RULESET', 'The invitation uses a different game mode.');
    if (action === 'accept' && c.status === 'accepted') {
      const existing = await Match.findById(c.matchId); return { match: existing.handle };
    }
    if (c.status !== 'pending' || c.expiresAt <= new Date()) throw fail(409, 'CHALLENGE_CLOSED', 'This challenge has ended.');
    if (action !== 'accept') {
      c.status = action === 'decline' ? 'declined' : 'cancelled'; await c.save();
      await Profile.updateMany({ studentId: { $in: [c.challengerId, c.opponentId] } }, { $set: { challengeAfter: new Date(Date.now() + COOLDOWN_MS) } });
      return { status: c.status };
    }
    await eligible(c.challengerId, true, c.ruleset); await eligible(c.opponentId, true, c.ruleset);
    const match = await reserveMatch(c.challengerId, c.opponentId, 'pvp', 0, c.ruleset);
    await Challenge.updateOne({ _id: c._id }, { $set: { status: 'accepted', acceptedAt: new Date(), matchId: match._id } });
    return { match: match.handle };
  });
}
async function ownedMatch(id, handle) {
  const match = await Match.findOne({ handle, $or: [{ player1Id: id }, { player2Id: id }] });
  if (!match) throw fail(404, 'MATCH_UNAVAILABLE', 'This game is unavailable.');
  return match;
}
async function matchView(id, match, state = match.state) {
  const ids = [match.player1Id, match.player2Id].filter(Boolean);
  const users = await User.find({ _id: { $in: ids } }).select('name').lean();
  const profiles = await Profile.find({ studentId: { $in: ids } }).select('studentId handle').lean();
  return { handle: match.handle, status: match.status, reason: match.reason, side: same(match.player1Id, id) ? 0 : 1,
    players: [match.player1Id, match.player2Id].map(key => key ? { name: privateName(users.find(u => same(u._id, key))?.name), handle: profiles.find(p => same(p.studentId, key))?.handle } : { name: 'Computer', handle: null }), state: physics.view(state) };
}
async function endMatch(matchId, status, reason = '', state = null, owner = null) {
  return transaction(async () => {
    const match = await Match.findOne({ _id: matchId, status: 'active', ...(owner ? { engineOwner: owner, leaseUntil: { $gt: new Date() } } : {}) });
    if (!match) return false;
    if (state) match.state = state;
    const ids = [match.player1Id, match.player2Id].filter(Boolean);
    if (status === 'complete') {
      // WHY: A teacher disable or archived account always wins over a pending
      // score publication. Both participants are checked inside the transaction.
      for (const id of ids) {
        const p = await Profile.findOne({ studentId: id });
        if (!allowed(p, match.mode, match.state.ruleset) || !await User.exists({ _id: id, isArchived: { $ne: true }, role: 'student' })) { status = 'disabled'; reason = 'Game access changed. Your earlier progress is saved.'; }
      }
      if (!['complete', 'lost'].includes(match.state.phase)) throw fail(409, 'RESULT_NOT_READY', 'The game has not ended.');
    }
    match.status = status; match.reason = reason; match.endedAt = new Date(); match.resultApplied = true;
    await match.save();
    for (const [side, id] of ids.entries()) {
      const update = { $set: { activeMatchId: null, presenceAt: new Date() } };
      if (status === 'complete') {
        update.$inc = { matchesPlayed: 1 };
        update.$max = { bestRally: match.state.longestRally };
        if (match.mode === 'computer' && match.state.completed) {
          update.$inc.computerWins = 1; update.$addToSet = { completedLevels: match.level };
          update.$max.highestUnlocked = Math.min(15, match.level + 1);
        } else if (match.mode === 'pvp') update.$inc[match.state.winner === side ? 'multiplayerWins' : 'multiplayerLosses'] = 1;
      }
      await Profile.updateOne({ studentId: id, activeMatchId: match._id }, update);
    }
    console.info('[pong] Match ended', { mode: match.mode, status });
    return true;
  });
}
async function migrateProfiles() {
  await Promise.all([Profile.init(), Match.init(), Challenge.init()]);
  const schools = await require('../models/School').find({ active: true }).lean();
  for (const school of schools) await runInSchool(school._id, async () => {
    await Profile.updateMany({ 'access.powerBattle': { $exists: false } }, { $set: { 'access.powerBattle': false } });
    const students = await User.find({ role: 'student', isArchived: { $ne: true } }).select('_id').lean();
    for (const student of students) await profile(student._id);
  });
  console.info('[pong] Additive profile migration ready');
}
module.exports = { fail, profile, allowed, me, lobby, challenge, respond, startComputer, getAccess, setAccess, ownedMatch, matchView, endMatch, migrateProfiles, privateName, activeStudent, PRESENCE_MS };
