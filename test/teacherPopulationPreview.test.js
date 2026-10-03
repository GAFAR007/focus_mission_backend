/**
 * WHAT: Regression checks for pasted-source population and legacy file imports.
 * WHY: Partial parsing must retain teacher content, never save a preview or relax
 * ownership, and successful TXT imports must keep their established structure.
 * HOW: Exercise the public service with deterministic ownership records; forbid
 * database writes and compare the preview's round-tripped fields to file imports.
 */
const assert = require('node:assert/strict');
const test = require('node:test');
const User = require('../src/models/User');
const Subject = require('../src/models/Subject');
const Timetable = require('../src/models/Timetable');
const Mission = require('../src/models/Mission');
const service = require('../src/services/teacher.service');
const query = value => ({select() { return this; }, async lean() { return value; }});

const question = (n, theory = false) => `Question ${n}:
Learn First: Companies provide goods and services to meet customer needs.
Prompt: What do companies provide?
${theory ? 'Expected Answer: Goods and services.\nMinimum Word Count: 12' : 'Options:\nA) Goods and services\nB) Nothing\nC) Only cash\nD) Only buildings\nCorrect Answer: A'}
Explanation: A business meets a customer need.`;
const objective = `Business assessment\nUNIT TEXT:\nCompanies meet needs by providing goods and services to people. Customers choose products that help solve their problems.\n${Array.from({length: 5}, (_, i) => question(i + 1)).join('\n')}`;
const theory = `Business theory\nUNIT TEXT:\nCompanies meet needs by providing goods and services to people. Customers choose products that help solve their problems.\n${question(1,true)}\n${question(2,true)}`;
const essay = `Business essay
UNIT TEXT:
Companies meet customer needs through the goods and services they provide. Different customers need different products.
Target Words: 80-120
Target Sentences: 1
Target Blanks: 1
Sentence 1: topic
Learn First Title: Learn First
Learn First Bullet 1: Companies provide goods.
Learn First Bullet 2: Companies provide services.
Learn First Bullet 3: Customers have needs.
Sentence Preview: A company provides ______.
Blank 1:
Hint: Choose what a customer buys.
A) goods
B) nothing
C) silence
D) air
Correct Answer: A`;

async function withRecords(run, {authorized = true} = {}) {
  const original = [User.findOne, Subject.findById, Timetable.findOne, Mission.create];
  User.findOne = () => query({_id:'teacher', name:'Teacher', role:'teacher'});
  Subject.findById = () => query({_id:'subject',name:'Business'});
  Timetable.findOne = () => query({morningSubject:'subject', morningTeacherId: authorized ? 'teacher' : 'other'});
  Mission.create = () => { throw new Error('A preview attempted to write a mission'); };
  try { return await run(); } finally {
    [User.findOne, Subject.findById, Timetable.findOne, Mission.create] = original;
  }
}
function populate(text, format = 'QUESTIONS', previewOnly = true, overrides = {}) {
  return service.extractSourcePlan('teacher', {
    subjectId:'subject',studentId:'student',targetDate:'2099-01-05',sessionType:'morning',
    uploadMode:'populate_draft',draftFormat:format,essayMode:'NORMAL',taskCodes:'["P1"]',
    missionDraftId:'existing',previewOnly,...overrides,
    file:{originalname:'pasted-assessment.txt',mimetype:'text/plain',buffer:Buffer.from(text)},
  });
}
function reviewText(fields) {
  return fields.filter(field => field.value || /Question |^Sentence |^Blank |^Options:/.test(field.prefix))
    .map(field => `${field.prefix}${field.prefix ? ' ' : ''}${field.value}`).join('\n');
}

for (const [format, text] of [['QUESTIONS',objective],['THEORY',theory],['ESSAY_BUILDER',essay]]) {
  test(`${format}: preview and file share parsing; edited fields round-trip without saves`, () => withRecords(async () => {
    const preview = await populate(text,format);
    assert.equal(preview.draftReadiness.status,'ready',JSON.stringify(preview.draftReadiness));
    assert.equal(preview.prefilledMission,null);
    assert.ok(preview.populationPreview.fields.length > 5);
    const file = await populate(text,format,false);
    assert.equal(file.draftReadiness.status,'ready');
    assert.ok(file.prefilledMission);
    const repaired = await populate(reviewText(preview.populationPreview.fields),format,false);
    assert.equal(repaired.draftReadiness.status,'ready',JSON.stringify(repaired.draftReadiness));
    if (format === 'ESSAY_BUILDER') {
      assert.deepEqual(repaired.prefilledMission.draftJson,file.prefilledMission.draftJson);
      assert.equal(file.prefilledMission.sourceUnitText,'Companies meet customer needs through the goods and services they provide. Different customers need different products.');
    } else {
      assert.deepEqual(repaired.prefilledMission.questions,file.prefilledMission.questions);
    }
  }));
}

test('partial Objective keeps valid and incomplete fields; reports missing question options', () => withRecords(async () => {
  const partial = objective.replace('B) Nothing\nC) Only cash\nD) Only buildings','');
  const result = await populate(partial);
  assert.equal(result.draftReadiness.status,'needs_attention');
  assert.match(result.draftReadiness.missingRequirements.join(' '),/Question 1.*four.*options/);
  const fields = result.populationPreview.fields;
  assert.equal(fields.find(f=>f.label==='Question 1 · Option A').value,'Goods and services');
  assert.equal(fields.find(f=>f.label==='Question 1 · Option B').value,'');
  assert.equal(fields.find(f=>f.label==='Question 5 · Prompt').value,'What do companies provide?');
  assert.equal(result.prefilledMission,null);
}));

test('partial Essay keeps preview, learning bullets and incomplete blank options', () => withRecords(async () => {
  const result = await populate(essay.replace('B) nothing\nC) silence\nD) air',''),'ESSAY_BUILDER');
  assert.equal(result.draftReadiness.status,'needs_attention');
  assert.match(result.draftReadiness.missingRequirements.join(' '),/Sentence 1 blank 1.*four/);
  assert.equal(result.populationPreview.fields.find(f=>f.label==='Sentence 1 · Sentence Preview').value,'A company provides ______.');
  assert.equal(result.populationPreview.fields.find(f=>f.label==='Sentence 1 · Blank 1 option B').value,'');
}));

test('missing title, empty labelled fields, short and wrong-format text are actionable', () => withRecords(async () => {
  const shortUnit = await populate(objective.replace(/UNIT TEXT:[\s\S]*?(?=Question 1)/, 'UNIT TEXT:\nShort teaching note.\n'));
  assert.match(shortUnit.draftReadiness.missingRequirements.join(' '),/Unit text needs at least 80 characters/);
  const missingTitle = await populate(objective.slice(objective.indexOf('UNIT TEXT:')));
  assert.match(missingTitle.draftReadiness.missingRequirements.join(' '),/No assessment title/);
  const emptyPrompt = await populate(objective.replace('Prompt: What do companies provide?','Prompt:'));
  assert.match(emptyPrompt.draftReadiness.missingRequirements.join(' '),/Question 1 is missing Prompt/);
  for (const text of ['hello','Why do businesses exist?','A B C question answer']) {
    const result = await populate(text);
    assert.match(result.draftReadiness.missingRequirements.join(' '),/No usable questions/);
    assert.equal(result.prefilledMission,null);
  }
  const wrong = await populate(theory);
  assert.match(wrong.draftReadiness.missingRequirements.join(' '),/looks like Theory/);
  const plainEssay = await populate('Essay prompt: Explain business. Marking criteria: Explain clearly.','ESSAY_BUILDER');
  assert.match(plainEssay.draftReadiness.missingRequirements.join(' '),/plain essay prompt or marking rubric/);
}));

test('empty/whitespace/oversized input rejected and preview cannot invoke AI', () => withRecords(async () => {
  for (const text of ['', '  \n\t ']) await assert.rejects(populate(text),/Paste some assessment/);
  await assert.rejects(populate('x'.repeat(100001)),/too long/);
  await assert.rejects(populate(objective,'QUESTIONS',true,{uploadMode:'ai_draft'}),/not AI draft/);
}));

test('preview retains scheduled teacher authorization', () => withRecords(async () => {
  await assert.rejects(populate(objective), error => error.statusCode === 403);
}, {authorized:false}));
