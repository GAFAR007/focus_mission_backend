/**
 * WHAT:
 * Tests current-attempt selection, weighted Task Focus scoring, report comment
 * validation, and text-based PDF generation.
 * WHY:
 * Draft Reports must not mix historic evidence or show a final percentage while
 * any current required component is pending.
 * HOW:
 * Exercise the report service's deterministic pure helpers with dated fixtures.
 */
const assert = require("node:assert/strict");
const test = require("node:test");

const criterionReportService = require("../src/services/criterionReport.service");

function mission({
  id,
  format = "QUESTIONS",
  count = 5,
  date,
  sequence = "",
  resultPackageId = "",
}) {
  return {
    _id: id,
    draftFormat: format,
    questions: Array.from({ length: count }, () => ({})),
    taskFocusAssignedAt: date,
    availableOnDate: date.slice(0, 10),
    createdAt: date,
    latestResultPackageId: resultPackageId,
    assessmentSequenceByTaskCode: sequence ? { P1: sequence } : {},
  };
}

test("Sudais five-part fixture calculates exactly 82.45 percent", () => {
  const calculation = criterionReportService.calculateWeightedScore({
    theory: 71,
    assessmentA: 100,
    essay: 63,
    q5: 100,
    q8: 100,
  });
  assert.equal(calculation.status, "scored");
  assert.equal(calculation.overallPercent, 82.45);
  assert.deepEqual(
    calculation.rows.map((row) => row.contribution),
    [24.85, 35, 12.6, 5, 5],
  );
});

test("missing Assessment A keeps the final overall score Pending", () => {
  const calculation = criterionReportService.calculateWeightedScore({
    theory: 70,
    assessmentA: null,
    essay: 47,
    q5: 100,
    q8: 100,
  });
  assert.equal(calculation.status, "pending");
  assert.equal(calculation.overallPercent, null);
  assert.equal(calculation.securedContribution, 43.9);
});

test("Assessment B cannot affect the weighted total", () => {
  const baseline = criterionReportService.calculateWeightedScore({
    theory: 80,
    assessmentA: 70,
    essay: 60,
    q5: 100,
    q8: 100,
  });
  const withIgnoredAssessmentB = criterionReportService.calculateWeightedScore({
    theory: 80,
    assessmentA: 70,
    assessmentB: 0,
    essay: 60,
    q5: 100,
    q8: 100,
  });
  assert.equal(withIgnoredAssessmentB.overallPercent, baseline.overallPercent);
  assert.equal(withIgnoredAssessmentB.rows.length, 5);
});

test("changing Theory score immediately changes its contribution and total", () => {
  const before = criterionReportService.calculateWeightedScore({
    theory: 70,
    assessmentA: 100,
    essay: 63,
    q5: 100,
    q8: 100,
  });
  const after = criterionReportService.calculateWeightedScore({
    theory: 80,
    assessmentA: 100,
    essay: 63,
    q5: 100,
    q8: 100,
  });
  assert.equal(before.rows[0].contribution, 24.5);
  assert.equal(after.rows[0].contribution, 28);
  assert.equal(after.overallPercent - before.overallPercent, 3.5);
});

test("changing Essay or Assessment A recalculates the live total", () => {
  const baseline = {
    theory: 71,
    assessmentA: 70,
    essay: 60,
    q5: 100,
    q8: 100,
  };
  const essayChanged = criterionReportService.calculateWeightedScore({
    ...baseline,
    essay: 80,
  });
  const assessmentChanged = criterionReportService.calculateWeightedScore({
    ...baseline,
    assessmentA: 80,
  });
  const original = criterionReportService.calculateWeightedScore(baseline);
  assert.equal(essayChanged.overallPercent - original.overallPercent, 4);
  assert.equal(assessmentChanged.overallPercent - original.overallPercent, 3.5);
});

test("Q5 and Q8 report evidence is result-only", () => {
  const currentMission = {
    _id: "objective-mission",
    latestResultPackageId: "objective-result",
    questions: [{ prompt: "Must not appear" }],
  };
  const evidence = criterionReportService.objectiveEvidence(
    "Q5 Daily",
    currentMission,
    {
      _id: "objective-result",
      missionId: "objective-mission",
      meta: { score: { correct: 5, total: 5, percent: 100 } },
      evidence: { questions: [{ prompt: "Must not appear" }] },
    },
  );
  assert.deepEqual(Object.keys(evidence).sort(), [
    "correct",
    "label",
    "missionId",
    "passed",
    "percent",
    "resultPackageId",
    "status",
    "total",
  ]);
  assert.equal(evidence.percent, 100);
});

test("Essay evidence keeps the exact question, full text, and original feedback", () => {
  const currentMission = {
    _id: "essay-mission",
    latestResultPackageId: "essay-result",
    draftJson: { essayQuestion: "Exact Essay question?" },
  };
  const resultPackage = {
    _id: "essay-result",
    missionId: "essay-mission",
    meta: { score: { correct: 19, total: 30, percent: 63 } },
    evidence: {
      finalEssayText: "Exact  student Essay.\nOriginal line.",
      finalWordCount: 5,
      teacherReviewStatus: "scored",
      teacherReview: {
        scoreCorrect: 19,
        scoreTotal: 30,
        scorePercent: 63,
        teacherFeedback: "Original Essay feedback.",
        nextTime: "Original next step.",
      },
    },
  };
  const evidence = criterionReportService.essayEvidence(
    currentMission,
    resultPackage,
    null,
  );
  assert.equal(evidence.question, "Exact Essay question?");
  assert.equal(evidence.finalEssayText, "Exact  student Essay.\nOriginal line.");
  assert.equal(evidence.teacherComment, "Original Essay feedback.");
  assert.equal(evidence.nextTime, "Original next step.");
});

test("Theory evidence includes every exact prompt, answer, and original comment", () => {
  const currentMission = {
    _id: "theory-mission",
    latestResultPackageId: "theory-result",
    questions: [{ prompt: "Fallback one?" }, { prompt: "Fallback two?" }],
  };
  const evidence = criterionReportService.theoryEvidence(
    currentMission,
    {
      _id: "theory-result",
      missionId: "theory-mission",
      meta: { score: { percent: 71 } },
      evidence: {
        reviewStatus: "scored",
        averageTeacherScorePercent: 71,
        questions: [
          {
            questionText: "Exact question one?",
            studentAnswer: "Exact  answer one.\nKept.",
            teacherScorePercent: 53,
            teacherFeedback: "Original one.",
          },
          {
            questionText: "Exact question two?",
            studentAnswer: "Exact answer Two.",
            teacherScorePercent: 89,
            teacherFeedback: "Original two.",
          },
        ],
      },
    },
    null,
  );
  assert.deepEqual(
    evidence.questions.map((item) => item.prompt),
    ["Exact question one?", "Exact question two?"],
  );
  assert.deepEqual(
    evidence.questions.map((item) => item.studentAnswer),
    ["Exact  answer one.\nKept.", "Exact answer Two."],
  );
  assert.deepEqual(
    evidence.questions.map((item) => item.teacherComment),
    ["Original one.", "Original two."],
  );
});

test("report comment overrides do not mutate original ResultPackage evidence", () => {
  const currentMission = {
    _id: "essay-mission",
    latestResultPackageId: "essay-result",
    draftJson: { essayQuestion: "Question" },
  };
  const resultPackage = {
    _id: "essay-result",
    missionId: "essay-mission",
    evidence: {
      finalEssayText: "Submitted answer.",
      teacherReviewStatus: "scored",
      teacherReview: {
        scorePercent: 63,
        teacherFeedback: "Immutable original.",
        nextTime: "Immutable next time.",
      },
    },
  };
  const before = structuredClone(resultPackage);
  const reportEvidence = criterionReportService.essayEvidence(
    currentMission,
    resultPackage,
    {
      essayTeacherComment: "Report-only wording.",
      essayNextTime: "Report-only next step.",
    },
  );
  assert.equal(reportEvidence.teacherComment, "Report-only wording.");
  assert.equal(reportEvidence.nextTime, "Report-only next step.");
  assert.deepEqual(resultPackage, before);
});

test("newest Assessment A redo is selected even when it has no result", () => {
  const oldScored = mission({
    id: "old-a",
    count: 10,
    date: "2026-01-01T09:00:00.000Z",
    sequence: "A",
    resultPackageId: "old-result",
  });
  const currentPending = mission({
    id: "new-a",
    count: 10,
    date: "2026-02-01T09:00:00.000Z",
    sequence: "A",
  });
  const selected = criterionReportService.selectCurrentEvidenceMissions(
    [oldScored, currentPending],
    "P1",
  );
  assert.equal(selected.assessmentA._id, "new-a");
  assert.equal(selected.assessmentA.latestResultPackageId, "");
});

test("each report stage selects its newest current mission independently", () => {
  const selected = criterionReportService.selectCurrentEvidenceMissions(
    [
      mission({ id: "q5-old", date: "2026-01-01T09:00:00.000Z" }),
      mission({ id: "q5-new", date: "2026-02-01T09:00:00.000Z" }),
      mission({ id: "q8", count: 8, date: "2026-01-05T09:00:00.000Z" }),
      mission({ id: "essay", format: "ESSAY_BUILDER", count: 0, date: "2026-01-06T09:00:00.000Z" }),
      mission({ id: "theory", format: "THEORY", count: 3, date: "2026-01-07T09:00:00.000Z" }),
    ],
    "P1",
  );
  assert.equal(selected.q5._id, "q5-new");
  assert.equal(selected.q8._id, "q8");
  assert.equal(selected.essay._id, "essay");
  assert.equal(selected.theory._id, "theory");
});

test("legacy unsequenced assessments use stable A then B chronology", () => {
  const selected = criterionReportService.selectCurrentEvidenceMissions(
    [
      mission({ id: "legacy-b", count: 10, date: "2026-02-01T09:00:00.000Z" }),
      mission({ id: "legacy-a", count: 10, date: "2026-01-01T09:00:00.000Z" }),
    ],
    "P1",
  );
  assert.equal(selected.assessmentA._id, "legacy-a");
  assert.equal(selected.assessmentB._id, "legacy-b");
});

test("report comment normalization keeps explicit empty overrides", () => {
  const normalized = criterionReportService.normalizeReportDraftPayload({
    essayTeacherComment: "",
    essayNextTime: "Try a stronger conclusion.",
    theoryQuestionComments: [
      { questionIndex: 1, comment: "Second" },
      { questionIndex: 0, comment: "" },
    ],
  });
  assert.equal(normalized.essayTeacherComment, "");
  assert.deepEqual(normalized.theoryQuestionComments, [
    { questionIndex: 0, comment: "" },
    { questionIndex: 1, comment: "Second" },
  ]);
});

test("report comment normalization rejects invalid Theory indexes", () => {
  assert.throws(
    () => criterionReportService.normalizeReportDraftPayload({
      essayTeacherComment: "",
      essayNextTime: "",
      theoryQuestionComments: [{ questionIndex: 10, comment: "No" }],
    }),
    /index is invalid/,
  );
});

test("PDF export is a real PDF with font resources rather than image-only evidence", async () => {
  const pendingObjective = { label: "Q5 Daily", status: "pending" };
  const report = {
    title: "Sudais Dahir — P1 Business Online Draft Report",
    criterionWording: "Use business evidence to explain online operations.",
    taskCode: "P1",
    student: { name: "Sudais Dahir" },
    q5: pendingObjective,
    q8: { ...pendingObjective, label: "Q8 Revision" },
    essay: {
      status: "scored",
      question: "Explain how a business operates online.",
      finalEssayText: "This exact student essay remains text in the PDF.",
      scoreCorrect: 19,
      scoreTotal: 30,
      percent: 63,
      teacherComment: "Clear evidence.",
      nextTime: "Develop the conclusion.",
    },
    theory: {
      status: "scored",
      percent: 71,
      passed: true,
      questions: [{
        questionIndex: 0,
        prompt: "What is an online business?",
        studentAnswer: "An exact answer.",
        originalTeacherScore: 71,
        teacherComment: "Good.",
      }],
    },
    assessmentA: { label: "P1 Assessment A", status: "pending" },
    assessmentB: { label: "P1 Assessment B", status: "not_created" },
    scoringStructure: criterionReportService.SCORING_COMPONENTS.map((item) => ({
      ...item,
      weightPercent: item.weight * 100,
    })),
    calculation: criterionReportService.calculateWeightedScore({
      theory: 71,
      assessmentA: null,
      essay: 63,
      q5: null,
      q8: null,
    }),
    criterionStatus: { passed: false, reason: "Assessment A is pending." },
  };
  const pdf = await criterionReportService.buildCriterionReportPdf(report);
  assert.equal(pdf.subarray(0, 4).toString(), "%PDF");
  const source = pdf.toString("latin1");
  assert.match(source, /\/Font/);
  assert.doesNotMatch(source, /\/Subtype\s*\/Image/);
});
