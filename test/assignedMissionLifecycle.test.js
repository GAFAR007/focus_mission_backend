/**
 * WHAT: Exercises persistent assignments and redo against an isolated replica set.
 * WHY: Real transactions must prevent double results/XP and roll back failures.
 * HOW: Set FOCUS_TEST_MONGO_URI to a local test replica set. This suite refuses
 * remote hosts and uses a unique disposable database, never production data.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const studentService = require('../src/services/student.service');
const redoService = require('../src/services/resultEvidenceAction.service');
const resultService = require('../src/services/result.service');
const Mission = require('../src/models/Mission');
const User = require('../src/models/User');
const Subject = require('../src/models/Subject');
const ResultPackage = require('../src/models/ResultPackage');
const SessionLog = require('../src/models/SessionLog');
const uri = process.env.FOCUS_TEST_MONGO_URI;

test('Monday assignment survives Tuesday/Saturday, locks atomically, and preserves repeated redo history', { skip: !uri }, async () => {
  assert.match(uri, /^mongodb:\/\/(127\.0\.0\.1|localhost):\d+\//);
  await mongoose.connect(uri, { dbName: `assignment_lifecycle_test_${Date.now()}` });
  try {
    const teacher = await User.create({ name: 'Teacher fixture', email: 'teacher@example.invalid', passwordHash: 'fixture', role: 'teacher' });
    const student = await User.create({ name: 'Student fixture', email: 'student@example.invalid', passwordHash: 'fixture', role: 'student' });
    const subject = await Subject.create({ name: 'Business', icon: 'business' });
    const mission = await Mission.create({ studentId: student._id, subjectId: subject._id, createdBy: teacher._id,
      title: 'Business P3', taskCodes: ['P3'], sessionType: 'afternoon', status: 'published',
      publishedAt: new Date('2026-09-21T09:00:00Z'), availableOnDate: '2026-09-21', availableOnDay: 'Monday',
      questions: Array.from({ length: 5 }, (_, i) => ({ prompt: `Question ${i}`, options: ['a', 'b', 'c', 'd'], correctIndex: 0 })),
    });
    await Mission.init();
    const payload = { studentId: String(student._id), subjectId: String(subject._id), sessionType: 'afternoon',
      missionId: String(mission._id), requesterId: String(student._id), requesterRole: 'student', completedQuestions: 5, correctAnswers: 5 };
    process.env.FOCUS_TEST_DATE_OVERRIDE_ENABLED = 'true';
    process.env.FOCUS_TEST_DATE_OVERRIDE_STUDENT_ID = String(student._id);
    for (const date of ['2026-09-22', '2026-09-26', '2026-10-04']) {
      process.env.FOCUS_TEST_DATE_OVERRIDE_DATE = date;
      const assignments = await studentService.listAssignedMissions(payload);
      assert.equal(assignments.length, 1);
      assert.notEqual(assignments[0].assignmentStatus, 'completed');
      assert.equal((await studentService.startSession(payload)).mission.id, String(mission._id));
    }
    process.env.FOCUS_TEST_DATE_OVERRIDE_DATE = '2026-09-26';
    await assert.rejects(studentService.startSession({ ...payload, requesterId: String(teacher._id) }), { statusCode: 403 });
    await assert.rejects(studentService.completeSession({ ...payload, requesterId: String(teacher._id) }), { statusCode: 403 });
    await assert.rejects(studentService.startSession({ ...payload, missionId: String(new mongoose.Types.ObjectId()) }), { statusCode: 404 });
    // Inject a failure after the mission/log writes. A retry must still be possible.
    const original = resultService.createResultPackageForCompletion;
    resultService.createResultPackageForCompletion = async () => { throw new Error('injected result failure'); };
    try { await assert.rejects(studentService.completeSession(payload), /injected result failure/); }
    finally { resultService.createResultPackageForCompletion = original; }
    assert.equal(await SessionLog.countDocuments({ missionId: mission._id }), 0);
    assert.equal((await Mission.findById(mission._id)).completedAt, null);
    assert.equal((await User.findById(student._id)).xp, 0);

    const concurrent = await Promise.allSettled([studentService.completeSession(payload), studentService.completeSession(payload)]);
    assert.equal(concurrent.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(concurrent.find((r) => r.status === 'rejected').reason.statusCode, 409);
    assert.equal(await ResultPackage.countDocuments({ missionId: mission._id }), 1);
    assert.equal(await SessionLog.countDocuments({ missionId: mission._id }), 1);
    const firstResult = await ResultPackage.findOne({ missionId: mission._id }).lean();
    const firstSnapshot = JSON.stringify(firstResult);
    const xpAfter = (await User.findById(student._id)).xp;
    await assert.rejects(studentService.startSession(payload), { statusCode: 409 });
    await assert.rejects(studentService.completeSession(payload), { statusCode: 409 });
    assert.equal((await User.findById(student._id)).xp, xpAfter);
    assert.equal((await studentService.listAssignedMissions(payload))[0].assignmentStatus, 'completed');

    let previousResultId = firstResult._id;
    for (const attempt of [2, 3]) {
      const redo = await redoService.createRedo({ teacherId: String(teacher._id), resultPackageId: String(previousResultId) });
      const redoPayload = { ...payload, missionId: redo.missionId };
      const opened = await studentService.startSession(redoPayload);
      assert.equal(opened.mission.assignmentAttempt, attempt);
      assert.equal(opened.mission.assignmentId, String(mission._id));
      const completed = await studentService.completeSession(redoPayload);
      previousResultId = completed.resultPackageId;
      await assert.rejects(studentService.completeSession(redoPayload), { statusCode: 409 });
    }
    assert.equal(await ResultPackage.countDocuments({ studentId: student._id }), 3);
    assert.equal(await SessionLog.countDocuments({ studentId: student._id }), 3);
    assert.equal(JSON.stringify(await ResultPackage.findById(firstResult._id).lean()), firstSnapshot);
    const history = await studentService.listAssignedMissions({ studentId: String(student._id) });
    assert.equal(history.length, 3);
    assert.ok(history.every((m) => m.assignmentStatus === 'completed' && m.latestResultPackageId));
    await assert.rejects(redoService.createRedo({ teacherId: String(teacher._id), resultPackageId: String(firstResult._id) }), { statusCode: 409 });
    await assert.rejects(redoService.createRedo({ teacherId: String(student._id), resultPackageId: String(previousResultId) }), { statusCode: 403 });
    const dashboard = await studentService.getDashboard(String(student._id));
    assert.equal(dashboard.today, null);
    assert.equal(dashboard.assignedMissions.length, 3);
    // Pending Theory review locks submission without granting early XP.
    const theory = await Mission.create({ studentId: student._id, subjectId: subject._id, createdBy: teacher._id,
      title: 'Theory P3', taskCodes: ['P3'], sessionType: 'morning', status: 'published', draftFormat: 'THEORY',
      availableOnDate: '2026-09-21', availableOnDay: 'Monday',
      questions: [0, 1].map((i) => ({ prompt: `Explain idea ${i}`, answerMode: 'short_answer', minWordCount: 12 })),
    });
    const theoryPayload = { ...payload, missionId: String(theory._id), sessionType: 'morning',
      resultEvidence: { theoryResponses: [0, 1].map((questionIndex) => ({ questionIndex, answerText: 'This answer contains enough words to explain the idea clearly and preserve the submitted evidence exactly.' })) } };
    const xpBeforeTheory = (await User.findById(student._id)).xp;
    const theoryCompletion = await studentService.completeSession(theoryPayload);
    assert.equal(theoryCompletion.theoryReviewStatus, 'pending_review');
    assert.equal((await User.findById(student._id)).xp, xpBeforeTheory);
    await assert.rejects(studentService.completeSession(theoryPayload), { statusCode: 409 });
    const theoryResult = await ResultPackage.findById(theoryCompletion.resultPackageId).lean();
    const theoryRedo = await redoService.createRedo({ teacherId: String(teacher._id), resultPackageId: String(theoryResult._id) });
    assert.ok(theoryRedo.draftId);
    const work = await require('../src/models/MissionWorkDraft').findById(theoryRedo.draftId).lean();
    assert.equal(work.theoryResponses[0].answerText, theoryPayload.resultEvidence.theoryResponses[0].answerText);
    assert.equal(JSON.stringify(await ResultPackage.findById(theoryResult._id).lean()), JSON.stringify(theoryResult));
    // A legacy submission without its summary pointer is still locked and linked.
    await Mission.updateOne({ _id: theory._id }, { $unset: { completedAt: '', latestResultPackageId: '' } });
    const legacy = (await studentService.listAssignedMissions({ studentId: String(student._id) })).find((m) => m.id === String(theory._id));
    assert.equal(legacy.assignmentStatus, 'completed');
    assert.equal(legacy.latestResultPackageId, String(theoryResult._id));
    await assert.rejects(studentService.startSession(theoryPayload), { statusCode: 409 });
    // Authoring and offline-result records never become playable assignments.
    await Mission.create({ ...mission.toObject(), _id: new mongoose.Types.ObjectId(), status: 'draft' });
    await Mission.create({ ...mission.toObject(), _id: new mongoose.Types.ObjectId(), manualResultOnly: true });
    assert.equal((await studentService.listAssignedMissions({ studentId: String(student._id) })).length, 5);
  } finally {
    delete process.env.FOCUS_TEST_DATE_OVERRIDE_ENABLED;
    delete process.env.FOCUS_TEST_DATE_OVERRIDE_STUDENT_ID;
    delete process.env.FOCUS_TEST_DATE_OVERRIDE_DATE;
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
