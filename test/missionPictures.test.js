/**
 * WHAT: Verifies picture persistence across Objective, Theory and Essay missions.
 * WHY: Optional media must survive saving/reuse and reach the student without changing work.
 * HOW: Use isolated Mongo records and the actual teacher/student service boundaries.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const Mission = require('../src/models/Mission');
const User = require('../src/models/User');
const Subject = require('../src/models/Subject');
const teacherService = require('../src/services/teacher.service');
const studentService = require('../src/services/student.service');
const { runInSchool } = require('../src/utils/schoolScope');
const { normalizeMissionPictures } = require('../src/services/questionImage.service');
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQ1sAAAAASUVORK5CYII=';
const image = {imageDataUrl:png,imageDescription:'Code reference'};
test('legacy and current essay shapes validate images without discarding scaffolding', () => {
  for (const draft of [{sentences:[{id:'s1',...image}]},{builder:{sentences:[{id:'s1',...image}]}}]) {
    assert.deepEqual(normalizeMissionPictures(draft),draft);
  }
  assert.throws(()=>normalizeMissionPictures({sentences:[{...image,imageDataUrl:'https://external.test/pic'}]}));
  assert.throws(()=>normalizeMissionPictures({builder:{sentences:[{...image,imageDescription:''}]}}));
  assert.throws(()=>normalizeMissionPictures({sentences:Array.from({length:20},()=>({...image,imageDataUrl:'x'.repeat(700000)}))}));
});
const uri = process.env.FOCUS_TEST_MONGO_URI;
test('Q5, Q8, Assessment A/B, Theory and Essay pictures save, reopen and reach the assigned student', {skip:!uri}, async () => {
  assert.match(uri,/^mongodb:\/\/(127\.0\.0\.1|localhost):\d+\//);
  await mongoose.connect(uri,{dbName:`mission_pictures_${Date.now()}`});
  try {
    const school = new mongoose.Types.ObjectId();
    await runInSchool(school, async () => {
      const teacher = await User.create({name:'Teacher',email:'teacher@fixture.invalid',passwordHash:'fixture',role:'teacher'});
      const student = await User.create({name:'Learner',email:'learner@fixture.invalid',passwordHash:'fixture',role:'student'});
      const subject = await Subject.create({name:'Computing',icon:'code'});
      for (const [format,count,label] of [['QUESTIONS',5,'Q5'],['QUESTIONS',8,'Q8'],['QUESTIONS',10,'Assessment A'],['QUESTIONS',10,'Assessment B'],['THEORY',2,'Theory'],['ESSAY_BUILDER',0,'Essay']]) {
        const theory = format === 'THEORY';
        const questions = Array.from({length:count},(_,i)=>({id:`q${i}`,answerMode:theory?'short_answer':'multiple_choice',learningText:'Read the code',prompt:`Explain code ${i}`,options:theory?[]:['A value','B value','C value','D value'],correctIndex:theory?-1:2,expectedAnswer:theory?'Expected response':'',minWordCount:theory?12:0,explanation:'Guidance'}));
        const mission = await Mission.create({studentId:student._id,subjectId:subject._id,createdBy:teacher._id,title:label,sessionType:'morning',draftFormat:format,questions,availableOnDate:'2020-01-01',status:'draft'});
        const payload = count ? {questions:questions.map(q=>({...q,...image}))} : {draftJson:{sentences:[{id:'s1',role:'Introduction',...image,parts:[],learnFirst:{title:'Read',bullets:['Look at the code']}}]}};
        await assert.rejects(teacherService.updateMission(student._id,mission._id,payload),/not found/);
        await assert.rejects(runInSchool(new mongoose.Types.ObjectId(),()=>teacherService.updateMission(teacher._id,mission._id,payload)),/not found/);
        const saved = await teacherService.updateMission(teacher._id,mission._id,{...payload,status:'published'});
        const reopened = await Mission.findById(mission._id).lean();
        const access = {studentId:String(student._id),requesterId:String(student._id),requesterRole:'student',missionId:String(mission._id),subjectId:String(subject._id),sessionType:'morning'};
        const started = await studentService.startSession(access);
        if (count) {
          assert.equal(saved.questions[0].imageDataUrl,png);
          assert.equal(reopened.questions[0].imageDescription,image.imageDescription);
          assert.equal(started.mission.questions[0].imageDataUrl,png);
          assert.equal(reopened.questions[0].correctIndex,questions[0].correctIndex);
          const shuffled = teacherService.shuffleMissionQuestions(reopened.questions,{shuffleQuestionOrder:true,shuffleAnswerOptions:true});
          assert.ok(shuffled.every(q=>q.imageDataUrl===png));
          await teacherService.updateMission(teacher._id,mission._id,{questions});
          assert.equal((await Mission.findById(mission._id)).questions[0].imageDataUrl,'');
        } else {
          assert.equal(saved.draftJson.sentences[0].imageDataUrl,png);
          assert.equal(started.mission.draftJson.sentences[0].imageDataUrl,png);
        }
        assert.equal((await User.findById(student._id)).xp,0);
      }
    });
  } finally { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); }
});
