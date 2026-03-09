/**
 * WHAT:
 * subjectCertification.service derives subject-level task-focus certification
 * progress from teacher-owned student-subject plans or legacy subject templates.
 * WHY:
 * Certification is the active student-facing subject progress layer, and
 * teachers need auditable control over the live objective set without deleting
 * the older subject-template fallback during the transition.
 * HOW:
 * Resolve one active certification context per student and subject, version plan
 * changes, snapshot mission intent, evaluate qualifying evidence, and apply one
 * idempotent certificate award per unlocked objective set.
 */
const Mission = require("../models/Mission");
const ResultPackage = require("../models/ResultPackage");
const StudentCertificationPlan = require("../models/StudentCertificationPlan");
const Subject = require("../models/Subject");
const Timetable = require("../models/Timetable");
const User = require("../models/User");
const {
  calculateCompletionPercentage,
  isAssessmentQuestionCount,
} = require("../utils/xpPolicy");
const {
  calculateRequiredCorrectAnswers,
} = require("../utils/missionPassPolicy");

const CERTIFICATION_TASK_CODE_PATTERN = /^[PMD]\d+$/i;
const THEORY_PASS_PERCENT = 70;
const THEORY_REVIEW_PENDING = "pending_review";
const THEORY_REVIEW_SCORED = "scored";
const QUALIFYING_DRAFT_FORMATS = Object.freeze([
  "QUESTIONS",
  "THEORY",
  "ESSAY_BUILDER",
]);
const PLAN_SOURCE = Object.freeze({
  NONE: "none",
  TEACHER_PLAN: "teacher_plan",
  SUBJECT_TEMPLATE: "subject_template",
});
const CERTIFICATION_STATUS = Object.freeze({
  PASSED: "passed",
  NOT_PASSED: "not_passed",
  NOT_STARTED: "not_started",
  NOT_ELIGIBLE: "not_eligible",
  PENDING_REVIEW: "pending_review",
});

function createError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizeTaskCodes(taskCodes) {
  const normalized = [];
  const seen = new Set();

  for (const taskCode of Array.isArray(taskCodes) ? taskCodes : []) {
    const value = String(taskCode || "").trim().toUpperCase();
    if (!CERTIFICATION_TASK_CODE_PATTERN.test(value) || seen.has(value)) {
      continue;
    }
    seen.add(value);
    normalized.push(value);
  }

  return normalized;
}

function resolveCertificationLabel(value) {
  const label = String(value || "").trim();
  return label || "Course Certification";
}

function buildAwardKey(subjectId, requiredTaskCodes) {
  return `${String(subjectId || "")}:${normalizeTaskCodes(requiredTaskCodes).join("|")}`;
}

function buildTeacherTimetableMatch({ teacherId, subjectId, studentId }) {
  return {
    studentId,
    $or: [
      {
        morningSubject: subjectId,
        morningTeacherId: teacherId,
      },
      {
        afternoonSubject: subjectId,
        afternoonTeacherId: teacherId,
      },
    ],
  };
}

function serializeSubjectCertificationSettings(subject) {
  return {
    subjectId: String(subject?._id || subject?.id || ""),
    subjectName: String(subject?.name || ""),
    subjectIcon: String(subject?.icon || ""),
    subjectColor: String(subject?.color || ""),
    certificationEnabled: subject?.certificationEnabled === true,
    requiredCertificationTaskCodes: normalizeTaskCodes(
      subject?.requiredCertificationTaskCodes,
    ),
    certificationLabel: resolveCertificationLabel(subject?.certificationLabel),
  };
}

function serializePlanContext({ subject, plan = null }) {
  const requiredTaskCodes = plan ?
    normalizeTaskCodes(plan.requiredTaskCodes)
  : normalizeTaskCodes(subject?.requiredCertificationTaskCodes);
  const planSource = plan ? PLAN_SOURCE.TEACHER_PLAN :
    (subject?.certificationEnabled === true ? PLAN_SOURCE.SUBJECT_TEMPLATE : PLAN_SOURCE.NONE);
  const certificationEnabled = requiredTaskCodes.length > 0 && planSource !== PLAN_SOURCE.NONE;

  return {
    subjectId: String(subject?._id || subject?.id || ""),
    subjectName: String(subject?.name || ""),
    subjectIcon: String(subject?.icon || ""),
    subjectColor: String(subject?.color || ""),
    certificationEnabled,
    certificationLabel: resolveCertificationLabel(
      plan?.certificationLabel || subject?.certificationLabel,
    ),
    requiredTaskCodes,
    planSource,
    planId: plan ? String(plan._id || plan.id || "") : "",
    planVersion: plan ? Number(plan.version || 0) : 0,
    planUpdatedAt: plan?.updatedAt ? new Date(plan.updatedAt).toISOString() : null,
    planChangeReason: String(plan?.changeReason || ""),
  };
}

function buildMissionCertificationSnapshot(settingsContext) {
  const requiredTaskCodes = normalizeTaskCodes(settingsContext?.requiredTaskCodes);
  const source = settingsContext?.certificationEnabled === true && requiredTaskCodes.length > 0 ?
    String(settingsContext?.planSource || PLAN_SOURCE.NONE)
  : PLAN_SOURCE.NONE;

  return {
    certificationPlanId: source === PLAN_SOURCE.TEACHER_PLAN ? settingsContext.planId : null,
    certificationPlanVersion: source === PLAN_SOURCE.TEACHER_PLAN ? Number(settingsContext.planVersion || 0) : 0,
    certificationPlanSource: source,
    certificationLabelSnapshot: source === PLAN_SOURCE.NONE ? "" : resolveCertificationLabel(settingsContext?.certificationLabel),
    certificationRequiredTaskCodesSnapshot: source === PLAN_SOURCE.NONE ? [] : requiredTaskCodes,
  };
}

function validateCertificationTemplateInput(payload) {
  const certificationEnabled = payload?.certificationEnabled === true;
  const rawTaskCodes = Array.isArray(payload?.requiredCertificationTaskCodes) ?
    payload.requiredCertificationTaskCodes
  : [];
  const requiredCertificationTaskCodes = normalizeTaskCodes(rawTaskCodes);
  const certificationLabel = String(payload?.certificationLabel || "")
    .trim()
    .slice(0, 80);

  if (certificationEnabled && requiredCertificationTaskCodes.length === 0) {
    throw createError(
      400,
      "At least one required certification task code is needed when certification is enabled.",
    );
  }

  if (requiredCertificationTaskCodes.length !== rawTaskCodes.length) {
    throw createError(
      400,
      "requiredCertificationTaskCodes must contain unique valid task codes like P1, P2, M1, or D1.",
    );
  }

  return {
    certificationEnabled,
    requiredCertificationTaskCodes,
    certificationLabel: certificationLabel || "Course Certification",
  };
}

function validateTeacherPlanInput(payload) {
  const rawTaskCodes = Array.isArray(payload?.requiredTaskCodes) ? payload.requiredTaskCodes : [];
  const requiredTaskCodes = normalizeTaskCodes(rawTaskCodes);
  const certificationLabel = String(payload?.certificationLabel || "")
    .trim()
    .slice(0, 80) || "Course Certification";
  const changeReason = String(payload?.changeReason || "")
    .trim()
    .slice(0, 240);

  if (requiredTaskCodes.length === 0) {
    throw createError(400, "Select at least one certification task focus.");
  }

  if (requiredTaskCodes.length !== rawTaskCodes.length) {
    throw createError(
      400,
      "requiredTaskCodes must contain unique valid task codes like P1, P2, M1, or D1.",
    );
  }

  if (!changeReason) {
    // WHY: Teacher-owned plans need an audit trail every time objectives are
    // changed so staff can explain why a learner's certification target moved.
    throw createError(400, "A short changeReason is required for certification plan updates.");
  }

  return {
    certificationLabel,
    requiredTaskCodes,
    changeReason,
  };
}

function isQualifyingMissionType(mission) {
  const draftFormat = String(mission?.draftFormat || "QUESTIONS")
    .trim()
    .toUpperCase();

  if (!QUALIFYING_DRAFT_FORMATS.includes(draftFormat)) {
    return false;
  }

  if (draftFormat === "QUESTIONS") {
    const questionCount = Array.isArray(mission?.questions) ? mission.questions.length : 0;
    return isAssessmentQuestionCount(questionCount);
  }

  return true;
}

function resolveMissionCompletionTime(mission, resultPackage) {
  return resultPackage?.meta?.submitTime ||
    resultPackage?.createdAt ||
    mission?.publishedAt ||
    mission?.updatedAt ||
    mission?.createdAt ||
    null;
}

function normalizeMissionTaskCodes(mission) {
  return normalizeTaskCodes(mission?.taskCodes);
}

function missionUsesMatchingPlanContext(mission, settingsContext) {
  if (!settingsContext?.certificationEnabled) {
    return false;
  }

  const missionPlanSource = String(mission?.certificationPlanSource || PLAN_SOURCE.NONE);

  if (settingsContext.planSource === PLAN_SOURCE.TEACHER_PLAN) {
    return (
      missionPlanSource === PLAN_SOURCE.TEACHER_PLAN &&
      String(mission?.certificationPlanId || "") === String(settingsContext.planId || "") &&
      Number(mission?.certificationPlanVersion || 0) === Number(settingsContext.planVersion || 0)
    );
  }

  if (settingsContext.planSource === PLAN_SOURCE.SUBJECT_TEMPLATE) {
    if (missionPlanSource === PLAN_SOURCE.NONE) {
      return true;
    }

    return missionPlanSource === PLAN_SOURCE.SUBJECT_TEMPLATE;
  }

  return false;
}

function resolveMissionSettingsContext({ mission, subject }) {
  const snapshotRequiredTaskCodes = normalizeTaskCodes(
    mission?.certificationRequiredTaskCodesSnapshot,
  );
  const snapshotSource = String(mission?.certificationPlanSource || PLAN_SOURCE.NONE);

  if (snapshotSource !== PLAN_SOURCE.NONE && snapshotRequiredTaskCodes.length > 0) {
    return {
      subjectId: String(subject?._id || subject?.id || mission?.subjectId || ""),
      subjectName: String(subject?.name || ""),
      subjectIcon: String(subject?.icon || ""),
      subjectColor: String(subject?.color || ""),
      certificationEnabled: true,
      certificationLabel: resolveCertificationLabel(mission?.certificationLabelSnapshot),
      requiredTaskCodes: snapshotRequiredTaskCodes,
      planSource: snapshotSource,
      planId: snapshotSource === PLAN_SOURCE.TEACHER_PLAN ? String(mission?.certificationPlanId || "") : "",
      planVersion: snapshotSource === PLAN_SOURCE.TEACHER_PLAN ? Number(mission?.certificationPlanVersion || 0) : 0,
      planUpdatedAt: null,
      planChangeReason: "",
    };
  }

  return serializePlanContext({ subject, plan: null });
}

function evaluateCertificationMission({
  mission,
  resultPackage,
  settingsContext,
  enforceCurrentContext = false,
}) {
  const requiredTaskCodes = normalizeTaskCodes(settingsContext?.requiredTaskCodes);
  const normalizedTaskCodes = normalizeMissionTaskCodes(mission);
  const draftFormat = String(mission?.draftFormat || "QUESTIONS")
    .trim()
    .toUpperCase();
  const questionCount = Array.isArray(mission?.questions) ? mission.questions.length : 0;
  const completedAt = resolveMissionCompletionTime(mission, resultPackage);
  const baseResponse = {
    certificationEnabled: settingsContext?.certificationEnabled === true,
    certificationLabel: resolveCertificationLabel(settingsContext?.certificationLabel),
    requiredTaskCodes,
    planSource: String(settingsContext?.planSource || PLAN_SOURCE.NONE),
    planId: String(settingsContext?.planId || ""),
    planVersion: Number(settingsContext?.planVersion || 0),
    certificationEligible: false,
    certificationTaskCode: normalizedTaskCodes.length === 1 ? normalizedTaskCodes[0] : "",
    certificationCounted: false,
    certificationPassStatus: CERTIFICATION_STATUS.NOT_ELIGIBLE,
    scorePercent: 0,
    missionType: draftFormat,
    missionId: String(mission?._id || mission?.id || ""),
    resultPackageId: String(resultPackage?._id || resultPackage?.id || ""),
    completedAt: completedAt ? new Date(completedAt).toISOString() : null,
    reason: "",
  };

  if (settingsContext?.certificationEnabled !== true) {
    return {
      ...baseResponse,
      reason: "This subject does not use task-focus certification.",
    };
  }

  if (enforceCurrentContext && !missionUsesMatchingPlanContext(mission, settingsContext)) {
    return {
      ...baseResponse,
      reason:
        settingsContext?.planSource === PLAN_SOURCE.TEACHER_PLAN ?
          "This mission belongs to a different certification plan version."
        : "This mission was not authored against the active certification objective set.",
    };
  }

  if (!isQualifyingMissionType(mission)) {
    return {
      ...baseResponse,
      reason: "This mission format does not qualify for certification.",
    };
  }

  if (normalizedTaskCodes.length !== 1) {
    // WHY: Certification evidence must map to one task focus only, otherwise a
    // single mission could ambiguously unlock multiple qualification targets.
    return {
      ...baseResponse,
      reason:
        "Certification requires exactly one selected task focus on the mission.",
    };
  }

  const certificationTaskCode = normalizedTaskCodes[0];
  if (!requiredTaskCodes.includes(certificationTaskCode)) {
    return {
      ...baseResponse,
      certificationTaskCode,
      reason: "This task focus is not required for the active certification plan.",
    };
  }

  if (!resultPackage) {
    return {
      ...baseResponse,
      certificationEligible: true,
      certificationTaskCode,
      certificationPassStatus: CERTIFICATION_STATUS.NOT_PASSED,
      reason: "Result evidence is required before certification can be counted.",
    };
  }

  if (draftFormat === "ESSAY_BUILDER") {
    return {
      ...baseResponse,
      certificationEligible: true,
      certificationTaskCode,
      certificationCounted: true,
      certificationPassStatus: CERTIFICATION_STATUS.PASSED,
      scorePercent: 100,
      reason: "",
    };
  }

  if (draftFormat === "THEORY") {
    const reviewStatus = String(resultPackage?.evidence?.reviewStatus || THEORY_REVIEW_PENDING)
      .trim()
      .toLowerCase();
    const averageTeacherScorePercent = Math.max(
      0,
      Math.min(
        100,
        Number(resultPackage?.evidence?.averageTeacherScorePercent || 0),
      ),
    );

    if (reviewStatus !== THEORY_REVIEW_SCORED) {
      return {
        ...baseResponse,
        certificationEligible: true,
        certificationTaskCode,
        certificationPassStatus: CERTIFICATION_STATUS.PENDING_REVIEW,
        scorePercent: averageTeacherScorePercent,
        reason: "Theory missions do not count until teacher scoring is complete.",
      };
    }

    const passed = averageTeacherScorePercent >= THEORY_PASS_PERCENT;
    return {
      ...baseResponse,
      certificationEligible: true,
      certificationTaskCode,
      certificationCounted: passed,
      certificationPassStatus: passed ?
        CERTIFICATION_STATUS.PASSED
      : CERTIFICATION_STATUS.NOT_PASSED,
      scorePercent: Number(averageTeacherScorePercent.toFixed(1)),
      reason: passed ? "" : `Theory missions need at least ${THEORY_PASS_PERCENT}%.`,
    };
  }

  const requiredCorrectAnswers = calculateRequiredCorrectAnswers(questionCount);
  const scoreCorrect = Math.max(
    0,
    Number(
      mission?.latestScoreCorrect ?? resultPackage?.meta?.score?.correct ?? 0,
    ),
  );
  const scorePercent = Math.max(
    0,
    Math.min(
      100,
      Number(
        mission?.latestScorePercent ?? resultPackage?.meta?.score?.percent ?? 0,
      ),
    ),
  );
  const passed = requiredCorrectAnswers > 0 && scoreCorrect >= requiredCorrectAnswers;

  return {
    ...baseResponse,
    certificationEligible: true,
    certificationTaskCode,
    certificationCounted: passed,
    certificationPassStatus: passed ?
      CERTIFICATION_STATUS.PASSED
    : CERTIFICATION_STATUS.NOT_PASSED,
    scorePercent,
    reason: passed ? "" : `This mission needs ${requiredCorrectAnswers} correct answers to count.`,
  };
}

function pickBestEvidenceRow(evaluations, taskCode) {
  const taskEvaluations = evaluations.filter(
    (item) => item.certificationEligible && item.certificationTaskCode === taskCode,
  );

  const sortByBestScore = (left, right) => {
    const scoreDelta = Number(right?.scorePercent || 0) - Number(left?.scorePercent || 0);
    if (scoreDelta !== 0) {
      return scoreDelta;
    }
    return String(right?.completedAt || "").localeCompare(String(left?.completedAt || ""));
  };

  const passed = taskEvaluations
    .filter((item) => item.certificationPassStatus === CERTIFICATION_STATUS.PASSED)
    .sort(sortByBestScore);
  if (passed.length > 0) {
    const best = passed[0];
    return {
      taskCode,
      status: CERTIFICATION_STATUS.PASSED,
      bestScorePercent: Number(best.scorePercent || 0),
      bestMissionId: String(best.missionId || ""),
      bestResultPackageId: String(best.resultPackageId || ""),
      missionType: String(best.missionType || ""),
      completedAt: best.completedAt,
      reason: "",
    };
  }

  const pending = taskEvaluations
    .filter((item) => item.certificationPassStatus === CERTIFICATION_STATUS.PENDING_REVIEW)
    .sort((left, right) => String(right?.completedAt || "").localeCompare(String(left?.completedAt || "")));
  if (pending.length > 0) {
    const latest = pending[0];
    return {
      taskCode,
      status: CERTIFICATION_STATUS.PENDING_REVIEW,
      bestScorePercent: Number(latest.scorePercent || 0),
      bestMissionId: String(latest.missionId || ""),
      bestResultPackageId: String(latest.resultPackageId || ""),
      missionType: String(latest.missionType || ""),
      completedAt: latest.completedAt,
      reason: String(latest.reason || ""),
    };
  }

  const attempted = taskEvaluations
    .filter((item) => item.certificationPassStatus === CERTIFICATION_STATUS.NOT_PASSED)
    .sort(sortByBestScore);
  if (attempted.length > 0) {
    const bestAttempt = attempted[0];
    return {
      taskCode,
      status: CERTIFICATION_STATUS.NOT_PASSED,
      bestScorePercent: Number(bestAttempt.scorePercent || 0),
      bestMissionId: String(bestAttempt.missionId || ""),
      bestResultPackageId: String(bestAttempt.resultPackageId || ""),
      missionType: String(bestAttempt.missionType || ""),
      completedAt: bestAttempt.completedAt,
      reason: String(bestAttempt.reason || ""),
    };
  }

  return {
    taskCode,
    status: CERTIFICATION_STATUS.NOT_STARTED,
    bestScorePercent: 0,
    bestMissionId: "",
    bestResultPackageId: "",
    missionType: "",
    completedAt: null,
    reason: "",
  };
}

function buildSubjectCertificationSummary({
  settingsContext,
  evaluations,
  awardRecorded = false,
}) {
  const requiredTaskCodes = normalizeTaskCodes(settingsContext?.requiredTaskCodes);
  const evidenceRows = requiredTaskCodes.map((taskCode) =>
    pickBestEvidenceRow(evaluations, taskCode),
  );
  const passedRows = evidenceRows.filter((row) => row.status === CERTIFICATION_STATUS.PASSED);
  const passedTaskCodes = passedRows.map((row) => row.taskCode);
  const remainingTaskCodes = requiredTaskCodes.filter(
    (taskCode) => !passedTaskCodes.includes(taskCode),
  );
  const averagePassedScorePercent = passedRows.length > 0 ?
    Number(
      (
        passedRows.reduce((sum, row) => sum + Number(row.bestScorePercent || 0), 0) /
        passedRows.length
      ).toFixed(1),
    )
  : 0;
  const certificateUnlocked = requiredTaskCodes.length > 0 &&
    passedTaskCodes.length === requiredTaskCodes.length;

  return {
    subjectId: String(settingsContext?.subjectId || ""),
    subjectName: String(settingsContext?.subjectName || ""),
    subjectIcon: String(settingsContext?.subjectIcon || ""),
    subjectColor: String(settingsContext?.subjectColor || ""),
    certificationEnabled: settingsContext?.certificationEnabled === true,
    certificationLabel: resolveCertificationLabel(settingsContext?.certificationLabel),
    requiredTaskCodes,
    passedTaskCodes,
    remainingTaskCodes,
    completionPercentage: calculateCompletionPercentage({
      completedCount: passedTaskCodes.length,
      totalCount: requiredTaskCodes.length,
    }),
    averagePassedScorePercent,
    certificateUnlocked,
    awardRecorded,
    evidenceRows,
    planSource: String(settingsContext?.planSource || PLAN_SOURCE.NONE),
    planId: String(settingsContext?.planId || ""),
    planVersion: Number(settingsContext?.planVersion || 0),
    planUpdatedAt: settingsContext?.planUpdatedAt || null,
    planChangeReason: String(settingsContext?.planChangeReason || ""),
  };
}

async function loadStudentCertificationContext({
  studentId,
  subjectId = "",
}) {
  const normalizedSubjectId = String(subjectId || "").trim();
  const planMatch = {
    studentId,
    isActive: true,
  };
  if (normalizedSubjectId) {
    planMatch.subjectId = normalizedSubjectId;
  }

  const [student, activePlans, templateSubjects] = await Promise.all([
    User.findById(studentId)
      .select("subjectCertificationAwards")
      .lean(),
    StudentCertificationPlan.find(planMatch)
      .sort({ subjectId: 1, version: -1 })
      .lean(),
    Subject.find(normalizedSubjectId ? { _id: normalizedSubjectId } : { certificationEnabled: true })
      .sort({ name: 1 })
      .lean(),
  ]);

  const subjectIdsToLoad = new Set(
    [
      ...activePlans.map((plan) => String(plan.subjectId || "")),
      ...templateSubjects.map((subject) => String(subject._id || "")),
      normalizedSubjectId,
    ].filter(Boolean),
  );
  const subjects = subjectIdsToLoad.size > 0 ?
    await Subject.find({ _id: { $in: [...subjectIdsToLoad] } })
      .sort({ name: 1 })
      .lean()
  : [];
  const activePlanBySubjectId = new Map(
    activePlans.map((plan) => [String(plan.subjectId || ""), plan]),
  );
  const settingsContexts = subjects.map((subject) => {
    const plan = activePlanBySubjectId.get(String(subject._id || "")) || null;
    return serializePlanContext({ subject, plan });
  });
  const missionSubjectIds = settingsContexts.map((context) => context.subjectId).filter(Boolean);
  const missions = missionSubjectIds.length > 0 ?
    await Mission.find({
      studentId,
      subjectId: { $in: missionSubjectIds },
      latestResultPackageId: { $exists: true, $ne: null },
      $or: [{ status: "published" }, { status: { $exists: false } }],
    }).lean()
  : [];
  const resultPackageIds = missions
    .map((mission) => String(mission?.latestResultPackageId || ""))
    .filter(Boolean);
  const resultPackages = resultPackageIds.length > 0 ?
    await ResultPackage.find({ _id: { $in: resultPackageIds } })
      .select("missionId missionType meta evidence createdAt")
      .lean()
  : [];

  return {
    student,
    settingsContexts,
    subjectsById: new Map(
      subjects.map((subject) => [String(subject._id || ""), subject]),
    ),
    missions,
    resultPackageById: new Map(
      resultPackages.map((resultPackage) => [
        String(resultPackage._id || ""),
        resultPackage,
      ]),
    ),
  };
}

async function syncCertificationAwards({
  studentId,
  summaries,
}) {
  const learner = await User.findById(studentId).select("subjectCertificationAwards");

  if (!learner) {
    return new Set();
  }

  if (!Array.isArray(learner.subjectCertificationAwards)) {
    learner.subjectCertificationAwards = [];
  }

  const existingAwardKeys = new Set(
    learner.subjectCertificationAwards.map((award) =>
      buildAwardKey(award.subjectId, award.requiredTaskCodesSnapshot),
    ),
  );
  let changed = false;

  for (const summary of summaries) {
    const subjectId = String(summary?.subjectId || "");
    const awardKey = buildAwardKey(subjectId, summary?.requiredTaskCodes);
    if (!subjectId || summary?.certificateUnlocked !== true || existingAwardKeys.has(awardKey)) {
      continue;
    }

    learner.subjectCertificationAwards.push({
      subjectId,
      awardedAt: new Date(),
      requiredTaskCodesSnapshot: Array.isArray(summary?.requiredTaskCodes) ?
        summary.requiredTaskCodes
      : [],
      averagePassedScoreAtUnlock: Number(summary?.averagePassedScorePercent || 0),
    });
    existingAwardKeys.add(awardKey);
    changed = true;

    console.info("[certification] award unlocked", {
      studentId: String(studentId || ""),
      subjectId,
      averagePassedScorePercent: Number(summary?.averagePassedScorePercent || 0),
    });
  }

  if (changed) {
    await learner.save();
  }

  return existingAwardKeys;
}

async function getStudentCertificationSummaries({
  studentId,
  subjectId = "",
  applyAwards = false,
}) {
  console.info("[certification] summary start", {
    studentId: String(studentId || ""),
    subjectId: String(subjectId || ""),
    applyAwards: applyAwards === true,
  });

  const context = await loadStudentCertificationContext({ studentId, subjectId });
  const existingAwardKeys = new Set(
    (context.student?.subjectCertificationAwards || []).map((award) =>
      buildAwardKey(award.subjectId, award.requiredTaskCodesSnapshot),
    ),
  );

  const summaries = context.settingsContexts.map((settingsContext) => {
    const subjectIdKey = String(settingsContext.subjectId || "");
    const evaluations = context.missions
      .filter((mission) => String(mission?.subjectId || "") === subjectIdKey)
      .map((mission) =>
        evaluateCertificationMission({
          mission,
          resultPackage:
            context.resultPackageById.get(String(mission?.latestResultPackageId || "")) ||
            null,
          settingsContext,
          enforceCurrentContext: true,
        }),
      );

    return buildSubjectCertificationSummary({
      settingsContext,
      evaluations,
      awardRecorded: existingAwardKeys.has(
        buildAwardKey(subjectIdKey, settingsContext.requiredTaskCodes),
      ),
    });
  });

  let finalAwardKeys = existingAwardKeys;
  if (applyAwards) {
    finalAwardKeys = await syncCertificationAwards({
      studentId,
      summaries,
    });
  }

  const finalizedSummaries = summaries.map((summary) => ({
    ...summary,
    awardRecorded: finalAwardKeys.has(
      buildAwardKey(summary.subjectId, summary.requiredTaskCodes),
    ),
  }));

  console.info("[certification] summary complete", {
    studentId: String(studentId || ""),
    subjectCount: finalizedSummaries.length,
  });

  return finalizedSummaries;
}

async function getStudentSubjectCertificationContext({
  studentId,
  subjectId,
}) {
  const subject = await Subject.findById(subjectId).lean();
  if (!subject) {
    throw createError(404, "Subject not found.");
  }

  const activePlan = await StudentCertificationPlan.findOne({
    studentId,
    subjectId,
    isActive: true,
  }).lean();

  return serializePlanContext({ subject, plan: activePlan || null });
}

async function assertTeacherOwnsStudentSubject({
  teacherId,
  studentId,
  subjectId,
}) {
  const [teacher, subject, timetableOwnership] = await Promise.all([
    User.findOne({ _id: teacherId, role: "teacher" })
      .select("name subjectSpecialty")
      .lean(),
    Subject.findById(subjectId).lean(),
    Timetable.exists(buildTeacherTimetableMatch({ teacherId, studentId, subjectId })),
  ]);

  if (!teacher) {
    throw createError(404, "Teacher not found.");
  }

  if (!subject) {
    throw createError(404, "Subject not found.");
  }

  if (!timetableOwnership) {
    // WHY: Teacher-owned certification plans must only be editable by the
    // teacher who is actually scheduled to teach this student in that subject.
    throw createError(
      403,
      "Only the scheduled subject teacher can define certification objectives for this student.",
    );
  }

  return { teacher, subject };
}

async function updateTeacherStudentCertificationPlan({
  teacherId,
  studentId,
  subjectId,
  payload,
}) {
  console.info("[certification] teacher plan update start", {
    teacherId: String(teacherId || ""),
    studentId: String(studentId || ""),
    subjectId: String(subjectId || ""),
  });

  const normalizedPlan = validateTeacherPlanInput(payload);
  const { subject } = await assertTeacherOwnsStudentSubject({
    teacherId,
    studentId,
    subjectId,
  });
  const currentPlan = await StudentCertificationPlan.findOne({
    studentId,
    subjectId,
    isActive: true,
  });
  const nextLabel = resolveCertificationLabel(normalizedPlan.certificationLabel);
  const nextCodes = normalizeTaskCodes(normalizedPlan.requiredTaskCodes);
  const currentCodes = normalizeTaskCodes(currentPlan?.requiredTaskCodes);
  const labelChanged = resolveCertificationLabel(currentPlan?.certificationLabel) !== nextLabel;
  const codesChanged = JSON.stringify(currentCodes) !== JSON.stringify(nextCodes);

  if (currentPlan && !labelChanged && !codesChanged) {
    console.info("[certification] teacher plan unchanged", {
      teacherId: String(teacherId || ""),
      studentId: String(studentId || ""),
      subjectId: String(subjectId || ""),
      version: Number(currentPlan.version || 0),
    });
    const [summary] = await getStudentCertificationSummaries({
      studentId,
      subjectId,
      applyAwards: false,
    });
    return summary || buildSubjectCertificationSummary({
      settingsContext: serializePlanContext({ subject, plan: currentPlan.toObject() }),
      evaluations: [],
      awardRecorded: false,
    });
  }

  if (currentPlan) {
    currentPlan.isActive = false;
    await currentPlan.save();
  }

  const nextVersion = currentPlan ? Number(currentPlan.version || 0) + 1 : 1;
  await StudentCertificationPlan.create({
    studentId,
    subjectId,
    certificationLabel: nextLabel,
    requiredTaskCodes: nextCodes,
    version: nextVersion,
    isActive: true,
    createdBy: teacherId,
    updatedBy: teacherId,
    changeReason: normalizedPlan.changeReason,
  });

  console.info("[certification] teacher plan updated", {
    teacherId: String(teacherId || ""),
    studentId: String(studentId || ""),
    subjectId: String(subjectId || ""),
    version: nextVersion,
    requiredTaskCodes: nextCodes,
  });

  const [summary] = await getStudentCertificationSummaries({
    studentId,
    subjectId,
    applyAwards: false,
  });

  return summary || buildSubjectCertificationSummary({
    settingsContext: serializePlanContext({ subject, plan: null }),
    evaluations: [],
    awardRecorded: false,
  });
}

async function getMissionCertificationSummary({
  mission,
  resultPackage = null,
  subject = null,
}) {
  const subjectRecord = subject || (mission?.subjectId && typeof mission.subjectId === "object" ?
    mission.subjectId
  : await Subject.findById(mission?.subjectId).lean());
  if (!subjectRecord) {
    return {
      certificationEnabled: false,
      certificationLabel: "Course Certification",
      requiredTaskCodes: [],
      certificationEligible: false,
      certificationTaskCode: "",
      certificationCounted: false,
      certificationPassStatus: CERTIFICATION_STATUS.NOT_ELIGIBLE,
      reason: "Subject was not found for this mission.",
      planSource: PLAN_SOURCE.NONE,
      planId: "",
      planVersion: 0,
      scorePercent: 0,
    };
  }

  const settingsContext = resolveMissionSettingsContext({
    mission,
    subject: subjectRecord,
  });
  const evaluation = evaluateCertificationMission({
    mission,
    resultPackage,
    settingsContext,
    enforceCurrentContext: false,
  });

  return {
    certificationEnabled: settingsContext.certificationEnabled === true,
    certificationLabel: settingsContext.certificationLabel,
    requiredTaskCodes: settingsContext.requiredTaskCodes,
    certificationEligible: evaluation.certificationEligible,
    certificationTaskCode: evaluation.certificationTaskCode,
    certificationCounted: evaluation.certificationCounted,
    certificationPassStatus: evaluation.certificationPassStatus,
    reason: evaluation.reason,
    planSource: settingsContext.planSource,
    planId: settingsContext.planId,
    planVersion: settingsContext.planVersion,
    scorePercent: Number(evaluation.scorePercent || 0),
  };
}

async function getSubjectCertificationSettings(subjectId) {
  const subject = await Subject.findById(subjectId).lean();
  if (!subject) {
    throw createError(404, "Subject not found.");
  }

  return serializeSubjectCertificationSettings(subject);
}

async function listCertificationSubjects() {
  const subjects = await Subject.find({})
    .sort({ name: 1 })
    .lean();

  return subjects.map(serializeSubjectCertificationSettings);
}

async function subjectHasLiveCertificationEvidence(subjectId) {
  const [awardExists, missionExists] = await Promise.all([
    User.exists({
      "subjectCertificationAwards.subjectId": subjectId,
    }),
    Mission.exists({
      subjectId,
      latestResultPackageId: { $exists: true, $ne: null },
      draftFormat: { $in: QUALIFYING_DRAFT_FORMATS },
      "taskCodes.0": { $exists: true },
      "taskCodes.1": { $exists: false },
      $or: [{ status: "published" }, { status: { $exists: false } }],
    }),
  ]);

  return Boolean(awardExists || missionExists);
}

async function updateSubjectCertificationSettings({
  subjectId,
  payload,
}) {
  const subject = await Subject.findById(subjectId);
  if (!subject) {
    throw createError(404, "Subject not found.");
  }

  const normalizedTemplate = validateCertificationTemplateInput(payload);
  const isChangingTemplate =
    subject.certificationEnabled !== normalizedTemplate.certificationEnabled ||
    resolveCertificationLabel(subject.certificationLabel) !== normalizedTemplate.certificationLabel ||
    JSON.stringify(normalizeTaskCodes(subject.requiredCertificationTaskCodes)) !==
      JSON.stringify(normalizedTemplate.requiredCertificationTaskCodes);

  if (isChangingTemplate && subject.certificationEnabled === true) {
    const hasLiveEvidence = await subjectHasLiveCertificationEvidence(subjectId);
    if (hasLiveEvidence) {
      // WHY: Legacy subject templates cannot change once they have already
      // produced evidence, otherwise old certification data becomes ambiguous.
      throw createError(
        409,
        "Certification settings cannot be changed after live certification evidence exists for this subject.",
      );
    }
  }

  subject.certificationEnabled = normalizedTemplate.certificationEnabled;
  subject.requiredCertificationTaskCodes = normalizedTemplate.requiredCertificationTaskCodes;
  subject.certificationLabel = normalizedTemplate.certificationLabel;
  await subject.save();

  console.info("[certification] subject template updated", {
    subjectId: String(subjectId || ""),
    certificationEnabled: subject.certificationEnabled === true,
    requiredTaskCodes: subject.requiredCertificationTaskCodes,
  });

  return serializeSubjectCertificationSettings(subject.toObject());
}

module.exports = {
  CERTIFICATION_STATUS,
  PLAN_SOURCE,
  QUALIFYING_DRAFT_FORMATS,
  THEORY_PASS_PERCENT,
  buildMissionCertificationSnapshot,
  evaluateCertificationMission,
  getMissionCertificationSummary,
  getStudentCertificationSummaries,
  getStudentSubjectCertificationContext,
  getSubjectCertificationSettings,
  listCertificationSubjects,
  normalizeTaskCodes,
  serializePlanContext,
  serializeSubjectCertificationSettings,
  subjectHasLiveCertificationEvidence,
  updateSubjectCertificationSettings,
  updateTeacherStudentCertificationPlan,
};
