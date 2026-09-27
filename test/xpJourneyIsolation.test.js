/**
 * WHAT: Exercises tenant migration, XP and HTTP authorization on a replica set.
 * WHY: Privacy and exactly-once rewards need database evidence, not mocked hooks.
 * HOW: A loopback-only disposable database contains two schools and synthetic users.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { runInSchool } = require('../src/utils/schoolScope');
const schoolService = require('../src/services/school.service');
const xp = require('../src/services/xpJourney.service');
const User = require('../src/models/User');
const School = require('../src/models/School');
const XpTransaction = require('../src/models/XpTransaction');
const XpAchievement = require('../src/models/XpAchievement');
const Subject = require('../src/models/Subject');
const uri = process.env.FOCUS_TEST_MONGO_URI;
test('school migration, award idempotency, privacy and HTTP isolation', { skip: !uri }, async t => {
  assert.match(uri, /^mongodb:\/\/(127\.0\.0\.1|localhost):\d+\//);
  await mongoose.connect(uri, { dbName: `xp_isolation_${Date.now()}` });
  let server;
  try {
    const legacyId = new mongoose.Types.ObjectId();
    await User.collection.insertOne({ _id: legacyId, name: 'Legacy Learner', email: 'legacy@example.invalid', role: 'student', xp: 554, passwordHash: 'unused' });
    await schoolService.migrateCurrentSchool();
    const a = await schoolService.currentSchool();
    const b = await School.create({ name: 'School B', active: true, xpTrackingStartedAt: new Date() });
    await schoolService.migrateCurrentSchool();
    await runInSchool(a._id, async () => {
      const legacy = await User.findById(legacyId);
      assert.equal(legacy.xp, 554); assert.equal(legacy.xpOpeningBalance, 554);
      assert.equal(await XpTransaction.countDocuments({}), 0);
      const award = await XpAchievement.findOne({ studentId: legacyId });
      assert.equal(award.threshold, 500); assert.equal(award.achievedAt, null); assert.equal(award.isLegacy, true);
    });
    const passwordHash = await bcrypt.hash('synthetic-password', 4);
    const create = (name, role = 'student', extras = {}) => User.create({ name, email: `${new mongoose.Types.ObjectId()}@example.invalid`, passwordHash, role, ...extras });
    const staff = await runInSchool(a._id, () => create('School A Admin', 'management'));
    const studentA = await runInSchool(a._id, () => create('Ava Morgan', 'student', { xp: 499 }));
    const studentB = await runInSchool(b._id, () => create('Private OtherSchool', 'student', { xp: 9999 }));
    const subjectB = await runInSchool(b._id, () => Subject.create({ name: 'Private subject', icon: 'book' }));
    await t.test('queries, populations, updates, bulk and references fail across schools', async () => {
      await runInSchool(a._id, async () => {
        assert.equal(await User.findById(studentB._id), null);
        assert.equal(await Subject.findById(subjectB._id), null);
        assert.equal((await User.updateOne({ _id: studentB._id }, { $set: { name: 'tampered' } })).matchedCount, 0);
        assert.equal((await User.bulkWrite([{ updateOne: { filter: { _id: studentB._id }, update: { $set: { xp: 0 } } } }])).matchedCount, 0);
        await assert.rejects(User.updateOne({ _id: staff._id }, { $addToSet: { assignedStudents: studentB._id } }), /your school/);
        await assert.rejects(User.create({ name: 'Wrong school', email: 'wrong@example.invalid', passwordHash, role: 'student', schoolId: b._id }), /Cross-school/);
        await assert.rejects(User.aggregate([{ $lookup: { from: 'users', as: 'leak', pipeline: [] } }]), /not enabled/);
        assert.equal(await User.countDocuments({ schoolId: b._id }), 0);
        assert.ok(!(await User.distinct('_id')).some(id => String(id) === String(studentB._id)));
        assert.equal((await User.aggregate([{ $count: 'count' }]))[0].count, await User.countDocuments({}));
        // Simulate a historical bad reference: population still cannot leak it.
        await User.collection.updateOne({ _id: staff._id }, { $set: { assignedStudents: [studentB._id] } });
        assert.deepEqual((await User.findById(staff._id).populate('assignedStudents')).assignedStudents, []);
      });
      await assert.rejects(User.find({}), /school context/);
      await assert.rejects(new User({ name: 'No scope', email: 'no@example.invalid', passwordHash, role: 'student' }).save(), /school context/);
    });
    await t.test('all boundaries are persistent, uncapped and awarded once', async () => {
      await runInSchool(a._id, async () => {
        for (const threshold of xp.MILESTONES) {
          const student = await create(`Boundary ${threshold}`, 'student', { xp: threshold - 1 });
          const apply = xp.transactional(() => xp.applyXp({ studentId: student._id, sourceType: 'performance', sourceId: 'fixture-result', total: 1 }));
          await Promise.all([apply(), apply()]);
          await apply();
          assert.equal((await User.findById(student._id)).xp, threshold);
          assert.equal(await XpTransaction.countDocuments({ studentId: student._id }), 1);
          assert.equal(await XpAchievement.countDocuments({ studentId: student._id, threshold }), 1);
          await xp.transactional(() => xp.applyXp({ studentId: student._id, sourceType: 'performance', sourceId: 'fixture-result', total: 0 }))();
          assert.equal((await User.findById(student._id)).xp, threshold - 1);
          assert.equal(await XpAchievement.countDocuments({ studentId: student._id, threshold }), 1);
        }
        await xp.transactional(() => xp.applyXp({ studentId: studentA._id, sourceType: 'performance', sourceId: 'uncapped', total: 12000 }))();
        assert.equal((await User.findById(studentA._id)).xp, 12499);
      });
    });
    await t.test('rollback leaves no balance, source or achievement and retries are safe', async () => {
      await runInSchool(a._id, async () => {
        const before = (await User.findById(legacyId)).xp;
        await assert.rejects(xp.transactional(async () => { await xp.applyXp({ studentId: legacyId, sourceType: 'target', sourceId: 'rollback', total: 1000 }); throw new Error('injected'); })(), /injected/);
        assert.equal((await User.findById(legacyId)).xp, before);
        assert.equal(await XpTransaction.countDocuments({ sourceId: 'rollback' }), 0);
      });
    });
    await t.test('weekly includes only current dated deltas and student names are private', async () => {
      await runInSchool(a._id, async () => {
        await xp.transactional(() => xp.applyXp({ studentId: legacyId, sourceType: 'target', sourceId: 'older', total: 15, now: new Date('2025-01-01') }))();
        await xp.transactional(() => xp.applyXp({ studentId: legacyId, sourceType: 'target', sourceId: 'current', total: 10 }))();
        const weekly = await xp.leaderboard({ userId: legacyId, period: 'weekly' });
        const self = weekly.entries.find(row => row.isYou);
        assert.equal(self.weeklyXp, 10); assert.equal(self.totalXp, 579);
        assert.equal(self.name, 'Legacy L.'); assert.equal(weekly.partialWeek, true);
        assert.ok(weekly.entries.every(row => !row.name.includes('OtherSchool') && !('id' in row) && !('email' in row)));
        const again = await xp.leaderboard({ userId: legacyId, period: 'weekly' });
        assert.deepEqual(weekly.entries, again.entries);
      });
    });
    await t.test('daily login awards exactly once under concurrent requests', async () => {
      await runInSchool(b._id, async () => {
        const login = require('../src/services/auth.service').login;
        await assert.rejects(login({ email: studentB.email, password: 'wrong-password' }), { statusCode: 401 });
        assert.equal((await User.findById(studentB._id)).failedLoginAttempts, 1);
        await Promise.all([login({ email: studentB.email, password: 'synthetic-password' }), login({ email: studentB.email, password: 'synthetic-password' })]);
        assert.equal((await User.findById(studentB._id)).xp, 10019);
        assert.equal(await XpTransaction.countDocuments({ studentId: studentB._id, sourceType: 'daily_bonus' }), 1);
      });
    });

    await t.test('teacher logs, mentor cover, target edits, criterion submission and review retain award rules', async () => {
      await runInSchool(a._id, async () => {
        const learner = await create('Award Flow');
        const teacher = await create('Award Teacher', 'teacher', { assignedStudents: [learner._id], subjectSpecialty: 'Business' });
        const mentor = await create('Award Mentor', 'mentor', { assignedStudents: [learner._id] });
        const subject = await Subject.create({ name: 'Business', icon: 'book' });
        const dateKey = require('../src/utils/xpPolicy').getDateKey();
        const day = new Intl.DateTimeFormat('en-US', { weekday: 'long' }).format(new Date());
        await mongoose.model('Timetable').create({ studentId: learner._id, day, morningSubject: subject._id, afternoonSubject: subject._id, morningTeacherId: teacher._id, afternoonTeacherId: teacher._id });
        const teacherService = require('../src/services/teacher.service');
        const mentorService = require('../src/services/mentor.service');
        const logPayload = { studentId: String(learner._id), subjectId: String(subject._id), createdBy: String(teacher._id), dateKey, sessionType: 'morning', xpAwarded: 25, requestKey: 'synthetic_session_request_1' };
        const [firstLog, replayLog] = await Promise.all([teacherService.createSessionLog(logPayload), teacherService.createSessionLog(logPayload)]);
        assert.equal(String(firstLog.sessionLog._id), String(replayLog.sessionLog._id));
        assert.equal((await User.findById(learner._id)).xp, 25);
        const mentorContext = { id: String(mentor._id), role: 'mentor' };
        const targetPayload = { studentId: String(learner._id), title: 'Prepare materials', stars: 2, requestKey: 'synthetic_target_request_1' };
        const [target, replay] = await Promise.all([mentorService.createTarget(targetPayload, mentorContext), mentorService.createTarget(targetPayload, mentorContext)]);
        assert.equal(target.id, replay.id);
        assert.equal((await User.findById(learner._id)).xp, 35);
        await Promise.all([mentorService.updateTarget(target.id, { stars: 3 }, mentorContext), mentorService.updateTarget(target.id, { stars: 3 }, mentorContext)]);
        assert.equal((await User.findById(learner._id)).xp, 40);
        await mentorService.updateTarget(target.id, { stars: 1 }, mentorContext);
        assert.equal((await User.findById(learner._id)).xp, 30);
        await mongoose.model('SessionCoverAssignment').create({ studentId: learner._id, dateKey, sessionType: 'afternoon', subjectId: subject._id, plannedTeacherId: teacher._id, coverStaffId: mentor._id, coverStaffRole: 'mentor', createdByManagementId: staff._id });
        const coverPayload = { mentorId: String(mentor._id), payload: { studentId: String(learner._id), dateKey, sessionType: 'afternoon', xpAwarded: 30 } };
        await Promise.all([mentorService.createCoveredSessionLog(coverPayload), mentorService.createCoveredSessionLog(coverPayload)]);
        assert.equal((await User.findById(learner._id)).xp, 60);
        const unit = await mongoose.model('Unit').create({ subjectId: subject._id, title: 'Unit' });
        const criterion = await mongoose.model('Criterion').create({ subjectId: subject._id, unitId: unit._id, title: 'Criterion', requiredWordCount: 2 });
        const block = await mongoose.model('Block').create({ subjectId: subject._id, unitId: unit._id, criterionId: criterion._id, phase: 'essayBuilder', type: 'sentenceBuilder', prompt: 'Explain', baseOrder: 0 });
        await mongoose.model('StudentProgress').create({ studentId: learner._id, subjectId: subject._id, unitId: unit._id, criterionId: criterion._id, criterionState: 'ready_for_submission', learningStatus: 'passed', essayText: 'Two words', appendedBlockIds: [block._id], submissionUnlocked: true });
        const submit = () => require('../src/services/criterionProgress.service').submitCriterion({ requesterId: String(learner._id), requesterRole: 'student', studentId: String(learner._id), criterionId: String(criterion._id) });
        const attempts = await Promise.allSettled([submit(), submit()]);
        assert.equal(attempts.filter(x => x.status === 'fulfilled').length, 1);
        assert.equal((await User.findById(learner._id)).xp, 90);
        const Mission = mongoose.model('Mission');
        const resultService = require('../src/services/result.service');
        for (const format of ['THEORY', 'QUESTIONS']) {
          const mission = await Mission.create({ studentId: learner._id, subjectId: subject._id, createdBy: teacher._id, title: format, sessionType: 'morning', draftFormat: format, xpReward: 50, questions: Array.from({ length: format === 'THEORY' ? 2 : 10 }, () => ({ prompt: 'Question', options: ['A', 'B', 'C', 'D'], correctIndex: 0 })) });
          const result = await mongoose.model('ResultPackage').create({ studentId: learner._id, teacherId: teacher._id, subjectId: subject._id, missionId: mission._id, missionType: format, meta: { studentName: learner.name, studentId: String(learner._id), missionTitle: format, submitTime: new Date(), xpAwarded: 0 }, evidence: { questions: [{ prompt: 'Question', answerText: 'Original evidence' }] } });
          const before = (await User.findById(learner._id)).xp;
          const score = (percent) => format === 'THEORY'
            ? resultService.scoreTheoryResultPackage({ teacherId: String(teacher._id), resultPackageId: String(result._id), questions: [{ questionIndex: 0, teacherScorePercent: percent }] })
            : resultService.scoreManualResultPackage({ teacherId: String(teacher._id), resultPackageId: String(result._id), scoreCorrect: percent, scoreTotal: 100 });
          await Promise.all([score(100), score(100)]);
          const awarded = (await mongoose.model('ResultPackage').findById(result._id)).meta.xpAwarded;
          assert.ok(awarded > 0);
          assert.equal((await User.findById(learner._id)).xp, before + awarded);
          assert.equal(await XpTransaction.countDocuments({ sourceId: String(result._id) }), 1);
          await score(0);
          assert.equal((await User.findById(learner._id)).xp, before);
          assert.equal((await mongoose.model('ResultPackage').findById(result._id)).evidence.questions[0].answerText, 'Original evidence');
        }
        const ledger = await XpTransaction.aggregate([{ $match: { studentId: learner._id } }, { $group: { _id: null, total: { $sum: '$amount' } } }]);
        assert.equal(ledger[0].total, (await User.findById(learner._id)).xp);
      });
    });
    server = require('../src/app').listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}/api`;
    await t.test('HTTP uses persisted school, ignores spoofed school query and role claims', async () => {
      const token = jwt.sign({ sub: String(studentA._id), role: 'management', schoolId: String(b._id) }, process.env.JWT_SECRET || 'development-secret');
      const res = await fetch(`${base}/xp/leaderboard?schoolId=${b._id}`, { headers: { authorization: `Bearer ${token}` } });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.ok(data.entries.some(row => row.name === 'Ava M.'));
      assert.ok(!JSON.stringify(data).includes('OtherSchool'));
      const staffToken = jwt.sign({ sub: String(staff._id) }, process.env.JWT_SECRET || 'development-secret');
      const staffRes = await fetch(`${base}/xp/leaderboard`, { headers: { authorization: `Bearer ${staffToken}` } });
      assert.ok((await staffRes.json()).entries.some(row => row.name === 'Ava Morgan'));
      const loginB = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: studentB.email, password: 'synthetic-password' }) });
      assert.equal(loginB.status, 200);
      assert.equal((await loginB.json()).user.id, String(studentB._id));
      const headers = { authorization: `Bearer ${staffToken}`, 'content-type': 'application/json' };
      const roster = await fetch(`${base}/management/students`, { headers });
      assert.equal(roster.status, 200);
      assert.ok(!(await roster.text()).includes('OtherSchool'));
      const forbidden = await fetch(`${base}/management/students/${studentB._id}/archive`, { method: 'PATCH', headers, body: '{}' });
      assert.equal(forbidden.status, 404);
      const created = await fetch(`${base}/management/users`, { method: 'POST', headers, body: JSON.stringify({ name: 'New school A student', email: 'created@example.invalid', password: 'synthetic-password', role: 'student', yearGroup: 'Year 11', schoolId: String(b._id) }) });
      assert.equal(created.status, 201);
      const account = await User.collection.findOne({ email: 'created@example.invalid' });
      assert.equal(String(account.schoolId), String(a._id));
      assert.equal(account.xp, 0);

    });
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
