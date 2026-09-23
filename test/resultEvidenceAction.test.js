/**
 * WHAT:
 * Tests the deterministic Redo and Move Evidence payload/selection rules.
 * WHY:
 * Submitted ResultPackages must remain unchanged while new drafts and derived
 * target evidence preserve exact student text and current-stage consequences.
 * HOW:
 * Exercise exported pure helpers with Theory and Essay fixtures, including
 * restoration, Pending redo, conflict, prompt warning, and invalid-code cases.
 */
const assert = require("node:assert/strict");
const test = require("node:test");

const resultEvidenceActionService = require(
  "../src/services/resultEvidenceAction.service",
);

function sourceMission({ stage = "THEORY", taskCode = "P1" } = {}) {
  return {
    _id: "source-mission",
    studentId: "student-1",
    subjectId: "subject-1",
    sessionType: "morning",
    title: `${taskCode} ${stage}`,
    teacherNote: "Exact note",
    sourceUnitText: "Source unit",
    sourceRawText: "Source raw",
    sourceFileName: "source.docx",
    sourceFileType: "docx",
    draftFormat: stage,
    essayMode: stage === "ESSAY_BUILDER" ? "NORMAL" : null,
    draftJson: stage === "ESSAY_BUILDER"
      ? { essayQuestion: "Exact source essay prompt?", sentences: [] }
      : null,
    source: "groq",
    aiModel: "model",
    difficulty: "medium",
    certificationPlanId: "plan-1",
    certificationPlanVersion: 2,
    certificationPlanSource: "teacher_plan",
    certificationLabelSnapshot: "Certificate",
    certificationRequiredTaskCodesSnapshot: ["P1", "P2"],
    xpReward: 50,
    taskCodes: [taskCode],
    availableOnDate: "2026-09-20",
    availableOnDay: "Sunday",
    publishedAt: "2026-09-20T09:00:00.000Z",
    taskFocusAssignedAt: "2026-09-20T09:00:00.000Z",
    createdAt: "2026-09-20T09:00:00.000Z",
    createdBy: "teacher-1",
    latestResultPackageId: "source-result",
    questions: stage === "THEORY"
      ? [
          { answerMode: "short_answer", prompt: "Exact question one?" },
          { answerMode: "short_answer", prompt: "Exact question two?" },
        ]
      : [],
  };
}

function sourceResult({ stage = "THEORY" } = {}) {
  return {
    _id: "source-result",
    studentId: "student-1",
    subjectId: "subject-1",
    teacherId: "teacher-1",
    missionId: "source-mission",
    missionType: stage,
    meta: {
      studentName: "Student",
      studentId: "student-1",
      missionId: "source-mission",
      missionTitle: "Original",
      taskCodes: ["P1"],
      submitTime: "2026-09-20T10:00:00.000Z",
      score: { correct: 75, total: 100, percent: 75 },
      xpAwarded: 38,
    },
    evidence: stage === "THEORY"
      ? {
          reviewStatus: "scored",
          questions: [
            {
              questionText: "Exact question one?",
              studentAnswer: "  Exact answer one.\nKept.  ",
              teacherScorePercent: 70,
              teacherFeedback: "Historical feedback one",
            },
            {
              questionText: "Exact question two?",
              studentAnswer: "Exact Answer Two.",
              teacherScorePercent: 80,
              teacherFeedback: "Historical feedback two",
            },
          ],
        }
      : {
          finalEssayText: "Exact  final essay.\nSecond line.",
          questionEvidenceFiles: [
            {
              id: "question-file-1",
              questionIndex: 0,
              originalFileName: "student-work.docx",
              fileHash: "a".repeat(64),
            },
          ],
          teacherReviewStatus: "scored",
          teacherReview: { scorePercent: 75, teacherFeedback: "Historical" },
          perSentence: [
            {
              sentenceId: "s1",
              blankSelections: [
                { blankId: "b1", chosenOptionLetter: "C" },
              ],
            },
          ],
        },
  };
}

test("Theory redo creates a zero-score current mission and exact editable answers", () => {
  const mission = sourceMission();
  const resultPackage = sourceResult();
  const now = new Date("2026-09-23T09:00:00.000Z");
  const redo = resultEvidenceActionService.buildRedoMissionData({
    sourceMission: mission,
    sourceResultPackage: resultPackage,
    teacherId: "teacher-1",
    now,
  });
  const draft = resultEvidenceActionService.buildRedoDraftData({
    sourceMission: mission,
    sourceResultPackage: resultPackage,
    redoMissionId: "redo-mission",
  });

  assert.equal(redo.status, "published");
  assert.equal(redo.latestResultPackageId, null);
  assert.equal(redo.latestScorePercent, 0);
  assert.equal(redo.latestXpEarned, 0);
  assert.equal(redo.redoOfResultPackageId, "source-result");
  assert.deepEqual(
    draft.theoryResponses.map((item) => item.answerText),
    ["  Exact answer one.\nKept.  ", "Exact Answer Two."],
  );
  assert.equal(draft.status, "in_progress");
  assert.equal(draft.theoryResponses[0].teacherFeedback, undefined);
});

test("Essay redo preserves exact finalEssayText and compatible guided selections", () => {
  const mission = sourceMission({ stage: "ESSAY_BUILDER" });
  const resultPackage = sourceResult({ stage: "ESSAY_BUILDER" });
  const draft = resultEvidenceActionService.buildRedoDraftData({
    sourceMission: mission,
    sourceResultPackage: resultPackage,
    redoMissionId: "redo-essay",
  });
  assert.equal(
    draft.essayBuilder.finalEssayText,
    "Exact  final essay.\nSecond line.",
  );
  assert.deepEqual(draft.essayBuilder.selectedAnswers, [
    { sentenceId: "s1", blankId: "b1", selectedOption: "C" },
  ]);
  assert.equal(draft.essayBuilder.teacherReview, undefined);
});

test("Move preview restores another source result and reports target conflict", () => {
  const mission = sourceMission();
  const preview = resultEvidenceActionService.buildMovePreviewPayload({
    sourceMission: mission,
    sourceResultPackage: sourceResult(),
    targetTaskCode: "P2",
    sourceCandidates: [
      mission,
      {
        ...sourceMission(),
        _id: "older-source",
        latestResultPackageId: "older-result",
        taskFocusAssignedAt: "2026-09-01T09:00:00.000Z",
      },
    ],
    targetCandidates: [
      {
        ...sourceMission({ taskCode: "P2" }),
        _id: "target-current",
        latestResultPackageId: "target-result",
        questions: [{ prompt: "Different P2 prompt?" }],
      },
    ],
  });
  assert.equal(preview.sourceOutcome, "restore_previous");
  assert.equal(preview.olderSourceEvidenceId, "older-result");
  assert.equal(preview.targetConflict, true);
  assert.equal(preview.theoryPromptMismatchWarning, true);
  assert.deepEqual(preview.sourcePrompts, [
    "Exact question one?",
    "Exact question two?",
  ]);
  assert.deepEqual(preview.targetPrompts, ["Different P2 prompt?"]);
});

test("Move preview requires a redo when no other source evidence exists", () => {
  const mission = sourceMission({ stage: "ESSAY_BUILDER" });
  const preview = resultEvidenceActionService.buildMovePreviewPayload({
    sourceMission: mission,
    sourceResultPackage: sourceResult({ stage: "ESSAY_BUILDER" }),
    targetTaskCode: "P2",
    sourceCandidates: [mission],
    targetCandidates: [],
  });
  assert.equal(preview.sourceOutcome, "redo_required");
  assert.equal(preview.olderSourceEvidenceAvailable, false);
  assert.equal(preview.targetConflict, false);
});

test("automatic source redo is blank when no separate older draft exists", () => {
  const draft = resultEvidenceActionService.buildAutomaticSourceRedoDraftData({
    sourceMission: sourceMission(),
    redoMissionId: "automatic-redo",
  });
  assert.deepEqual(draft.theoryResponses, []);
  assert.equal(draft.status, "in_progress");
});

test("automatic source redo restores separate older draft text exactly", () => {
  const draft = resultEvidenceActionService.buildAutomaticSourceRedoDraftData({
    sourceMission: sourceMission({ stage: "ESSAY_BUILDER" }),
    redoMissionId: "automatic-redo",
    olderWorkDraft: {
      essayBuilder: {
        selectedAnswers: [
          { sentenceId: "s1", blankId: "b1", selectedOption: "A" },
        ],
        currentSentenceIndex: 1,
        finalEssayText: "Older  draft text.\nExact.",
      },
    },
  });
  assert.equal(
    draft.essayBuilder.finalEssayText,
    "Older  draft text.\nExact.",
  );
  assert.deepEqual(draft.essayBuilder.selectedAnswers, [
    { sentenceId: "s1", blankId: "b1", selectedOption: "A" },
  ]);
});

test("Moved target package preserves source evidence and XP snapshot without re-awarding it", () => {
  const mission = sourceMission({ stage: "ESSAY_BUILDER" });
  const resultPackage = sourceResult({ stage: "ESSAY_BUILDER" });
  const before = structuredClone(resultPackage);
  const targetMission = { _id: "target-mission", title: "P2 Essay" };
  const moved = resultEvidenceActionService.buildMovedResultPackageData({
    sourceMission: mission,
    sourceResultPackage: resultPackage,
    targetMission,
    targetTaskCode: "P2",
    teacherId: "teacher-1",
    movedAt: new Date("2026-09-23T10:00:00.000Z"),
    evidenceReclassificationId: "move-1",
  });
  assert.deepEqual(resultPackage, before);
  assert.equal(moved.evidence.finalEssayText, before.evidence.finalEssayText);
  assert.deepEqual(
    moved.evidence.questionEvidenceFiles,
    before.evidence.questionEvidenceFiles,
  );
  assert.equal(moved.meta.score.percent, 75);
  assert.equal(moved.meta.xpAwarded, 38);
  assert.deepEqual(moved.meta.taskCodes, ["P2"]);
  assert.equal(
    moved.evidence.reclassification.sourceResultPackageId,
    "source-result",
  );
  assert.equal(moved.evidence.reclassification.xpWasNotReawarded, true);
});

test("moved-out evidence is skipped when choosing current stage", () => {
  const selected = resultEvidenceActionService.selectCurrentStageMission(
    [
      {
        ...sourceMission(),
        _id: "moved-current",
        evidenceCurrentExcluded: true,
        taskFocusAssignedAt: "2026-09-23T09:00:00.000Z",
      },
      {
        ...sourceMission(),
        _id: "restored-older",
        taskFocusAssignedAt: "2026-09-01T09:00:00.000Z",
      },
    ],
    "THEORY",
  );
  assert.equal(selected._id, "restored-older");
});

test("invalid or same task codes are rejected before move writes", () => {
  assert.throws(
    () => resultEvidenceActionService.normalizeTaskCode("P8"),
    /P1-P7/,
  );
  assert.throws(
    () => resultEvidenceActionService.buildMovePreviewPayload({
      sourceMission: { ...sourceMission(), taskCodes: ["P1", "P2"] },
      sourceResultPackage: sourceResult(),
      targetTaskCode: "P3",
      sourceCandidates: [],
      targetCandidates: [],
    }),
    /exactly one Task Focus/,
  );
});
