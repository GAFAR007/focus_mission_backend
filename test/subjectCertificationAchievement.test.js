/**
 * WHAT:
 * Tests task-code achievement as the conjunction of passed Theory and passed
 * Assessment A evidence.
 * WHY:
 * Learning stages and optional Assessment B must remain auditable without
 * independently unlocking a qualification criterion.
 * HOW:
 * Evaluate deterministic mission/result fixtures and aggregate their evidence
 * through the same pure certification functions used by production summaries.
 */

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  ASSESSMENT_PASS_CORRECT,
  ASSESSMENT_QUESTION_COUNT,
  CERTIFICATION_STATUS,
  THEORY_PASS_PERCENT,
  buildSubjectCertificationSummary,
  evaluateCertificationMission,
} = require("../src/services/subjectCertification.service");
const {
  calculateRequiredCorrectAnswers,
} = require("../src/utils/missionPassPolicy");
const {
  buildStudentMissionHistoryItem,
} = require("../src/services/student.service");

const settingsContext = (requiredTaskCodes = ["P1"]) => ({
  subjectId: "business-id",
  subjectName: "Business",
  certificationEnabled: true,
  certificationLabel: "Business Certification",
  requiredTaskCodes,
  planSource: "subject_template",
  planId: "",
  planVersion: 0,
});

let fixtureNumber = 0;

function missionFixture({
  draftFormat,
  questionCount = 0,
  taskCode = "P1",
  assessmentSequence = "",
  scoreCorrect = 0,
  scorePercent = 0,
}) {
  fixtureNumber += 1;
  return {
    _id: `mission-${fixtureNumber}`,
    draftFormat,
    taskCodes: [taskCode],
    assessmentSequenceByTaskCode: assessmentSequence ?
      { [taskCode]: assessmentSequence }
    : {},
    questions: Array.from({ length: questionCount }, (_, index) => ({
      prompt: `Question ${index + 1}`,
    })),
    latestScoreCorrect: scoreCorrect,
    latestScoreTotal: questionCount,
    latestScorePercent: scorePercent,
    createdAt: new Date(`2026-09-${String((fixtureNumber % 20) + 1).padStart(2, "0")}T09:00:00.000Z`),
  };
}

function resultFixture({
  scoreCorrect = 0,
  scorePercent = 0,
  theoryScore = null,
  reviewStatus = "scored",
} = {}) {
  fixtureNumber += 1;
  return {
    _id: `result-${fixtureNumber}`,
    createdAt: new Date(`2026-09-${String((fixtureNumber % 20) + 1).padStart(2, "0")}T10:00:00.000Z`),
    meta: {
      score: {
        correct: scoreCorrect,
        total: ASSESSMENT_QUESTION_COUNT,
        percent: scorePercent,
      },
    },
    evidence: theoryScore === null ? {} : {
      reviewStatus,
      averageTeacherScorePercent: theoryScore,
    },
  };
}

function evaluate({
  draftFormat,
  questionCount = 0,
  taskCode = "P1",
  assessmentSequence = "",
  scoreCorrect = 0,
  scorePercent = 0,
  theoryScore = null,
  reviewStatus = "scored",
  requiredTaskCodes = ["P1"],
}) {
  return evaluateCertificationMission({
    mission: missionFixture({
      draftFormat,
      questionCount,
      taskCode,
      assessmentSequence,
      scoreCorrect,
      scorePercent,
    }),
    resultPackage: resultFixture({
      scoreCorrect,
      scorePercent,
      theoryScore,
      reviewStatus,
    }),
    settingsContext: settingsContext(requiredTaskCodes),
  });
}

function theory({ score = 78, status = "scored", taskCode = "P1", requiredTaskCodes } = {}) {
  return evaluate({
    draftFormat: "THEORY",
    taskCode,
    theoryScore: score,
    reviewStatus: status,
    requiredTaskCodes: requiredTaskCodes || [taskCode],
  });
}

function assessment({
  correct = 8,
  sequence = "A",
  taskCode = "P1",
  requiredTaskCodes,
} = {}) {
  return evaluate({
    draftFormat: "QUESTIONS",
    questionCount: ASSESSMENT_QUESTION_COUNT,
    taskCode,
    assessmentSequence: sequence,
    scoreCorrect: correct,
    scorePercent: correct * 10,
    requiredTaskCodes: requiredTaskCodes || [taskCode],
  });
}

function summary(evaluations, requiredTaskCodes = ["P1"]) {
  return buildSubjectCertificationSummary({
    settingsContext: settingsContext(requiredTaskCodes),
    evaluations,
  });
}

test("1. Q5 passed alone does not achieve the criterion", () => {
  const q5 = evaluate({
    draftFormat: "QUESTIONS",
    questionCount: 5,
    scoreCorrect: 4,
    scorePercent: 80,
  });

  assert.equal(q5.certificationEligible, false);
  assert.equal(summary([q5]).certificateUnlocked, false);
});

test("2. Q8 passed alone does not achieve the criterion", () => {
  const q8 = evaluate({
    draftFormat: "QUESTIONS",
    questionCount: 8,
    scoreCorrect: 6,
    scorePercent: 75,
  });

  assert.equal(q8.certificationEligible, false);
  assert.equal(summary([q8]).evidenceRows[0].status, CERTIFICATION_STATUS.NOT_STARTED);
});

test("3. Essay completed alone does not achieve the criterion", () => {
  const essay = evaluate({
    draftFormat: "ESSAY_BUILDER",
    questionCount: 10,
    scoreCorrect: 10,
    scorePercent: 100,
  });

  assert.equal(essay.certificationEligible, false);
  assert.equal(essay.certificationCounted, false);
  assert.equal(summary([essay]).certificateUnlocked, false);
});

test("4. Theory passed alone does not achieve the criterion", () => {
  const row = summary([theory()]).evidenceRows[0];

  assert.equal(row.theoryPassed, true);
  assert.equal(row.assessmentAPassed, false);
  assert.equal(row.status, CERTIFICATION_STATUS.NOT_PASSED);
});

test("5. Assessment A passed alone does not achieve the criterion", () => {
  const row = summary([assessment()]).evidenceRows[0];

  assert.equal(row.theoryPassed, false);
  assert.equal(row.assessmentAPassed, true);
  assert.equal(row.status, CERTIFICATION_STATUS.NOT_PASSED);
});

test("6. passed Theory and passed Assessment A achieve the criterion", () => {
  const result = summary([theory(), assessment()]);

  assert.equal(result.evidenceRows[0].status, CERTIFICATION_STATUS.PASSED);
  assert.equal(result.certificateUnlocked, true);
});

test("7. failed Theory and passed Assessment A do not achieve", () => {
  assert.equal(
    summary([theory({ score: 65 }), assessment()]).certificateUnlocked,
    false,
  );
});

test("8. passed Theory and failed Assessment A do not achieve", () => {
  assert.equal(
    summary([theory(), assessment({ correct: 6 })]).certificateUnlocked,
    false,
  );
});

test("9. pending Theory and passed Assessment A do not achieve", () => {
  const row = summary([
    theory({ score: 0, status: "pending_review" }),
    assessment(),
  ]).evidenceRows[0];

  assert.equal(row.status, CERTIFICATION_STATUS.PENDING_REVIEW);
  assert.equal(row.theoryPassed, false);
});

test("10. Assessment B is not required", () => {
  const row = summary([theory(), assessment()]).evidenceRows[0];

  assert.equal(row.status, CERTIFICATION_STATUS.PASSED);
  assert.equal(row.assessmentBStatus, CERTIFICATION_STATUS.NOT_STARTED);
});

test("11. a passed optional Assessment B preserves achievement", () => {
  const row = summary([
    theory(),
    assessment(),
    assessment({ sequence: "B", correct: 9 }),
  ]).evidenceRows[0];

  assert.equal(row.status, CERTIFICATION_STATUS.PASSED);
  assert.equal(row.assessmentBPassed, true);
});

test("12. a failed optional Assessment B does not revoke achievement", () => {
  const row = summary([
    theory(),
    assessment(),
    assessment({ sequence: "B", correct: 4 }),
  ]).evidenceRows[0];

  assert.equal(row.status, CERTIFICATION_STATUS.PASSED);
  assert.equal(row.assessmentBStatus, CERTIFICATION_STATUS.NOT_PASSED);
});

test("13. Essay completion retains its result identity for audit history", () => {
  const mission = missionFixture({
    draftFormat: "ESSAY_BUILDER",
    questionCount: 10,
    scorePercent: 100,
  });
  const resultPackage = resultFixture({ scorePercent: 100 });
  const essay = evaluateCertificationMission({
    mission,
    resultPackage,
    settingsContext: settingsContext(),
  });
  const historyItem = buildStudentMissionHistoryItem({
    mission,
    resultPackage,
    certificationSummary: essay,
  });

  assert.match(essay.missionId, /^mission-/);
  assert.match(essay.resultPackageId, /^result-/);
  assert.match(essay.reason, /learning progress only/);
  assert.equal(historyItem.resultPackageId, essay.resultPackageId);
  assert.equal(historyItem.statusLabel, "Completed");
});

test("14. Q5 and Q8 progression thresholds remain 4 of 5 and 6 of 8", () => {
  assert.equal(calculateRequiredCorrectAnswers(5), 4);
  assert.equal(calculateRequiredCorrectAnswers(8), 6);
});

test("15. Theory threshold remains 70 percent", () => {
  assert.equal(THEORY_PASS_PERCENT, 70);
  assert.equal(theory({ score: 70 }).certificationPassStatus, CERTIFICATION_STATUS.PASSED);
  assert.equal(theory({ score: 69.9 }).certificationPassStatus, CERTIFICATION_STATUS.NOT_PASSED);
});

test("16. Assessment A threshold remains 7 of 10", () => {
  assert.equal(ASSESSMENT_PASS_CORRECT, 7);
  assert.equal(assessment({ correct: 7 }).certificationPassStatus, CERTIFICATION_STATUS.PASSED);
  assert.equal(assessment({ correct: 6 }).certificationPassStatus, CERTIFICATION_STATUS.NOT_PASSED);
});

test("17. P2 follows the same rule independently from P1", () => {
  const requiredTaskCodes = ["P1", "P2"];
  const result = summary([
    theory({ taskCode: "P1", requiredTaskCodes }),
    assessment({ taskCode: "P1", requiredTaskCodes }),
    theory({ taskCode: "P2", requiredTaskCodes }),
  ], requiredTaskCodes);

  assert.deepEqual(result.passedTaskCodes, ["P1"]);
  assert.deepEqual(result.remainingTaskCodes, ["P2"]);
  assert.equal(result.certificateUnlocked, false);
});

test("18. unrelated objective, Test, and Exam sizes cannot fill Assessment A", () => {
  const q15 = evaluate({
    draftFormat: "QUESTIONS",
    questionCount: 15,
    scoreCorrect: 15,
    scorePercent: 100,
  });
  const q20 = evaluate({
    draftFormat: "QUESTIONS",
    questionCount: 20,
    scoreCorrect: 20,
    scorePercent: 100,
  });
  const row = summary([theory(), q15, q20]).evidenceRows[0];

  assert.equal(q15.certificationEligible, false);
  assert.equal(q20.certificationEligible, false);
  assert.equal(row.assessmentAStatus, CERTIFICATION_STATUS.NOT_STARTED);
  assert.equal(row.status, CERTIFICATION_STATUS.NOT_PASSED);
});

test("legacy unsequenced assessments derive A then optional B without mutation", () => {
  const legacyA = assessment({ sequence: "", correct: 8 });
  const legacyB = assessment({ sequence: "", correct: 4 });
  const row = summary([theory(), legacyA, legacyB]).evidenceRows[0];

  assert.equal(row.assessmentAMissionId, legacyA.missionId);
  assert.equal(row.assessmentBMissionId, legacyB.missionId);
  assert.equal(row.status, CERTIFICATION_STATUS.PASSED);
});
