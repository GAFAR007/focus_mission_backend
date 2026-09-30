/**
 * WHAT: Tests Pong persistence, races, school privacy and realtime authority.
 * WHY: Mock queries cannot prove transaction isolation or exactly-once results.
 * HOW: Synthetic users in two schools exercise a disposable loopback replica set.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const User = require('../src/models/User');
const School = require('../src/models/School');
const Profile = require('../src/models/PongProfile');
const Match = require('../src/models/PongMatch');
const Challenge = require('../src/models/PongChallenge');
const service = require('../src/services/pong.service');
const runtime = require('../src/services/pongRuntime.service');
const physics = require('../src/services/pongPhysics');
const { runInSchool } = require('../src/utils/schoolScope');
const uri = process.env.FOCUS_TEST_MONGO_URI;
test('Pong school boundaries, transactions and authoritative sessions', { skip: !uri }, async t => {
  assert.match(uri, /^mongodb:\/\/(127\.0\.0\.1|localhost):\d+\//);
  await mongoose.connect(uri, { dbName: `pong_${Date.now()}` });
  let server;
  try {
    const school = await School.create({ name: 'Pong Test School', active: true, xpTrackingStartedAt: new Date() });
    const otherSchool = await School.create({ name: 'Other School', active: true, xpTrackingStartedAt: new Date() });
    const create = (name, role = 'student', extra = {}) => User.create({ name, email: `${new mongoose.Types.ObjectId()}@example.invalid`, passwordHash: 'unused', role, xp: 123, ...extra });
    const foreign = await runInSchool(otherSchool._id, () => create('Foreign Private'));
    await runInSchool(school._id, async () => {
      const a = await create('Ava Alpha'), b = await create('Ben Bravo'), c = await create('Cora Charlie');
      const teacher = await create('Assigned Teacher', 'teacher', { assignedStudents: [a._id, b._id, c._id] });
      const stranger = await create('Other Teacher', 'teacher');
      const management = await create('Admin', 'management');
      const enable = id => service.setAccess(teacher._id, id, { enabled: true, computer: true, battles: true, lobbyVisible: true });
      const online = async () => { for (const id of [a._id, b._id, c._id]) await service.me(id); };
      const cooldown = () => Profile.updateMany({}, { $set: { challengeAfter: null } });
      await t.test('additive migration is idempotent and access starts off', async () => {
        await service.migrateProfiles(); await service.migrateProfiles();
        assert.equal(await Profile.countDocuments({}), 3);
        assert.equal((await service.me(a._id)).access.enabled, false);
        await assert.rejects(service.startComputer(a._id, 1), { code: 'PONG_DISABLED' });
        await assert.rejects(service.lobby(a._id), { code: 'PONG_DISABLED' });
        assert.equal((await User.findById(a._id)).xp, 123);
      });
      await t.test('assigned teachers and management only; cross-school IDs fail closed', async () => {
        await assert.rejects(service.setAccess(a._id, a._id, { enabled: true }), { code: 'PONG_STAFF_REQUIRED' });
        await assert.rejects(service.setAccess(stranger._id, a._id, { enabled: true }), { code: 'PONG_STAFF_REQUIRED' });
        await assert.rejects(service.setAccess(management._id, foreign._id, { enabled: true }), { code: 'STUDENT_UNAVAILABLE' });
        for (const id of [a._id, b._id, c._id]) await enable(id);
        await service.setAccess(management._id, a._id, { computer: false });
        await assert.rejects(service.startComputer(a._id, 1), { code: 'PONG_DISABLED' });
        await enable(a._id);
      });
      await t.test('15 sequential level results persist once; replays and toggles retain progress', async () => {
        await assert.rejects(service.startComputer(a._id, 2), { code: 'LEVEL_LOCKED' });
        for (let level = 1; level <= 15; level++) {
          const started = await service.startComputer(a._id, level);
          await assert.rejects(service.startComputer(a._id, level), { code: 'PONG_BUSY' });
          const match = await service.ownedMatch(a._id, started.match), state = physics.createState('computer', level, 1);
          for (let i = 0; i < 60000 && !['complete', 'lost'].includes(state.phase); i++) {
            const flight = state.ball.vx < 0 ? (state.ball.x - physics.WORLD.left) / -state.ball.vx : 0;
            physics.step(state, [{ targetY: flight > 0 ? physics.reflectedY(state.ball.y + state.ball.vy * flight) : state.ball.y }], 1 / 60);
          }
          assert.equal(state.completed, true);
          const results = await Promise.all([service.endMatch(match._id, 'complete', '', state), service.endMatch(match._id, 'complete', '', state)]);
          assert.equal(results.filter(Boolean).length, 1);
          const progress = (await service.me(a._id)).progress;
          assert.equal(progress.highestUnlocked, Math.min(15, level + 1));
          assert.equal(progress.computerWins, level); assert.equal(progress.completedLevels.length, level);
        }
        const before = (await service.me(a._id)).progress;
        await service.setAccess(teacher._id, a._id, { enabled: false }); await enable(a._id);
        assert.deepEqual((await service.me(a._id)).progress, before);
        const replay = await service.startComputer(a._id, 1);
        await service.setAccess(teacher._id, a._id, { computer: false });
        assert.equal((await service.ownedMatch(a._id, replay.match)).status, 'disabled');
        assert.deepEqual((await service.me(a._id)).progress, before);
        await enable(a._id);
      });
      await t.test('lobby exposes only private names and game handles within the school', async () => {
        await online();
        const data = await service.lobby(a._id);
        assert.equal(data.students.length, 2); assert.ok(data.students.some(student => student.name === 'Ben B.'));
        const json = JSON.stringify(data);
        for (const forbidden of ['Bravo', 'Charlie', 'Foreign', String(b._id), 'email', 'schoolId', 'xp', 'presenceAt']) assert.ok(!json.includes(forbidden), forbidden);
        await service.setAccess(teacher._id, c._id, { battles: false });
        assert.equal((await service.lobby(a._id)).students.length, 1);
        const foreignProfile = await runInSchool(otherSchool._id, () => service.profile(foreign._id));
        await assert.rejects(service.challenge(a._id, foreignProfile.handle), { code: 'OPPONENT_UNAVAILABLE' });
        await assert.rejects(service.challenge(a._id, (await service.profile(c._id)).handle), { code: 'PONG_DISABLED' });
        await enable(c._id);
      });
      await t.test('cancel, decline, expiry, cooldown and invitation ownership', async () => {
        await online(); const target = (await service.profile(b._id)).handle;
        let invite = await service.challenge(a._id, target);
        await assert.rejects(service.respond(c._id, invite.handle, 'accept'), { code: 'CHALLENGE_UNAVAILABLE' });
        await service.respond(a._id, invite.handle, 'cancel');
        await assert.rejects(service.challenge(a._id, target), { code: 'PONG_COOLDOWN' });
        await cooldown(); invite = await service.challenge(a._id, target);
        await service.respond(b._id, invite.handle, 'decline');
        await cooldown(); invite = await service.challenge(a._id, target);
        await Challenge.updateOne({ handle: invite.handle }, { $set: { expiresAt: new Date(0) } });
        await assert.rejects(service.respond(b._id, invite.handle, 'accept'), { code: 'CHALLENGE_CLOSED' });
        assert.equal((await service.me(b._id)).progress.multiplayerLosses, 0);
      });
      await t.test('accept races reserve exactly one match, busy players cannot start another', async () => {
        await cooldown(); await online(); const target = (await service.profile(b._id)).handle;
        const first = await service.challenge(a._id, target), second = await service.challenge(c._id, target);
        const results = await Promise.allSettled([service.respond(b._id, first.handle, 'accept'), service.respond(b._id, second.handle, 'accept')]);
        assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
        const handle = results.find(x => x.status === 'fulfilled').value.match;
        const match = await service.ownedMatch(b._id, handle);
        const accepted = await Challenge.findOne({ matchId: match._id });
        const retry = await service.respond(b._id, accepted.handle, 'accept'); assert.equal(retry.match, handle);
        assert.equal(await Match.countDocuments({ status: 'active' }), 1);
        await assert.rejects(service.startComputer(b._id, 1), { code: 'PONG_BUSY' });
        assert.equal(await Challenge.countDocuments({ status: 'pending' }), 0);
        const state = match.state; state.phase = 'playing'; state.score = [6, 0]; state.ball = { x: 1007, y: 10, vx: 315, vy: 0 };
        physics.step(state, [{}, {}], 1 / 60);
        await Promise.all([service.endMatch(match._id, 'complete', '', state), service.endMatch(match._id, 'complete', '', state)]);
        const winner = await service.profile(match.player1Id), loser = await service.profile(match.player2Id);
        assert.equal(winner.multiplayerWins, 1); assert.equal(loser.multiplayerLosses, 1);
        await cooldown(); await online();
        const rematch = await service.challenge(match.player1Id, loser.handle, handle);
        assert.equal(await Match.countDocuments({ status: 'active' }), 0);
        const replay = await service.respond(match.player2Id, rematch.handle, 'accept');
        assert.notEqual(replay.match, handle);
        await service.setAccess(teacher._id, match.player2Id, { battles: false });
        assert.equal((await service.ownedMatch(match.player1Id, replay.match)).status, 'disabled');
        assert.equal((await service.profile(match.player1Id)).multiplayerWins, 1);
        await enable(match.player2Id);
      });
      await t.test('Power Battle is explicit, separately controlled and cannot weaken Classic or progress', async () => {
        await cooldown(); await online();
        const handle = (await service.profile(b._id)).handle;
        const before = (await service.me(a._id)).progress;
        await assert.rejects(service.challenge(a._id, handle, null, 'power'), { code: 'PONG_DISABLED' });
        for (const id of [a._id, b._id]) await service.setAccess(teacher._id, id, { powerBattle: true });
        let invitation = await service.challenge(a._id, handle, null, 'power');
        const incoming = (await service.lobby(b._id)).challenges.find(c => c.handle === invitation.handle);
        assert.equal(incoming.ruleset, 'power');
        await assert.rejects(service.respond(b._id, invitation.handle, 'accept'), { code: 'PONG_RULESET' });
        await assert.rejects(service.respond(b._id, invitation.handle, 'accept', 'classic'), { code: 'PONG_RULESET' });
        const accepted = await service.respond(b._id, invitation.handle, 'accept', 'power');
        assert.equal((await service.ownedMatch(a._id, accepted.match)).state.ruleset, 'power');
        await service.setAccess(teacher._id, b._id, { powerBattle: false });
        assert.equal((await service.ownedMatch(a._id, accepted.match)).status, 'disabled');
        await cooldown(); await online(); invitation = await service.challenge(a._id, handle);
        const classic = await service.respond(b._id, invitation.handle, 'accept', 'classic');
        await service.setAccess(teacher._id, a._id, { powerBattle: false });
        const match = await service.ownedMatch(a._id, classic.match);
        assert.equal(match.status, 'active'); assert.equal(match.state.ruleset, 'classic');
        await service.endMatch(match._id, 'abandoned');
        assert.deepEqual((await service.me(a._id)).progress, before);
        // Existing profiles acquire only the new default; all historical stats survive.
        await Profile.collection.updateOne({ studentId: a._id, schoolId: school._id }, { $unset: { 'access.powerBattle': '' } });
        await service.migrateProfiles(); await service.migrateProfiles();
        assert.equal((await service.me(a._id)).access.powerBattle, false);
        assert.deepEqual((await service.me(a._id)).progress, before);
        await service.setAccess(teacher._id, a._id, { powerBattle: true });
        await service.setAccess(teacher._id, b._id, { powerBattle: true });
        await cooldown(); await online(); invitation = await service.challenge(a._id, handle, null, 'power');
        await service.setAccess(teacher._id, b._id, { powerBattle: false });
        await assert.rejects(service.respond(b._id, invitation.handle, 'accept', 'power'), { code: 'CHALLENGE_CLOSED' });
        assert.equal((await User.findById(a._id)).xp, 123);
      });
      server = require('../src/app').listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
      const base = `http://127.0.0.1:${server.address().port}/api/pong`;
      const headers = id => ({ authorization: `Bearer ${jwt.sign({ sub: String(id), role: 'management', schoolId: String(otherSchool._id) }, process.env.JWT_SECRET || 'development-secret')}`, 'content-type': 'application/json' });
      const post = (id, path, data) => fetch(base + path, { method: 'POST', headers: headers(id), body: JSON.stringify(data) });
      await t.test('HTTP rejects spoofed schools, student permission writes and forged scores', async () => {
        assert.equal((await fetch(base + '/me')).status, 401);
        assert.equal((await fetch(base + `/access/${a._id}`, { method: 'PATCH', headers: headers(a._id), body: '{"enabled":true}' })).status, 403);
        const lobby = await fetch(base + `/lobby?schoolId=${otherSchool._id}`, { headers: headers(a._id) });
        assert.equal(lobby.status, 200); assert.ok(!(await lobby.text()).includes('Foreign'));
        assert.equal((await post(a._id, '/computer', { level: 1, score: 7 })).status, 400);
        const started = await service.startComputer(a._id, 1);
        assert.equal((await post(a._id, `/matches/${started.match}/input`, { winner: 0, score: [7, 0] })).status, 400);
        assert.equal((await fetch(base + `/matches/${started.match}`, { headers: headers(b._id) })).status, 404);
        const match = await service.ownedMatch(a._id, started.match); await service.endMatch(match._id, 'abandoned');
      });
      await t.test('authenticated stream synchronizes state, replaces stale controllers and pauses for reconnect', async () => {
        const started = await service.startComputer(a._id, 1);
        const abort = new AbortController();
        const response = await fetch(base + `/matches/${started.match}/stream`, { headers: headers(a._id), signal: abort.signal });
        assert.equal(response.status, 200);
        const reader = response.body.getReader(), decoder = new TextDecoder();
        const first = decoder.decode((await reader.read()).value); const frame = JSON.parse(first.split('\n')[0].slice(6));
        assert.ok(frame.controlToken); assert.equal(frame.side, 0);
        const control = await post(a._id, `/matches/${started.match}/input`, { controlToken: frame.controlToken, seq: 0, direction: 1 }); assert.equal(control.status, 200);
        await runtime.control(a._id, started.match, 'pause');
        const reconnectAbort = new AbortController();
        const reconnect = await fetch(base + `/matches/${started.match}/stream`, { headers: headers(a._id), signal: reconnectAbort.signal });
        const next = JSON.parse(decoder.decode((await reconnect.body.getReader().read()).value).split('\n')[0].slice(6));
        assert.notEqual(next.controlToken, frame.controlToken); assert.equal(next.paused, true);
        assert.equal((await post(a._id, `/matches/${started.match}/input`, { controlToken: frame.controlToken, seq: 1, direction: 1 })).status, 409);
        abort.abort(); reconnectAbort.abort();
        await runtime.control(a._id, started.match, 'leave');
        const saved = await service.ownedMatch(a._id, started.match); assert.equal(saved.status, 'abandoned');
        assert.equal(saved.state.winner, null);
      });
      await t.test('two live streams publish the same server-owned seven-point result', async () => {
        await cooldown(); await online();
        const invitation = await service.challenge(a._id, (await service.profile(b._id)).handle);
        const accepted = await service.respond(b._id, invitation.handle, 'accept');
        const match = await service.ownedMatch(a._id, accepted.match);
        // A near-point fixture exercises real runtime collision, broadcast and
        // transaction publication without waiting through seven full rallies.
        const state = match.state; state.phase = 'playing'; state.score = [6, 0]; state.ball = { x: 1007, y: 10, vx: 315, vy: 0 };
        await Match.updateOne({ _id: match._id }, { $set: { state } });
        const read = async id => {
          const response = await fetch(base + `/matches/${accepted.match}/stream`, { headers: headers(id) });
          assert.equal(response.status, 200);
          let text = '';
          for await (const chunk of response.body) text += new TextDecoder().decode(chunk);
          return text.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
        };
        const [left, right] = await Promise.all([read(a._id), read(b._id)]);
        assert.equal(left[0].side, 0); assert.equal(right[0].side, 1);
        assert.deepEqual(left.at(-1).state.score, [7, 0]);
        assert.deepEqual(left.at(-1).state, right.at(-1).state);
        assert.equal(left.at(-1).status, 'complete');
        assert.equal((await Match.findById(match._id)).resultApplied, true);
        assert.equal((await service.profile(a._id)).activeMatchId, null);
      });
      await t.test('foreign engine lease fails closed and permanent disconnect has no winner', async () => {
        const started = await service.startComputer(a._id, 1);
        const match = await service.ownedMatch(a._id, started.match);
        await Match.updateOne({ _id: match._id }, { $set: { engineOwner: 'another-process', leaseUntil: new Date(Date.now() + 8000) } });
        const denied = await fetch(base + `/matches/${started.match}/stream`, { headers: headers(a._id) });
        assert.equal(denied.status, 503);
        await Match.updateOne({ _id: match._id }, { $set: { leaseUntil: new Date(0) } });
        const abort = new AbortController();
        const response = await fetch(base + `/matches/${started.match}/stream`, { headers: headers(a._id), signal: abort.signal });
        assert.equal(response.status, 200);
        await response.body.getReader().read(); abort.abort();
        const before = (await service.me(a._id)).progress;
        await new Promise(resolve => setTimeout(resolve, runtime.GRACE_MS + 1200));
        const ended = await Match.findById(match._id);
        assert.equal(ended.status, 'abandoned'); assert.equal(ended.state.winner, null);
        assert.deepEqual((await service.me(a._id)).progress, before);
        await service.migrateProfiles();
        assert.deepEqual((await service.me(a._id)).progress, before);
      });
      await t.test('academic data and XP remain untouched', async () => {
        for (const id of [a._id, b._id, c._id]) assert.equal((await User.findById(id)).xp, 123);
        assert.equal(await mongoose.model('XpTransaction').countDocuments({}), 0);
      });
    });
  } finally {
    runtime.stopAll(); if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await mongoose.connection.dropDatabase(); await mongoose.disconnect();
  }
});
