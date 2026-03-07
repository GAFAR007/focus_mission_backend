/**
 * WHAT:
 * subjectCertification.service derives subject-level task-focus certification
 * progress from qualifying mission evidence and applies certificate awards.
 * WHY:
 * Certification must stay parallel to the frozen criterion journey while still
 * giving students and staff an auditable view of which task-focus codes have
 * been passed for a subject.
 * HOW:
 * Read subject certification templates, evaluate qualifying mission/result
 * evidence against fixed rules, summarize passed/remaining task codes, and
 * write one idempotent certification award when all required codes are passed.
 */
const Mission = require("../models/Mission");
const ResultPackage = require("../models/ResultPackage");
const Subject = require("../models/Subject");
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

function resolveCertificationLabel(subject) {
  const label = String(subject?.certificationLabel || "").trim();
  return label || "Course Certification";
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
    certificationLabel: resolveCertificationLabel(subject),
  };
}

function validateCertificationTemplateInput(payload) {
  const certificationEnabled = payload?.certificationEnabled === true;
  const rawTaskCodes = Array.isArray(payload?.requiredCertificationTaskCodes) ?
    payload.requiredCertificationTaskCodes
  : [];
  const requiredCertificationTaskCodes = normalizeTaskCodes(
    rawTaskCodes,
  );
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

function evaluateCertificationMission({
  mission,
  resultPackage,
  subject,
}) {
  const subjectSettings = serializeSubjectCertificationSettings(subject);
  const requiredTaskCodes = subjectSettings.requiredCertificationTaskCodes;
  const normalizedTaskCodes = normalizeTaskCodes(mission?.taskCodes);
  const draftFormat = String(mission?.draftFormat || "QUESTIONS")
    .trim()
    .toUpperCase();
  const questionCount = Array.isArray(mission?.questions) ? mission.questions.length : 0;
  const completedAt = resolveMissionCompletionTime(mission, resultPackage);
  const baseResponse = {
    certificationEnabled: subjectSettings.certificationEnabled,
    certificationLabel: subjectSettings.certificationLabel,
    requiredTaskCodes,
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

  if (!subjectSettings.certificationEnabled) {
    return {
      ...baseResponse,
      reason: "This subject does not use task-focus certification.",
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
      reason: "This task focus is not required for the subject certification.",
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
      mission?.latestScoreCorrect ??
        resultPackage?.meta?.score?.correct ??
        0,
    ),
  );
  const scorePercent = Math.max(
    0,
    Math.min(
      100,
      Number(
        mission?.latestScorePercent ??
          resultPackage?.meta?.score?.percent ??
          0,
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
  subject,
  evaluations,
  awardRecorded = false,
}) {
  const subjectSettings = serializeSubjectCertificationSettings(subject);
  const requiredTaskCodes = subjectSettings.requiredCertificationTaskCodes;
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
    subjectId: String(subject?._id || subject?.id || ""),
    subjectName: String(subject?.name || ""),
    subjectIcon: String(subject?.icon || ""),
    subjectColor: String(subject?.color || ""),
    certificationEnabled: subjectSettings.certificationEnabled,
    certificationLabel: subjectSettings.certificationLabel,
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
  };
}

async function loadStudentCertificationContext({
  studentId,
  subjectId = "",
}) {
  const subjectMatch = { certificationEnabled: true };
  if (String(subjectId || "").trim()) {
    subjectMatch._id = subjectId;
  }

  const [student, subjects] = await Promise.all([
    User.findById(studentId)
      .select("subjectCertificationAwards")
      .lean(),
    Subject.find(subjectMatch)
      .sort({ name: 1 })
      .lean(),
  ]);

  const subjectIds = subjects.map((subject) => subject._id);
  const missions = subjectIds.length > 0 ?
    await Mission.find({
      studentId,
      subjectId: { $in: subjectIds },
      latestResultPackageId: { $exists: true, $ne: null },
      $or: [{ status: "published" }, { status: { $exists: false } }],
    }).lean()
  : [];
  const resultPackageIds = missions
    .map((mission) => String(mission?.latestResultPackageId || ""))
    .filter(Boolean);
  const resultPackages = resultPackageIds.length > 0 ?
    await ResultPackage.find({
      _id: { $in: resultPackageIds },
    })
      .select("missionId missionType meta evidence createdAt")
      .lean()
  : [];

  return {
    student,
    subjects,
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
  const learner =
    await User.findById(studentId).select("subjectCertificationAwards");

  if (!learner) {
    return new Set();
  }

  if (!Array.isArray(learner.subjectCertificationAwards)) {
    learner.subjectCertificationAwards = [];
  }

  const existingSubjectIds = new Set(
    learner.subjectCertificationAwards.map((award) => String(award.subjectId || "")),
  );
  let changed = false;

  for (const summary of summaries) {
    const subjectId = String(summary?.subjectId || "");
    if (!subjectId || summary?.certificateUnlocked !== true || existingSubjectIds.has(subjectId)) {
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
    existingSubjectIds.add(subjectId);
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

  return existingSubjectIds;
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
  const existingAwardSubjectIds = new Set(
    (context.student?.subjectCertificationAwards || []).map((award) =>
      String(award.subjectId || ""),
    ),
  );

  const summaries = context.subjects.map((subject) => {
    const subjectIdKey = String(subject._id || "");
    const evaluations = context.missions
      .filter((mission) => String(mission?.subjectId || "") === subjectIdKey)
      .map((mission) =>
        evaluateCertificationMission({
          mission,
          resultPackage: context.resultPackageById.get(String(mission?.latestResultPackageId || "")) || null,
          subject,
        }),
      );

    return buildSubjectCertificationSummary({
      subject,
      evaluations,
      awardRecorded: existingAwardSubjectIds.has(subjectIdKey),
    });
  });

  let finalAwardSubjectIds = existingAwardSubjectIds;
  if (applyAwards) {
    finalAwardSubjectIds = await syncCertificationAwards({
      studentId,
      summaries,
    });
  }

  const finalizedSummaries = summaries.map((summary) => ({
    ...summary,
    awardRecorded: finalAwardSubjectIds.has(String(summary.subjectId || "")),
  }));

  console.info("[certification] summary complete", {
    studentId: String(studentId || ""),
    subjectCount: finalizedSummaries.length,
  });

  return finalizedSummaries;
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
    };
  }

  const evaluation = evaluateCertificationMission({
    mission,
    resultPackage,
    subject: subjectRecord,
  });

  return {
    certificationEnabled: subjectRecord.certificationEnabled === true,
    certificationLabel: resolveCertificationLabel(subjectRecord),
    requiredTaskCodes: normalizeTaskCodes(subjectRecord.requiredCertificationTaskCodes),
    certificationEligible: evaluation.certificationEligible,
    certificationTaskCode: evaluation.certificationTaskCode,
    certificationCounted: evaluation.certificationCounted,
    certificationPassStatus: evaluation.certificationPassStatus,
    reason: evaluation.reason,
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
    resolveCertificationLabel(subject) !== normalizedTemplate.certificationLabel ||
    JSON.stringify(normalizeTaskCodes(subject.requiredCertificationTaskCodes)) !==
      JSON.stringify(normalizedTemplate.requiredCertificationTaskCodes);

  if (isChangingTemplate && subject.certificationEnabled === true) {
    const hasLiveEvidence = await subjectHasLiveCertificationEvidence(subjectId);
    if (hasLiveEvidence) {
      // WHY: Certification rules cannot change after live evidence exists,
      // otherwise previously earned passes could become ambiguous and unauditable.
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
  QUALIFYING_DRAFT_FORMATS,
  THEORY_PASS_PERCENT,
  evaluateCertificationMission,
  getMissionCertificationSummary,
  getStudentCertificationSummaries,
  getSubjectCertificationSettings,
  listCertificationSubjects,
  normalizeTaskCodes,
  serializeSubjectCertificationSettings,
  subjectHasLiveCertificationEvidence,
  updateSubjectCertificationSettings,
};
