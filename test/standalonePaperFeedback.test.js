/**
 * WHAT: Checks immediate objective feedback for Test and Exam sittings.
 * WHY: Learners need accurate feedback without exposing keys or auto-marking theory.
 * HOW: Save wrong/right answers, reopen and heartbeat isolated student attempts.
 */
const test=require('node:test'),assert=require('node:assert/strict'),mongoose=require('mongoose');
const {runInSchool}=require('../src/utils/schoolScope');
const Paper=require('../src/models/StandalonePaper');
const User=require('../src/models/User');
const Subject=require('../src/models/Subject');
const player=require('../src/services/standalonePaperSession.service');
const uri=process.env.FOCUS_TEST_MONGO_URI;
test('Test and Exam return saved-choice correctness while theory stays unmarked', {skip:!uri},async()=>{
 assert.match(uri,/^mongodb:\/\/(127\.0\.0\.1|localhost):\d+\//);
 await mongoose.connect(uri,{dbName:`paper_feedback_${Date.now()}`});
 try {await runInSchool(new mongoose.Types.ObjectId(),async()=>{
 const student=await User.create({name:'Learner',email:'learner@fixture.invalid',role:'student',passwordHash:'fixture'});
 const teacher=await User.create({name:'Teacher',email:'teacher@fixture.invalid',role:'teacher',passwordHash:'fixture'});
 const subject=await Subject.create({name:'Business',icon:'business'});
 for(const paperKind of ['TEST','EXAM']){
 const paper=await Paper.create({teacherId:teacher._id,studentId:student._id,subjectId:subject._id,paperKind,sessionType:'morning',title:paperKind,status:'published',targetDate:'2020-01-01',recoveryDate:'2020-01-01',durationMinutes:30,items:[{itemType:'OBJECTIVE',prompt:'Choose',options:['Alpha','Beta','Gamma','Delta'],correctIndex:2},{itemType:'THEORY',prompt:'Explain',expectedAnswer:'Teacher marking only',minWordCount:12}]});
 const access={studentId:String(student._id),requesterId:String(student._id),paperId:String(paper._id)};
 const start=await player.startStandalonePaperSession(access);
 assert.equal(start.session.responses[0].isCorrect,null);
 assert.equal(start.paper.items[0].correctIndex,undefined);
 const sitting={...access,sessionId:start.session.id};
 let result=await player.saveStandalonePaperSessionProgress({...sitting,payload:{itemIndex:0,selectedOptionIndex:1,isCorrect:true}});
 assert.equal(result.session.responses[0].isCorrect,false);
 assert.equal((await player.recordStandalonePaperHeartbeat(sitting)).session.responses[0].isCorrect,false);
 assert.equal((await player.startStandalonePaperSession(access)).session.responses[0].isCorrect,false);
 result=await player.saveStandalonePaperSessionProgress({...sitting,payload:{itemIndex:0,selectedOptionIndex:2}});
 assert.equal(result.session.responses[0].isCorrect,true);
 assert.equal((await player.getStandalonePaperSessionForStudent(sitting)).session.responses[0].isCorrect,true);
 result=await player.saveStandalonePaperSessionProgress({...sitting,payload:{itemIndex:1,textAnswer:'A learner response waiting for the teacher to mark it.'}});
 assert.equal(result.session.responses[1].isCorrect,null);
 assert.equal(result.session.responses[1].teacherScorePercent,null);
 result=await player.saveStandalonePaperSessionProgress({...sitting,payload:{itemIndex:0,selectedOptionIndex:-1}});
 assert.equal(result.session.responses[0].isCorrect,null);
 assert.equal(result.paper.items[1].expectedAnswer,undefined);
 await assert.rejects(player.getStandalonePaperSessionForStudent({...sitting,requesterId:String(teacher._id)}),/own/);
 }
 });}finally{await mongoose.connection.dropDatabase();await mongoose.disconnect();}
});
