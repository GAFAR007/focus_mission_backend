/**
 * WHAT: Verifies school resolution, legacy repair and mission HTTP workflows.
 * WHY: Valid single-school users must work while cross-school requests fail closed.
 * HOW: Use a loopback-only disposable replica set and real routes/persistence;
 * replace only external AI generation with deterministic synthetic content.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { runInSchool } = require('../src/utils/schoolScope');
const schoolService = require('../src/services/school.service');
const School = require('../src/models/School');
const User = require('../src/models/User');
const Subject = require('../src/models/Subject');
const Timetable = require('../src/models/Timetable');
const Mission = require('../src/models/Mission');
const groq = require('../src/services/groq.service');
groq.planUnitFromSourceWithGroq = async () => ({ unitTitle: 'Fixture lesson', keyPoints: ['Business'], suggestedQuestionCount: 5 });
groq.generateMissionWithGroq = async ({ questionCount }) => ({
  teacherNote: 'Synthetic lesson', aiModel: 'fixture',
  questions: Array.from({ length: questionCount }, (_, i) => ({
    prompt: `What does business ${i + 1} provide?`, learningText: 'Businesses provide goods and services to customers.',
    options: ['Goods and services', 'Nothing', 'Only silence', 'No products'], correctIndex: 0,
    expectedAnswer: 'Goods and services', explanation: 'Businesses meet customer needs.',
  })),
});
groq.generateEssayBuilderDraft = async () => ({ teacherNote: 'Synthetic essay', aiModel: 'fixture', draftJson: { mode: 'NORMAL', sentences: [], targets: { targetSentenceCount: 10 } } });
const app = require('../src/app');
const uri = process.env.FOCUS_TEST_MONGO_URI;

test('legacy sessions and every mission format retain the account school', { skip: !uri }, async t => {
  assert.match(uri, /^mongodb:\/\/(127\.0\.0\.1|localhost):\d+\//);
  await mongoose.connect(uri, { dbName: `school_context_${Date.now()}` });
  let server;
  try {
    const passwordHash = await bcrypt.hash('synthetic-password', 4);
    const legacyId = new mongoose.Types.ObjectId();
    await User.collection.insertOne({ _id: legacyId, name: 'Legacy Teacher', email: 'legacy@fixture.invalid', role: 'teacher', passwordHash, createdAt: new Date('2025-01-01') });
    await schoolService.migrateCurrentSchool();
    const school = await schoolService.currentSchool();
    assert.equal(String((await User.collection.findOne({ _id: legacyId })).schoolId), String(school._id));
    await t.test('late legacy repair is persisted, idempotent and rejects newly unassigned accounts', async () => {
      await User.collection.updateOne({ _id: legacyId }, { $unset: { schoolId: '' } });
      assert.equal(String((await schoolService.resolveIdentitySchool({ _id: legacyId }))._id), String(school._id));
      assert.equal(String((await User.collection.findOne({ _id: legacyId })).schoolId), String(school._id));
      await schoolService.resolveIdentitySchool({ _id: legacyId });
      const fresh = new mongoose.Types.ObjectId();
      await User.collection.insertOne({ _id: fresh, email: 'fresh@fixture.invalid', createdAt: new Date(Date.now() + 10000) });
      await assert.rejects(schoolService.resolveIdentitySchool({ _id: fresh }), /explicit school assignment/);
      assert.equal((await User.collection.findOne({ _id: fresh })).schoolId, undefined);
    });
    const fixture = await runInSchool(school._id, async () => {
      const student = await User.create({ name: 'Fixture Learner', email: 'learner@fixture.invalid', role: 'student', passwordHash });
      const target = await User.create({ name: 'Reuse Learner', email: 'reuse@fixture.invalid', role: 'student', passwordHash });
      const admin = await User.create({ name: 'Fixture Admin', email: 'admin@fixture.invalid', role: 'management', passwordHash });
      const subject = await Subject.create({ name: 'Business', icon: 'business' });
      await User.updateOne({ _id: legacyId }, { $set: { assignedStudents: [student._id, target._id], subjectSpecialty: 'Business' } });
      await Timetable.create({ studentId: student._id, day: 'Monday', morningSubject: subject._id, afternoonSubject: subject._id, morningTeacherId: legacyId, afternoonTeacherId: legacyId });
      await Timetable.create({ studentId: target._id, day: 'Monday', morningSubject: subject._id, afternoonSubject: subject._id, morningTeacherId: legacyId, afternoonTeacherId: legacyId });
      return { student, target, admin, subject };
    });
    server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}/api`;
    // Existing tokens have no school claim; persisted account scope is authoritative.
    const token = jwt.sign({ sub: String(legacyId), role: 'teacher' }, process.env.JWT_SECRET || 'development-secret');
    async function request(path, { method = 'GET', body, auth = token, form } = {}) {
      const res = await fetch(base + path, { method, headers: { ...(form ? {} : { 'Content-Type': 'application/json' }), ...(auth ? { Authorization: `Bearer ${auth}` } : {}) }, ...(form ? { body: form } : body ? { body: JSON.stringify(body) } : {}) });
      return { status: res.status, body: await res.json() };
    }
    await t.test('login and restored sessions expose the persisted school for every role', async () => {
      const login = await request('/auth/login', { method: 'POST', auth: '', body: { email: 'legacy@fixture.invalid', password: 'synthetic-password', role: 'teacher' } });
      assert.equal(login.status, 200, JSON.stringify(login.body)); assert.equal(login.body.user.schoolId, String(school._id));
      for (const user of [{ _id: legacyId, role: 'teacher' }, fixture.student, fixture.admin]) {
        const auth = jwt.sign({ sub: String(user._id), role: user.role }, process.env.JWT_SECRET || 'development-secret');
        const me = await request('/auth/me', { auth }); assert.equal(me.status, 200); assert.equal(me.body.user.schoolId, String(school._id));
      }
      const roster = await request('/teacher/students'); assert.equal(roster.status, 200); assert.equal(roster.body.students[0].schoolId, String(school._id));
    });
    const payload = { studentId: String(fixture.student._id), subjectId: String(fixture.subject._id), sessionType: 'morning', targetDate: '2099-01-05', title: 'Fixture mission', taskCodes: ['P1'], questionCount: 5, difficulty: 'medium', unitText: 'Businesses provide goods and services to customers. This synthetic lesson explains how they meet customer needs.' };
    const created = [];
    for (const [draftFormat, questionCount] of [['QUESTIONS', 5], ['THEORY', 5], ['ESSAY_BUILDER', 5], ['QUESTIONS', 10]]) {
      await t.test(`${draftFormat} Q${questionCount} uploads, generates and saves under the authenticated school`, async () => {
        const form = new FormData();
        for (const [k, v] of Object.entries({ ...payload, draftFormat, questionCount, essayMode: 'NORMAL', uploadMode: 'ai_draft', taskCodes: '["P1"]' })) form.set(k, String(v));
        form.set('schoolId', new mongoose.Types.ObjectId().toString());
        form.set('sourceFile', new Blob([payload.unitText], { type: 'text/plain' }), 'lesson.txt');
        const upload = await request('/teacher/ai/extract-source', { method: 'POST', form });
        assert.equal(upload.status, 200, JSON.stringify(upload.body));
        const generated = await request('/teacher/missions/generate', { method: 'POST', body: { ...payload, draftFormat, questionCount, essayMode: 'NORMAL' } });
        assert.equal(generated.status, 201, JSON.stringify(generated.body));
        const id = generated.body.mission.id; created.push(id);
        const saved = await request(`/teacher/missions/${id}`, { method: 'PATCH', body: { title: 'Reviewed fixture title' } });
        assert.equal(saved.status, 200, JSON.stringify(saved.body));
        const record = await Mission.collection.findOne({ _id: new mongoose.Types.ObjectId(id) });
        assert.equal(String(record.schoolId), String(school._id)); assert.equal(record.draftFormat, draftFormat);
        assert.equal(record.title, 'Reviewed fixture title');
      });
    }
    await t.test('Test, Exam, assessment list and reuse retain the same context', async () => {
      for (const kind of ['TEST', 'EXAM']) {
        const r = await request(`/teacher/standalone-papers/${fixture.student._id}?paperKind=${kind}`); assert.equal(r.status, 200, JSON.stringify(r.body));
      }
      const counts = await request(`/teacher/missions/assessment-draft-counts/${fixture.student._id}?subjectId=${fixture.subject._id}`); assert.equal(counts.status, 200);
      const reused = await request(`/teacher/missions/${created[0]}/reuse`, { method: 'POST', body: { targetStudentId: String(fixture.target._id), targetDate: payload.targetDate, sessionType: 'afternoon' } });
      assert.equal(reused.status, 201, JSON.stringify(reused.body));
    });
    const otherSchool = await School.create({ name: 'Other School', active: true, xpTrackingStartedAt: new Date() });
    const other = await runInSchool(otherSchool._id, () => User.create({ name: 'Other learner', email: 'other@fixture.invalid', role: 'student', passwordHash }));
    const otherTeacher = await runInSchool(otherSchool._id, () => User.create({ name: 'Other teacher', email: 'other-teacher@fixture.invalid', role: 'teacher', passwordHash }));
    await t.test('multiple schools disable legacy fallback and cross-school operations remain denied', async () => {
      const unassigned = new mongoose.Types.ObjectId();
      await User.collection.insertOne({ _id: unassigned, email: 'unassigned@fixture.invalid', createdAt: new Date('2025-01-01') });
      await assert.rejects(schoolService.resolveIdentitySchool({ _id: unassigned }), /explicit school assignment/);
      assert.equal((await User.collection.findOne({ _id: unassigned })).schoolId, undefined);
      await schoolService.migrateCurrentSchool();
      assert.equal((await User.collection.findOne({ _id: unassigned })).schoolId, undefined);
      await School.updateOne({ _id: otherSchool._id }, { $set: { active: false } });
      await assert.rejects(schoolService.resolveIdentitySchool({ _id: unassigned }), /explicit school assignment/);
      await School.updateOne({ _id: otherSchool._id }, { $set: { active: true } });
      await School.updateOne({ _id: school._id }, { $unset: { migrationCompletedAt: '' } });
      await assert.rejects(schoolService.migrateCurrentSchool(), /single configured school/);
      assert.equal((await User.collection.findOne({ _id: unassigned })).schoolId, undefined);
      await School.updateOne({ _id: school._id }, { $set: { migrationCompletedAt: school.migrationCompletedAt } });
      const before = await Mission.collection.countDocuments({});
      const denied = await request('/teacher/missions/generate', { method: 'POST', body: { ...payload, studentId: String(other._id), draftFormat: 'QUESTIONS' } });
      assert.equal(denied.status, 404); assert.equal(await Mission.collection.countDocuments({}), before);
      const auth = jwt.sign({ sub: String(other._id), role: 'teacher' }, process.env.JWT_SECRET || 'development-secret');
      const edit = await request(`/teacher/missions/${created[0]}`, { method: 'PATCH', auth, body: { title: 'Cross-school attempt' } });
      assert.equal(edit.status, 403); // Persisted student role defeats a forged role claim.
      const otherAuth = jwt.sign({ sub: String(otherTeacher._id), role: 'teacher' }, process.env.JWT_SECRET || 'development-secret');
      const scopedEdit = await request(`/teacher/missions/${created[0]}`, { method: 'PATCH', auth: otherAuth, body: { title: 'Cross-school attempt' } });
      assert.equal(scopedEdit.status, 404);
      const deniedReuse = await request(`/teacher/missions/${created[0]}/reuse`, { method: 'POST', body: { targetStudentId: String(other._id), targetDate: payload.targetDate, sessionType: 'morning' } });
      assert.ok([403, 404].includes(deniedReuse.status));
      assert.equal((await Mission.collection.findOne({ _id: new mongoose.Types.ObjectId(created[0]) })).title, 'Reviewed fixture title');
    });
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await mongoose.connection.dropDatabase(); await mongoose.disconnect();
  }
});
