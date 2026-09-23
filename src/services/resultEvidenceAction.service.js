/**
 * WHAT:
 * resultEvidenceAction.service owns teacher-controlled Redo and Move Evidence
 * workflows for completed Theory and Essay Builder results.
 * WHY:
 * Teachers need to correct current qualification evidence without deleting or
 * rewriting the learner's original submitted ResultPackage.
 * HOW:
 * Resolve authority from stored mission/result ownership, copy content into a
 * new attempt or derived target record, preserve source evidence, and execute
 * multi-record move writes inside a MongoDB transaction.
 */
const mongoose = require("mongoose");

const EvidenceReclassification = require("../models/EvidenceReclassification");
const Mission = require("../models/Mission");
const MissionWorkDraft = require("../models/MissionWorkDraft");
const ResultPackage = require("../models/ResultPackage");
const Timetable = require("../models/Timetable");
const User = require("../models/User");
const { getDateKey } = require("../utils/xpPolicy");

const ELIGIBLE_STAGES = new Set(["THEORY", "ESSAY_BUILDER"]);
const VALID_TASK_CODES = Object.freeze([
  "P1", "P2", "P3", "P4", "P5", "P6", "P7",
  "M1", "M2", "M3", "D1", "D2",
]);

function createError(statusCode, message, code = "RESULT_EVIDENCE_ACTION_ERROR") {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function cloneJson(value) {
  if (value === undefined || value === null) {
    return value ?? null;
  }
  return JSON.parse(JSON.stringify(value));
}

function normalizeTaskCode(value) {
  const taskCode = String(value || "").trim().toUpperCase();
  if (!VALID_TASK_CODES.includes(taskCode)) {
    throw createError(
      400,
      "Target task code must be P1-P7, M1-M3, or D1-D2.",
      "INVALID_TASK_CODE",
    );
  }
  return taskCode;
}

function normalizeMissionTaskCodes(mission) {
  return [...new Set(
    (Array.isArray(mission?.taskCodes) ? mission.taskCodes : [])
      .map((value) => String(value || "").trim().toUpperCase())
      .filter((value) => VALID_TASK_CODES.includes(value)),
  )];
}

function sourceTaskCodeForMission(mission) {
  const taskCodes = normalizeMissionTaskCodes(mission);
  if (taskCodes.length !== 1) {
    // WHY: A move or redo must have one unambiguous source criterion; one
    // evidence bundle cannot silently become current for several task codes.
    throw createError(
      409,
      "Redo and Move require a mission with exactly one Task Focus.",
      "AMBIGUOUS_SOURCE_TASK_CODE",
    );
  }
  return taskCodes[0];
}

function missionStage(mission) {
  return String(mission?.draftFormat || "").trim().toUpperCase();
}

function toTime(value) {
  const parsed = value ? new Date(value) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed.getTime() : 0;
}

function compareMissionRecency(left, right) {
  for (const field of ["taskFocusAssignedAt", "availableOnDate", "createdAt"]) {
    const delta = toTime(right?.[field]) - toTime(left?.[field]);
    if (delta !== 0) {
      return delta;
    }
  }
  return String(right?._id || "").localeCompare(String(left?._id || ""));
}

function selectCurrentStageMission(missions, stageType) {
  return [...(Array.isArray(missions) ? missions : [])]
    .filter(
      (mission) =>
        missionStage(mission) === stageType &&
        mission?.evidenceCurrentExcluded !== true,
    )
    .sort(compareMissionRecency)[0] || null;
}

function resultIsCurrentForMission(mission) {
  return Boolean(mission?.latestResultPackageId);
}

function countWords(value) {
  return String(value || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

function copyMissionQuestion(question) {
  return {
    answerMode: String(question?.answerMode || "multiple_choice"),
    learningText: String(question?.learningText || ""),
    learningVideoUrl: String(question?.learningVideoUrl || ""),
    learningVideoPlacement: String(
      question?.learningVideoPlacement || "afterLearnFirst",
    ),
    prompt: String(question?.prompt || ""),
    options: Array.isArray(question?.options)
      ? question.options.map((option) => String(option || ""))
      : [],
    correctIndex: Number(question?.correctIndex ?? -1),
    explanation: String(question?.explanation || ""),
    expectedAnswer: String(question?.expectedAnswer || ""),
    minWordCount: Number(question?.minWordCount || 0),
  };
}

function commonMissionCopy(sourceMission) {
  return {
    studentId: sourceMission.studentId,
    subjectId: sourceMission.subjectId,
    sessionType: sourceMission.sessionType,
    title: sourceMission.title,
    teacherNote: sourceMission.teacherNote,
    sourceUnitText: sourceMission.sourceUnitText,
    sourceRawText: sourceMission.sourceRawText,
    sourceFileName: sourceMission.sourceFileName,
    sourceFileType: sourceMission.sourceFileType,
    draftFormat: sourceMission.draftFormat,
    essayMode: sourceMission.essayMode,
    draftJson: cloneJson(sourceMission.draftJson),
    source: sourceMission.source,
    aiModel: sourceMission.aiModel,
    difficulty: sourceMission.difficulty,
    certificationPlanId: sourceMission.certificationPlanId,
    certificationPlanVersion: sourceMission.certificationPlanVersion,
    certificationPlanSource: sourceMission.certificationPlanSource,
    certificationLabelSnapshot: sourceMission.certificationLabelSnapshot,
    certificationRequiredTaskCodesSnapshot: Array.isArray(
      sourceMission.certificationRequiredTaskCodesSnapshot,
    )
      ? [...sourceMission.certificationRequiredTaskCodesSnapshot]
      : [],
    xpReward: sourceMission.xpReward,
    manualResultOnly: false,
    questions: (Array.isArray(sourceMission.questions)
      ? sourceMission.questions
      : []).map(copyMissionQuestion),
  };
}

function buildRedoMissionData({ sourceMission, sourceResultPackage, teacherId, now }) {
  const sourceTaskCode = sourceTaskCodeForMission(sourceMission);
  const stageType = missionStage(sourceMission);
  if (!ELIGIBLE_STAGES.has(stageType)) {
    throw createError(
      400,
      "Redo is only available for Theory and Essay Builder evidence.",
      "REDO_NOT_SUPPORTED",
    );
  }
  const currentDate = getDateKey(now);
  const availableOnDay = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
  }).format(now);
  return {
    ...commonMissionCopy(sourceMission),
    status: "published",
    isArchived: false,
    archivedAt: null,
    archivedBy: null,
    publishedAt: now,
    availableOnDate: currentDate,
    availableOnDay,
    taskCodes: [sourceTaskCode],
    taskFocusAssignedAt: now,
    assessmentSequenceByTaskCode: {},
    latestScoreCorrect: 0,
    latestScoreTotal: 0,
    latestScorePercent: 0,
    latestXpEarned: 0,
    latestResultPackageId: null,
    createdBy: teacherId,
    reusedFromMissionId: null,
    redoOfMissionId: sourceMission._id,
    redoOfResultPackageId: sourceResultPackage._id,
    evidenceCurrentExcluded: false,
  };
}

function buildRedoDraftData({ sourceMission, sourceResultPackage, redoMissionId }) {
  const stageType = missionStage(sourceMission);
  const evidence = sourceResultPackage?.evidence || {};
  if (stageType === "THEORY") {
    return {
      studentId: sourceMission.studentId,
      missionId: redoMissionId,
      subjectId: sourceMission.subjectId,
      missionType: stageType,
      theoryResponses: (Array.isArray(evidence.questions) ? evidence.questions : [])
        .slice(0, Array.isArray(sourceMission.questions) ? sourceMission.questions.length : 0)
        .map((question, questionIndex) => {
          const answerText = String(question?.studentAnswer || "");
          return {
            questionIndex,
            answerText,
            wordCount: countWords(answerText),
            updatedAt: new Date(),
          };
        }),
      status: "in_progress",
      version: 1,
    };
  }

  const selectedAnswers = [];
  for (const sentence of Array.isArray(evidence.perSentence)
    ? evidence.perSentence
    : []) {
    const sentenceId = String(sentence?.sentenceId || "").trim();
    for (const blank of Array.isArray(sentence?.blankSelections)
      ? sentence.blankSelections
      : []) {
      const blankId = String(blank?.blankId || "").trim();
      const selectedOption = String(blank?.chosenOptionLetter || "")
        .trim()
        .toUpperCase();
      if (sentenceId && blankId && ["A", "B", "C", "D"].includes(selectedOption)) {
        selectedAnswers.push({ sentenceId, blankId, selectedOption });
      }
    }
  }
  const finalEssayText = String(evidence.finalEssayText || "");
  return {
    studentId: sourceMission.studentId,
    missionId: redoMissionId,
    subjectId: sourceMission.subjectId,
    missionType: stageType,
    essayBuilder: {
      selectedAnswers,
      currentSentenceIndex: Array.isArray(evidence.perSentence)
        ? evidence.perSentence.length
        : 0,
      finalEssayText,
      finalEssayWordCount: countWords(finalEssayText),
      updatedAt: new Date(),
    },
    status: "in_progress",
    version: 1,
  };
}

function buildAutomaticSourceRedoDraftData({
  sourceMission,
  redoMissionId,
  olderWorkDraft = null,
}) {
  const stageType = missionStage(sourceMission);
  const base = {
    studentId: sourceMission.studentId,
    missionId: redoMissionId,
    subjectId: sourceMission.subjectId,
    missionType: stageType,
    status: "in_progress",
    version: 1,
  };
  if (stageType === "THEORY") {
    const questionCount = Array.isArray(sourceMission.questions)
      ? sourceMission.questions.length
      : 0;
    return {
      ...base,
      theoryResponses: (Array.isArray(olderWorkDraft?.theoryResponses)
        ? olderWorkDraft.theoryResponses
        : [])
        .filter((item) => {
          const index = Number(item?.questionIndex);
          return Number.isInteger(index) && index >= 0 && index < questionCount;
        })
        .map((item) => {
          const answerText = String(item?.answerText || "");
          return {
            questionIndex: Number(item.questionIndex),
            answerText,
            wordCount: countWords(answerText),
            updatedAt: new Date(),
          };
        }),
    };
  }
  const finalEssayText = String(
    olderWorkDraft?.essayBuilder?.finalEssayText || "",
  );
  return {
    ...base,
    essayBuilder: {
      selectedAnswers: cloneJson(
        olderWorkDraft?.essayBuilder?.selectedAnswers || [],
      ),
      currentSentenceIndex: Number(
        olderWorkDraft?.essayBuilder?.currentSentenceIndex || 0,
      ),
      finalEssayText,
      finalEssayWordCount: countWords(finalEssayText),
      updatedAt: new Date(),
    },
  };
}

function theoryPrompts({ mission, resultPackage }) {
  const evidenceQuestions = Array.isArray(resultPackage?.evidence?.questions)
    ? resultPackage.evidence.questions
    : [];
  if (evidenceQuestions.length > 0) {
    return evidenceQuestions.map((question) => String(question?.questionText || ""));
  }
  return (Array.isArray(mission?.questions) ? mission.questions : [])
    .map((question) => String(question?.prompt || ""));
}

function essayPrompt(mission) {
  const candidates = [
    mission?.draftJson?.essayQuestion,
    mission?.draftJson?.question,
    mission?.draftJson?.prompt,
    mission?.teacherNote,
    mission?.title,
  ];
  return String(candidates.find((value) => String(value || "").trim()) || "").trim();
}

function buildMovePreviewPayload({
  sourceMission,
  sourceResultPackage,
  targetTaskCode,
  sourceCandidates,
  targetCandidates,
}) {
  const sourceTaskCode = sourceTaskCodeForMission(sourceMission);
  const stageType = missionStage(sourceMission);
  const previousSourceMission = selectCurrentStageMission(
    sourceCandidates.filter(
      (mission) =>
        String(mission?._id || "") !== String(sourceMission?._id || "") &&
        resultIsCurrentForMission(mission),
    ),
    stageType,
  );
  const targetMission = selectCurrentStageMission(targetCandidates, stageType);
  const targetConflict = Boolean(
    targetMission && resultIsCurrentForMission(targetMission),
  );
  const isTheory = stageType === "THEORY";
  return {
    sourceTaskCode,
    targetTaskCode,
    stage: stageType,
    sourceLabel: `${sourceTaskCode} ${isTheory ? "Theory" : "Essay"}`,
    targetLabel: `${targetTaskCode} ${isTheory ? "Theory" : "Essay"}`,
    studentAnswerRetained: true,
    olderSourceEvidenceAvailable: Boolean(previousSourceMission),
    olderSourceEvidenceId: previousSourceMission?.latestResultPackageId
      ? String(previousSourceMission.latestResultPackageId)
      : "",
    olderSourceMissionId: previousSourceMission?._id
      ? String(previousSourceMission._id)
      : "",
    sourceOutcome: previousSourceMission ? "restore_previous" : "redo_required",
    targetOutcome: "moved_evidence",
    targetConflict,
    targetConflictMissionId: targetConflict ? String(targetMission._id || "") : "",
    targetConflictResultPackageId: targetConflict
      ? String(targetMission.latestResultPackageId || "")
      : "",
    sourcePrompts: isTheory
      ? theoryPrompts({ mission: sourceMission, resultPackage: sourceResultPackage })
      : [essayPrompt(sourceMission)].filter(Boolean),
    targetPrompts: isTheory && targetMission
      ? theoryPrompts({ mission: targetMission, resultPackage: null })
      : targetMission
      ? [essayPrompt(targetMission)].filter(Boolean)
      : [],
    theoryPromptMismatchWarning: isTheory && sourceTaskCode !== targetTaskCode,
  };
}

async function assertTeacherCanManageResult({
  teacherId,
  resultPackage,
  mission,
  session,
}) {
  if (
    String(resultPackage?.teacherId || "") === String(teacherId || "") ||
    String(mission?.createdBy || "") === String(teacherId || "")
  ) {
    return;
  }
  const teacherQuery = User.findOne({ _id: teacherId, role: "teacher" })
    .select("assignedStudents")
    .lean();
  const teacher = session ? await teacherQuery.session(session) : await teacherQuery;
  const assignedStudents = Array.isArray(teacher?.assignedStudents)
    ? teacher.assignedStudents.map((value) => String(value || ""))
    : [];
  if (!assignedStudents.includes(String(resultPackage?.studentId || ""))) {
    throw createError(
      403,
      "Teachers can only change evidence for their assigned students and subjects.",
      "RESULT_ACTION_ACCESS_DENIED",
    );
  }
  const timetableQuery = Timetable.exists({
    studentId: resultPackage.studentId,
    $or: [
      { morningSubject: resultPackage.subjectId, morningTeacherId: teacherId },
      { afternoonSubject: resultPackage.subjectId, afternoonTeacherId: teacherId },
    ],
  });
  const timetableAccess = session
    ? await timetableQuery.session(session)
    : await timetableQuery;
  if (!timetableAccess) {
    // WHY: Assigned-student membership alone is too broad; the teacher must
    // also own this learner's subject through a server-side timetable record.
    throw createError(
      403,
      "Teachers can only change evidence for their assigned students and subjects.",
      "RESULT_ACTION_ACCESS_DENIED",
    );
  }
}

async function loadActionContext({ teacherId, resultPackageId, session = null }) {
  let resultQuery = ResultPackage.findById(resultPackageId).lean();
  if (session) {
    resultQuery = resultQuery.session(session);
  }
  const resultPackage = await resultQuery;
  if (!resultPackage || String(resultPackage.resultKind || "mission") !== "mission") {
    throw createError(404, "Mission result package not found.", "RESULT_NOT_FOUND");
  }
  let missionQuery = Mission.findById(resultPackage.missionId).lean();
  if (session) {
    missionQuery = missionQuery.session(session);
  }
  const mission = await missionQuery;
  if (!mission || String(mission.studentId) !== String(resultPackage.studentId)) {
    throw createError(404, "Mission not found for this result package.", "MISSION_NOT_FOUND");
  }
  const stageType = missionStage(mission);
  const resultStage = String(resultPackage.missionType || "").trim().toUpperCase();
  if (!ELIGIBLE_STAGES.has(stageType) || stageType !== resultStage) {
    throw createError(
      400,
      "Redo and Move are only available for Theory and Essay Builder evidence.",
      "RESULT_ACTION_NOT_SUPPORTED",
    );
  }
  if (
    String(mission.latestResultPackageId || "") !== String(resultPackage._id || "") ||
    mission.evidenceCurrentExcluded === true
  ) {
    // WHY: Historical evidence remains readable, but only a mission's current
    // linked package can initiate another current-stage action.
    throw createError(
      409,
      "This result is historical and is no longer the mission's current evidence.",
      "RESULT_NOT_CURRENT",
    );
  }
  sourceTaskCodeForMission(mission);
  await assertTeacherCanManageResult({
    teacherId,
    resultPackage,
    mission,
    session,
  });
  return { mission, resultPackage, stageType };
}

async function withTransaction(work) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}

async function createRedo({ teacherId, resultPackageId }) {
  console.info("[result-action] redo_start", { teacherId, resultPackageId });
  try {
    const output = await withTransaction(async (session) => {
      const { mission, resultPackage } = await loadActionContext({
        teacherId,
        resultPackageId,
        session,
      });
      const now = new Date();
      const [redoMission] = await Mission.create(
        [buildRedoMissionData({
          sourceMission: mission,
          sourceResultPackage: resultPackage,
          teacherId,
          now,
        })],
        { session },
      );
      const [draft] = await MissionWorkDraft.create(
        [buildRedoDraftData({
          sourceMission: mission,
          sourceResultPackage: resultPackage,
          redoMissionId: redoMission._id,
        })],
        { session },
      );
      return {
        missionId: String(redoMission._id),
        draftId: String(draft._id),
        sourceResultPackageId: String(resultPackage._id),
        stage: missionStage(mission),
        taskCode: sourceTaskCodeForMission(mission),
      };
    });
    console.info("[result-action] redo_complete", output);
    return output;
  } catch (error) {
    if (Number(error?.code) === 11000) {
      throw createError(
        409,
        "A redo already exists for this result.",
        "REDO_ALREADY_EXISTS",
      );
    }
    throw error;
  }
}

async function findStageCandidates({ mission, taskCode, session = null }) {
  let query = Mission.find({
    studentId: mission.studentId,
    subjectId: mission.subjectId,
    taskCodes: taskCode,
    manualResultOnly: { $ne: true },
    isArchived: { $ne: true },
  }).lean();
  if (session) {
    query = query.session(session);
  }
  return query;
}

async function buildMovePreview({
  teacherId,
  resultPackageId,
  targetTaskCode,
  session = null,
}) {
  const normalizedTargetTaskCode = normalizeTaskCode(targetTaskCode);
  const { mission, resultPackage } = await loadActionContext({
    teacherId,
    resultPackageId,
    session,
  });
  const sourceTaskCode = sourceTaskCodeForMission(mission);
  if (normalizedTargetTaskCode === sourceTaskCode) {
    throw createError(
      400,
      "Choose a different target task code.",
      "TARGET_MATCHES_SOURCE",
    );
  }
  const [sourceCandidates, targetCandidates] = await Promise.all([
    findStageCandidates({ mission, taskCode: sourceTaskCode, session }),
    findStageCandidates({ mission, taskCode: normalizedTargetTaskCode, session }),
  ]);
  return {
    preview: buildMovePreviewPayload({
      sourceMission: mission,
      sourceResultPackage: resultPackage,
      targetTaskCode: normalizedTargetTaskCode,
      sourceCandidates,
      targetCandidates,
    }),
    mission,
    resultPackage,
    sourceCandidates,
  };
}

function buildMovedMissionData({
  sourceMission,
  sourceResultPackage,
  targetTaskCode,
  teacherId,
  movedAt,
  evidenceReclassificationId,
}) {
  const score = sourceResultPackage?.meta?.score || {};
  return {
    ...commonMissionCopy(sourceMission),
    status: "published",
    isArchived: false,
    archivedAt: null,
    archivedBy: null,
    publishedAt: sourceMission.publishedAt || movedAt,
    availableOnDate: sourceMission.availableOnDate,
    availableOnDay: sourceMission.availableOnDay,
    taskCodes: [targetTaskCode],
    taskFocusAssignedAt: movedAt,
    assessmentSequenceByTaskCode: {},
    latestScoreCorrect: Number(score.correct || 0),
    latestScoreTotal: Number(score.total || 0),
    latestScorePercent: Number(score.percent || 0),
    latestXpEarned: 0,
    latestResultPackageId: null,
    createdBy: teacherId,
    reusedFromMissionId: null,
    evidenceCurrentExcluded: false,
    evidenceMovedFromTaskCode: sourceTaskCodeForMission(sourceMission),
    evidenceMovedBy: teacherId,
    evidenceMovedAt: movedAt,
    evidenceReclassificationId,
  };
}

function buildMovedResultPackageData({
  sourceMission,
  sourceResultPackage,
  targetMission,
  targetTaskCode,
  teacherId,
  movedAt,
  evidenceReclassificationId,
}) {
  const sourceTaskCode = sourceTaskCodeForMission(sourceMission);
  const evidence = cloneJson(sourceResultPackage.evidence || {});
  return {
    studentId: sourceResultPackage.studentId,
    teacherId,
    missionId: targetMission._id,
    sessionLogId: null,
    subjectId: sourceResultPackage.subjectId,
    resultKind: "mission",
    missionType: sourceResultPackage.missionType,
    meta: {
      ...cloneJson(sourceResultPackage.meta || {}),
      teacherId: String(teacherId || ""),
      missionId: String(targetMission._id || ""),
      missionTitle: String(targetMission.title || ""),
      taskCodes: [targetTaskCode],
      // WHY: This copies only the audit snapshot; no User XP write occurs.
      // Retaining it also prevents a later re-score from awarding it twice.
      xpAwarded: Number(sourceResultPackage?.meta?.xpAwarded || 0),
    },
    evidence: {
      ...evidence,
      reclassification: {
        id: String(evidenceReclassificationId || ""),
        movedFromTaskCode: sourceTaskCode,
        movedToTaskCode: targetTaskCode,
        sourceMissionId: String(sourceMission._id || ""),
        sourceResultPackageId: String(sourceResultPackage._id || ""),
        movedByTeacherId: String(teacherId || ""),
        movedAt: movedAt.toISOString(),
        xpWasNotReawarded: true,
      },
    },
    latestSendStatus: "not_sent",
  };
}

async function moveEvidence({
  teacherId,
  resultPackageId,
  targetTaskCode,
  replaceTargetEvidence = false,
  reason = "",
}) {
  const normalizedReason = String(reason || "").trim();
  if (normalizedReason.length > 2000) {
    throw createError(400, "Move reason is too long.", "INVALID_MOVE_REASON");
  }
  console.info("[result-action] move_start", {
    teacherId,
    resultPackageId,
    targetTaskCode,
  });
  try {
    const output = await withTransaction(async (session) => {
      const {
        preview,
        mission,
        resultPackage,
        sourceCandidates,
      } = await buildMovePreview({
        teacherId,
        resultPackageId,
        targetTaskCode,
        session,
      });
      if (preview.targetConflict && replaceTargetEvidence !== true) {
        // WHY: Existing target evidence is never displaced by an implicit or
        // stale client decision; the teacher must confirm replacement.
        throw createError(
          409,
          "Target evidence already exists. Confirm replacement to continue.",
          "TARGET_EVIDENCE_CONFLICT",
        );
      }

      const movedAt = new Date();
      const reclassificationId = new mongoose.Types.ObjectId();
      const [targetMission] = await Mission.create(
        [buildMovedMissionData({
          sourceMission: mission,
          sourceResultPackage: resultPackage,
          targetTaskCode: preview.targetTaskCode,
          teacherId,
          movedAt,
          evidenceReclassificationId: reclassificationId,
        })],
        { session },
      );
      const [targetResultPackage] = await ResultPackage.create(
        [buildMovedResultPackageData({
          sourceMission: mission,
          sourceResultPackage: resultPackage,
          targetMission,
          targetTaskCode: preview.targetTaskCode,
          teacherId,
          movedAt,
          evidenceReclassificationId: reclassificationId,
        })],
        { session },
      );
      await Mission.updateOne(
        { _id: targetMission._id, latestResultPackageId: null },
        { $set: { latestResultPackageId: targetResultPackage._id } },
        { session },
      );

      let sourceRedoMission = null;
      if (preview.sourceOutcome === "redo_required") {
        const olderMissionIds = sourceCandidates
          .filter(
            (candidate) =>
              String(candidate?._id || "") !== String(mission._id || ""),
          )
          .map((candidate) => candidate._id)
          .filter(Boolean);
        let olderWorkDraft = null;
        if (olderMissionIds.length > 0) {
          olderWorkDraft = await MissionWorkDraft.findOne({
            studentId: mission.studentId,
            missionId: { $in: olderMissionIds },
          })
            .sort({ updatedAt: -1 })
            .session(session)
            .lean();
        }
        [sourceRedoMission] = await Mission.create(
          [buildRedoMissionData({
            sourceMission: mission,
            sourceResultPackage: resultPackage,
            teacherId,
            now: movedAt,
          })],
          { session },
        );
        await MissionWorkDraft.create(
          [buildAutomaticSourceRedoDraftData({
            sourceMission: mission,
            redoMissionId: sourceRedoMission._id,
            olderWorkDraft,
          })],
          { session },
        );
      }

      const sourceUpdate = await Mission.updateOne(
        {
          _id: mission._id,
          latestResultPackageId: resultPackage._id,
          evidenceCurrentExcluded: { $ne: true },
        },
        {
          $set: {
            evidenceCurrentExcluded: true,
            evidenceMovedToTaskCode: preview.targetTaskCode,
            evidenceMovedBy: teacherId,
            evidenceMovedAt: movedAt,
            evidenceReclassificationId: reclassificationId,
          },
        },
        { session },
      );
      if (Number(sourceUpdate.modifiedCount || 0) !== 1) {
        throw createError(
          409,
          "Source evidence changed before the move completed. Preview again.",
          "SOURCE_EVIDENCE_CHANGED",
        );
      }

      await EvidenceReclassification.create(
        [{
          _id: reclassificationId,
          studentId: resultPackage.studentId,
          subjectId: resultPackage.subjectId,
          stageType: preview.stage,
          sourceTaskCode: preview.sourceTaskCode,
          targetTaskCode: preview.targetTaskCode,
          sourceMissionId: mission._id,
          sourceResultPackageId: resultPackage._id,
          targetMissionId: targetMission._id,
          targetResultPackageId: targetResultPackage._id,
          restoredSourceMissionId: preview.olderSourceMissionId || null,
          sourceRedoMissionId: sourceRedoMission?._id || null,
          replacedTargetMissionId: preview.targetConflictMissionId || null,
          replacedTargetResultPackageId:
            preview.targetConflictResultPackageId || null,
          movedByTeacherId: teacherId,
          movedAt,
          reason: normalizedReason,
          sourceOutcome: preview.sourceOutcome,
          targetOutcome: preview.targetConflict
            ? "replaced_current"
            : "moved_evidence",
          status: "completed",
        }],
        { session },
      );

      return {
        ...preview,
        evidenceReclassificationId: String(reclassificationId),
        targetMissionId: String(targetMission._id),
        targetResultPackageId: String(targetResultPackage._id),
        sourceRedoMissionId: sourceRedoMission ? String(sourceRedoMission._id) : "",
      };
    });
    console.info("[result-action] move_complete", {
      teacherId,
      resultPackageId,
      evidenceReclassificationId: output.evidenceReclassificationId,
    });
    return output;
  } catch (error) {
    if (Number(error?.code) === 11000) {
      throw createError(
        409,
        "This evidence has already been moved or already has a redo.",
        "RESULT_ACTION_ALREADY_EXISTS",
      );
    }
    throw error;
  }
}

module.exports = {
  VALID_TASK_CODES,
  buildMovePreview,
  buildMovePreviewPayload,
  buildMovedResultPackageData,
  buildAutomaticSourceRedoDraftData,
  buildRedoDraftData,
  buildRedoMissionData,
  createRedo,
  moveEvidence,
  normalizeTaskCode,
  selectCurrentStageMission,
};
