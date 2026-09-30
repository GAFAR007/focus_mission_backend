/**
 * WHAT: Regression coverage for mission identity at serialization/export boundaries.
 * WHY: Equal question counts must never conflate Theory with Objective or mutate evidence.
 * HOW: Exercise real serializers and pure formatters with frozen legacy/custom records.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { missionDisplayName, resultMissionName } = require('../src/services/missionNaming.service');
const { serializeMission } = require('../src/utils/missionSerializer');
const { serializeMissionResultHistoryEntry } = require('../src/services/result.service');

for (const [type, count, code, expected] of [
  ['QUESTIONS', 8, 'P1', 'P1 Objective Q8'],
  ['QUESTIONS', 5, 'P1', 'P1 Objective Q5'],
  ['THEORY', 5, 'P1', 'P1 Theory Q5'],
  ['THEORY', 5, 'P2', 'P2 Theory Q5'],
  ['THEORY', 5, 'D1', 'D1 Theory Q5'],
  ['ESSAY_BUILDER', 10, 'P1', 'P1 Essay'],
  ['ESSAY_BUILDER', 10, 'M1', 'M1 Essay'],
]) {
  test(`legacy ${type} uses ${expected} across mission and history`, () => {
    const mission = Object.freeze({ _id: 'keep-id', title: 'Business Morning Mission',
      subjectId: { name: 'Business' }, draftFormat: type, taskCodes: [code],
      questions: Array.from({ length: count }, () => ({})), latestScoreTotal: 100,
      latestScoreCorrect: 75, latestXpEarned: 20, latestResultPackageId: 'keep-result' });
    assert.equal(serializeMission(mission).title, expected);
    assert.equal(serializeMissionResultHistoryEntry(mission).title, expected);
    assert.equal(mission.title, 'Business Morning Mission');
    assert.equal(serializeMission(mission).id, 'keep-id');
  });
}

test('custom titles and unknown types stay intact; edits refresh generated names', () => {
  assert.equal(missionDisplayName({ title: 'Why businesses grow', type: 'THEORY', questionCount: 5 }), 'Why businesses grow');
  assert.equal(missionDisplayName({ title: 'P1 Theory', type: 'THEORY', questionCount: 5 }), 'P1 Theory');
  assert.equal(missionDisplayName({ title: 'Morning Mission', type: '', questionCount: 5 }), 'Morning Mission');
  assert.equal(missionDisplayName({ title: 'P1 Objective Q8', type: 'THEORY', taskCodes: ['P2'], questionCount: 5 }), 'P2 Theory Q5');
  assert.equal(missionDisplayName({ title: '', type: 'QUESTIONS', questionCount: 10 }), 'Objective Q10');
});

test('report title uses frozen evidence question count, never score total', () => {
  const result = Object.freeze({ missionType: 'THEORY', resultKind: 'mission',
    meta: Object.freeze({ missionTitle: 'Business Afternoon Mission', subject: 'Business', taskCodes: ['P1'], score: { total: 100 } }),
    evidence: Object.freeze({ questions: [{}, {}, {}, {}, {}] }) });
  assert.equal(resultMissionName(result), 'P1 Theory Q5');
  assert.equal(result.meta.missionTitle, 'Business Afternoon Mission');
  assert.equal(resultMissionName({ ...result, evidence: {} }), 'P1 Theory');
  assert.equal(resultMissionName({ ...result, resultKind: 'paper_assessment' }), 'Business Afternoon Mission');
});
