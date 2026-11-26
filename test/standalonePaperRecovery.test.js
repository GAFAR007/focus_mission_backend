/**
 * WHAT: Exercises saved test recovery and teacher-only reinstatement.
 * WHY: A learner must be able to begin and recover without losing answers or results.
 * HOW: Use real models/services with synthetic data in a disposable local replica set.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { runInSchool } = require('../src/utils/schoolScope');
const Paper = require('../src/models/StandalonePaper');
const Sitting = require('../src/models/StandalonePaperSession');
const User = require('../src/models/User');
const Subject = require('../src/models/Subject');
const service = require('../src/services/standalonePaperSession.service');
const { getDateKey } = require('../src/utils/xpPolicy');
const uri = process.env.FOCUS_TEST_MONGO_URI;

test('new sitting accepts its unfinished submission reason', () => {
  const id = new mongoose.Types.ObjectId();
  const sitting = new Sitting({ paperId: id, teacherId: id, studentId: id, subjectId: id,
    schoolId: id, paperKind: 'TEST', sessionType: 'morning', targetDate: '2026-11-19' });
  assert.equal(sitting.validateSync(), undefined);
});

test('teacher reinstatement preserves answers, date access, ownership and result evidence', { skip: !uri }, async () => {
  assert.match(uri, /^mongodb:\/\/(127\.0\.0\.1|localhost):\d+\//);
  await mongoose.connect(uri, { dbName: `paper_recovery_${Date.now()}` });
  const school = new mongoose.Types.ObjectId();
  const teacher = new mongoose.Types.ObjectId();
  const student = new mongoose.Types.ObjectId();
  const subject = new mongoose.Types.ObjectId();
  try {
    await User.collection.insertMany([
      { _id: teacher, schoolId: school, role: 'teacher', name: 'Synthetic Teacher', email: 'teacher@fixture.invalid' },
      { _id: student, schoolId: school, role: 'student', name: 'Synthetic Student', email: 'student@fixture.invalid' },
    ]);
    await Subject.collection.insertOne({ _id: subject, schoolId: school, name: 'Synthetic Business' });
    await runInSchool(school, async () => {
      const paper = await Paper.create({ teacherId: teacher, studentId: student, subjectId: subject,
        paperKind: 'TEST', sessionType: 'morning', title: 'Recovery test', status: 'published',
        targetDate: '2026-11-19', durationMinutes: 20,
        items: [{ itemType: 'OBJECTIVE', prompt: 'Choose A', options: ['A', 'B', 'C', 'D'], correctIndex: 0 }] });
      const access = { studentId: String(student), requesterId: String(student), paperId: String(paper._id) };
      await assert.rejects(service.reinstateStandalonePaper({ teacherId: student, paperId: paper._id }), /access/);
      await assert.rejects(runInSchool(new mongoose.Types.ObjectId(), () => service.reinstateStandalonePaper({ teacherId: teacher, paperId: paper._id })), /not found/);
      await service.reinstateStandalonePaper({ teacherId: teacher, paperId: paper._id });
      const available = await service.listAvailableStandalonePapersForStudent(access);
      assert.equal(available.length, 1, 'teacher grant works without a current timetable');
      const started = await service.startStandalonePaperSession(access);
      assert.equal(started.session.status, 'active');
      const sessionAccess = { studentId: String(student), requesterId: String(student), sessionId: started.session.id };
      await service.saveStandalonePaperSessionProgress({ ...sessionAccess, payload: { itemIndex: 0, selectedOptionIndex: 0 } });
      const warned = await service.recordStandalonePaperIntegrityEvent({ ...sessionAccess, payload: { eventType: 'page_hidden' } });
      assert.equal(warned.session.warningCount, 1);
      const locked = await service.recordStandalonePaperIntegrityEvent({ ...sessionAccess, payload: { eventType: 'manual_back_attempt' } });
      assert.equal(locked.session.status, 'locked');
      const resumed = await service.reinstateStandalonePaper({ teacherId: teacher, paperId: paper._id });
      assert.equal(resumed.session.id, started.session.id);
      assert.equal(resumed.session.responses[0].selectedOptionIndex, 0);
      assert.equal(resumed.session.warningCount, 0);
      assert.equal(resumed.session.integrityEvents.length, 2);
      assert.equal(resumed.session.endsAt, null, 'timer waits for student');
      await service.getLatestStandalonePaperSessionForTeacher({ teacherId: teacher, paperId: paper._id });
      assert.equal((await Sitting.findById(started.session.id)).recoveryPending, true);
      const reopened = await service.startStandalonePaperSession(access);
      assert.ok(reopened.session.secondsRemaining >= 1198);
      const submitted = await service.submitStandalonePaperSession(sessionAccess);
      assert.equal(submitted.session.status, 'submitted');
      const resultId = submitted.session.resultPackageId;
      assert.ok(resultId);
      const fresh = await service.reinstateStandalonePaper({ teacherId: teacher, paperId: paper._id });
      assert.notEqual(fresh.session.id, started.session.id);
      assert.equal(fresh.session.responses[0].selectedOptionIndex, 0);
      assert.equal(fresh.session.resultPackageId, '');
      const original = await Sitting.findById(started.session.id).lean();
      assert.equal(original.status, 'submitted');
      assert.equal(String(original.resultPackageId), resultId);
      // Every interrupted/finalized state has a teacher-controlled way back.
      for (const state of ['time_expired', 'reset_by_teacher', 'active']) {
        await Sitting.updateOne({ _id: fresh.session.id }, { $set: { status: state } });
        const recovered = await service.reinstateStandalonePaper({ teacherId: teacher, paperId: paper._id });
        assert.equal(recovered.session.status, 'active');
        assert.equal(recovered.session.responses[0].selectedOptionIndex, 0);
        fresh.session = recovered.session;
      }
      const audited = await Paper.findById(paper._id).lean();
      assert.equal(audited.recoveryDate, getDateKey());
      assert.equal(audited.recoveryHistory.length, 6);
      await assert.rejects(service.startStandalonePaperSession({ ...access, requesterId: String(teacher) }), /own/);
      paper.status = 'draft'; await paper.save();
      await assert.rejects(service.reinstateStandalonePaper({ teacherId: teacher, paperId: paper._id }), /Publish/);
    });
  } finally { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); }
});
