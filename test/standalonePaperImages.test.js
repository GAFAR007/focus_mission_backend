/**
 * WHAT: Checks safe question pictures and image-only live paper edits.
 * WHY: Teachers must add references without exposing keys or changing answers.
 * HOW: Validate raster payloads and exercise school-scoped services on local Mongo.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { runInSchool } = require('../src/utils/schoolScope');
const Paper = require('../src/models/StandalonePaper');
const Sitting = require('../src/models/StandalonePaperSession');
const User = require('../src/models/User');
const Subject = require('../src/models/Subject');
const service = require('../src/services/standalonePaper.service');
const player = require('../src/services/standalonePaperSession.service');
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQ1sAAAAASUVORK5CYII=';
const image = { imageDataUrl: png, imageDescription: 'Source code reference' };
test('question pictures reject external, active, oversized and incorrectly labelled data', () => {
  assert.deepEqual(service.normalizeQuestionImage(image), image);
  for (const bad of ['https://example.test/image.png', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/png;base64,aGVsbG8=', png + 'x', 'data:image/jpeg;base64,' + 'A'.repeat(700000)]) {
    assert.throws(() => service.normalizeQuestionImage({...image, imageDataUrl: bad}));
  }
  assert.throws(() => service.normalizeQuestionImage({...image, imageDescription: ''}));
  assert.equal(service.normalizeQuestionImage({}).imageDataUrl, '');
});
const uri = process.env.FOCUS_TEST_MONGO_URI;
test('published image edits preserve sitting and question keys; enforce teacher and school ownership', {skip: !uri}, async () => {
  assert.match(uri, /^mongodb:\/\/(127\.0\.0\.1|localhost):\d+\//);
  await mongoose.connect(uri, {dbName: `paper_images_${Date.now()}`});
  const school = new mongoose.Types.ObjectId(), teacher = new mongoose.Types.ObjectId(), student = new mongoose.Types.ObjectId(), subject = new mongoose.Types.ObjectId();
  try {
    await User.collection.insertMany([{_id:teacher,schoolId:school,role:'teacher',name:'Teacher',email:'teacher@fixture.invalid'}, {_id:student,schoolId:school,role:'student',name:'Learner',email:'learner@fixture.invalid'}]);
    await Subject.collection.insertOne({_id:subject,schoolId:school,name:'Business'});
    await runInSchool(school, async () => {
      const paper = await Paper.create({teacherId:teacher,studentId:student,subjectId:subject,paperKind:'TEST',sessionType:'morning',title:'Pictures',status:'published',targetDate:'2020-01-01',recoveryDate:'2020-01-01',items:[{itemType:'OBJECTIVE',prompt:'Choose',options:['A','B','C','D'],correctIndex:2}]});
      const access = {studentId:String(student),requesterId:String(student),paperId:String(paper._id)};
      const started = await player.startStandalonePaperSession(access);
      await player.saveStandalonePaperSessionProgress({...access,sessionId:started.session.id,payload:{itemIndex:0,selectedOptionIndex:1}});
      const before = await Sitting.findById(started.session.id).lean();
      const args = {teacherId:teacher,paperId:paper._id,itemIndex:0,payload:{...image,prompt:'Do not write this',correctIndex:0}};
      await assert.rejects(service.updateStandalonePaperImage({...args,teacherId:student}), /access/);
      await assert.rejects(runInSchool(new mongoose.Types.ObjectId(),()=>service.updateStandalonePaperImage(args)), /not found/);
      await assert.rejects(service.updateStandalonePaperImage({...args,itemIndex:2}), /existing/);
      const updated = await service.updateStandalonePaperImage(args);
      assert.equal(updated.items[0].prompt,'Choose');assert.equal(updated.items[0].correctIndex,2);
      assert.equal(updated.items[0].imageDataUrl,png);
      assert.deepEqual(await Sitting.findById(started.session.id).lean(), before);
      const resumed = await player.startStandalonePaperSession(access);
      assert.equal(resumed.paper.items[0].imageDataUrl,png);
      assert.equal(resumed.paper.items[0].imageDescription,image.imageDescription);
      assert.equal(resumed.paper.items[0].correctIndex,undefined);
      assert.equal(resumed.session.responses[0].selectedOptionIndex,1);
      await service.updateStandalonePaperImage({...args,payload:{imageDataUrl:'',imageDescription:''}});
      assert.equal((await Paper.findById(paper._id)).items[0].imageDataUrl,'');
    });
  } finally {await mongoose.connection.dropDatabase();await mongoose.disconnect();}
});
