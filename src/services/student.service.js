/**
 * WHAT:
 * student.service assembles dashboard and timetable data, starts subject
 * missions, and records completed mission sessions.
 * WHY:
 * Student lesson access must be tied to the timetable and XP rules so learners
 * only see subject work that is valid for the current lesson slot.
 * HOW:
 * Load the active student and timetable context, resolve the correct mission
 * for the scheduled slot, and persist completed session outcomes.
 */
const Mission = require("../models/Mission");
const Question = require("../models/Question");
const ResultPackage = require("../models/ResultPackage");
const SessionLog = require("../models/SessionLog");
const Subject = require("../models/Subject");
const Target = require("../models/Target");
const Timetable = require("../models/Timetable");
const User = require("../models/User");
const resultService = require("./result.service");
const standalonePaperSessionService = require("./standalonePaperSession.service");
const subjectCertificationService = require("./subjectCertification.service");
const {
  buildQuestionBankMission,
  serializeMission,
} = require("../utils/missionSerializer");
const {
  calculateRequiredCorrectAnswers,
} = require("../utils/missionPassPolicy");
const { serializeJourney } = require("../utils/userJourney");
const {
  ASSESSMENT_MAX_XP,
  ATTENDANCE_XP,
  DAILY_CHALLENGE_MAX_XP,
  PERFORMANCE_DAILY_CAP,
  STREAK_BADGE_UNLOCK_DAYS,
  STREAK_CONTINUE_THRESHOLD,
  SUBJECT_COMPLETION_BONUS_XP,
  TARGET_DAILY_CAP,
  TARGET_TYPE_FIXED_ASSESSMENT,
  TARGET_TYPE_FIXED_DAILY_MISSION,
  TARGET_WEEKLY_CAP,
  calculateAssessmentXp,
  calculateChallengeXp,
  calculateCompletionPercentage,
  calculatePerformanceXpBeforeStreak,
  calculatePerformanceXpWithStreak,
  clampNumber,
  getCalendarDayDifference,
  getDateKey,
  getNow,
  getWeekKey,
  isAssessmentQuestionCount,
  resolveDailyLoginXp,
  resolveMissionRewardPolicy,
} = require("../utils/xpPolicy");

function createError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function assertStudentSelfAccess({
  requesterId,
  studentId,
}) {
  // WHY: Student reporting endpoints must stay self-serve only so one learner
  // cannot browse another learner's certification or mission evidence.
  if (String(requesterId || "") === String(studentId || "")) {
    return;
  }

  throw createError(
    403,
    "You can only view your own student progress.",
  );
}

function toIsoStringOrNull(value) {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function buildDefaultSubjectCertificationSummary(subject) {
  return {
    subjectId: String(subject?._id || subject?.id || ""),
    subjectName: String(subject?.name || ""),
    subjectIcon: String(subject?.icon || ""),
    subjectColor: String(subject?.color || ""),
    certificationEnabled: false,
    certificationLabel: String(subject?.certificationLabel || "Course Certification"),
    requiredTaskCodes: [],
    passedTaskCodes: [],
    remainingTaskCodes: [],
    completionPercentage: 0,
    averagePassedScorePercent: 0,
    certificateUnlocked: false,
    awardRecorded: false,
    evidenceRows: [],
  };
}

function buildMissionHistoryStatusLabel({
  missionType,
  resultPackage,
  certificationSummary,
}) {
  if (missionType === "THEORY") {
    const reviewStatus = String(resultPackage?.evidence?.reviewStatus || "")
      .trim()
      .toLowerCase();
    if (reviewStatus !== "scored") {
      return "Pending review";
    }
    return certificationSummary?.certificationPassStatus === "passed" ?
      "Passed"
    : "Not passed";
  }

  return "Passed";
}

function buildStudentMissionHistoryItem({
  mission,
  resultPackage,
  certificationSummary,
}) {
  const missionType = String(
    resultPackage?.missionType || mission?.draftFormat || "QUESTIONS",
  )
    .trim()
    .toUpperCase();
  const theoryAverage = Number(
    resultPackage?.evidence?.averageTeacherScorePercent || 0,
  );
  const scorePercent = missionType === "THEORY" ?
    Math.round(theoryAverage)
  : Math.max(
      0,
      Number(
        resultPackage?.meta?.score?.percent ||
          mission?.latestScorePercent ||
          0,
      ),
    );

  return {
    missionId: String(mission?._id || mission?.id || resultPackage?.missionId || ""),
    resultPackageId: String(resultPackage?._id || resultPackage?.id || ""),
    title: String(
      mission?.title ||
        resultPackage?.meta?.missionTitle ||
        "Mission",
    ).trim(),
    missionType,
    taskCodes: Array.isArray(mission?.taskCodes) ? mission.taskCodes : [],
    assignedDate: String(
      resultPackage?.meta?.assignedDate ||
        mission?.availableOnDate ||
        "",
    ).trim(),
    submittedAt: toIsoStringOrNull(
      resultPackage?.meta?.submitTime ||
        resultPackage?.createdAt,
    ),
    scorePercent,
    xpAwarded: Math.max(
      0,
      Number(resultPackage?.meta?.xpAwarded || 0),
    ),
    certificationEligible: certificationSummary?.certificationEligible === true,
    certificationCounted: certificationSummary?.certificationCounted === true,
    certificationPassStatus: String(
      certificationSummary?.certificationPassStatus || "not_eligible",
    ),
    statusLabel: buildMissionHistoryStatusLabel({
      missionType,
      resultPackage,
      certificationSummary,
    }),
  };
}

function getCurrentDay() {
  return new Intl.DateTimeFormat("en-US", { weekday: "long" }).format(getNow());
}

function getCurrentDateKey() {
  return getDateKey(getNow());
}

function parseOverrideDateKey(dateKey) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey || "").trim());

  if (!match) {
    return null;
  }

  const [, year, month, day] = match;
  // WHY: Use midday for the temporary test override so local timezone
  // formatting cannot push the simulated student date backward or forward.
  const parsed = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    12,
    0,
    0,
    0,
  );

  if (
    parsed.getFullYear() !== Number(year) ||
    parsed.getMonth() !== Number(month) - 1 ||
    parsed.getDate() !== Number(day)
  ) {
    return null;
  }

  return parsed;
}

function resolveStudentOverrideDate(studentId) {
  const enabled =
    String(process.env.FOCUS_TEST_DATE_OVERRIDE_ENABLED || "")
      .trim()
      .toLowerCase() === "true";
  const overrideStudentId = String(
    process.env.FOCUS_TEST_DATE_OVERRIDE_STUDENT_ID || "",
  ).trim();
  const overrideDateKey = String(
    process.env.FOCUS_TEST_DATE_OVERRIDE_DATE || "",
  ).trim();

  if (!enabled || !overrideStudentId || !overrideDateKey) {
    return null;
  }

  if (String(studentId || "").trim() !== overrideStudentId) {
    return null;
  }

  return parseOverrideDateKey(overrideDateKey);
}

function getEffectiveNowForStudent(studentId) {
  // WHY: A John-only date override lets production test one scheduled mission
  // end to end without shifting the real classroom date for everyone else.
  return resolveStudentOverrideDate(studentId) || getNow();
}

function getCurrentDayForStudent(studentId) {
  return new Intl.DateTimeFormat("en-US", { weekday: "long" }).format(
    getEffectiveNowForStudent(studentId),
  );
}

function getCurrentDateKeyForStudent(studentId) {
  return getDateKey(getEffectiveNowForStudent(studentId));
}

const WEEKDAY_ORDER = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
];

const WEEKDAY_LOOKUP = {
  mon: "Monday",
  monday: "Monday",
  tue: "Tuesday",
  tues: "Tuesday",
  tuesday: "Tuesday",
  wed: "Wednesday",
  weds: "Wednesday",
  wednesday: "Wednesday",
  thu: "Thursday",
  thur: "Thursday",
  thurs: "Thursday",
  thursday: "Thursday",
  fri: "Friday",
  friday: "Friday",
  sat: "Saturday",
  saturday: "Saturday",
  sun: "Sunday",
  sunday: "Sunday",
};
const ESSAY_SUBMISSION_MIN_WORDS = 100;

function countWords(value) {
  return String(value || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

function buildTheoryResponseMap(theoryResponses) {
  const responsesByIndex = new Map();
  for (const response of Array.isArray(theoryResponses) ? theoryResponses : []) {
    const questionIndex = Number(response?.questionIndex);
    const answerText = String(response?.answerText || "").trim();
    const suppliedWordCount = Number(response?.wordCount);
    if (!Number.isInteger(questionIndex) || questionIndex < 0) {
      continue;
    }
    responsesByIndex.set(questionIndex, {
      answerText,
      wordCount: Number.isInteger(suppliedWordCount)
        ? suppliedWordCount
        : countWords(answerText),
    });
  }
  return responsesByIndex;
}

function normalizeWeekday(day) {
  const normalized = String(day || "")
    .trim()
    .toLowerCase()
    .replace(/\./g, "");
  return WEEKDAY_LOOKUP[normalized] || "";
}

function getWeekdayCandidates(day) {
  const canonical = normalizeWeekday(day);
  if (!canonical) {
    return [String(day || "").trim()].filter(Boolean);
  }

  const lower = canonical.toLowerCase();
  const short = canonical.slice(0, 3);
  const candidates = new Set([
    canonical,
    lower,
    short,
    short.toLowerCase(),
    `${short}.`,
    `${short.toLowerCase()}.`,
  ]);
  return Array.from(candidates);
}

function getWeekdaySortIndex(day) {
  return WEEKDAY_ORDER.indexOf(normalizeWeekday(day));
}

async function findTimetableForDay({ studentId, day, populate = false }) {
  const dayCandidates = getWeekdayCandidates(day);
  let dayQuery = Timetable.find({
    studentId,
    day: { $in: dayCandidates },
  });

  if (populate) {
    dayQuery = dayQuery
      .populate("morningSubject")
      .populate("afternoonSubject")
      .populate("morningTeacherId", "name email avatar")
      .populate("afternoonTeacherId", "name email avatar");
  }

  const exactOrAliasMatch = await dayQuery.lean();
  if (exactOrAliasMatch.length > 0) {
    return exactOrAliasMatch[0];
  }

  // WHY: Older seed data can store weekday names in inconsistent formats.
  // Normalized fallback keeps dashboard/session access deterministic in tests.
  let fallbackQuery = Timetable.find({ studentId });
  if (populate) {
    fallbackQuery = fallbackQuery
      .populate("morningSubject")
      .populate("afternoonSubject")
      .populate("morningTeacherId", "name email avatar")
      .populate("afternoonTeacherId", "name email avatar");
  }
  const allEntries = await fallbackQuery.lean();
  const normalizedTarget = normalizeWeekday(day);
  return (
    allEntries.find(
      (entry) => normalizeWeekday(entry.day) === normalizedTarget,
    ) || null
  );
}

function serializeTimetableEntry(timetable) {
  return {
    day: timetable.day,
    room: timetable.room,
    morningMission: timetable.morningSubject,
    afternoonMission: timetable.afternoonSubject,
    morningTeacher: timetable.morningTeacherId || null,
    afternoonTeacher: timetable.afternoonTeacherId || null,
  };
}

function serializeStudent(student) {
  return {
    id: String(student._id),
    name: student.name,
    avatar: student.avatar,
    avatarSeed: student.avatarSeed,
    yearGroup: String(student.yearGroup || ""),
    xp: student.xp,
    streak: student.streak,
    streakBadgeUnlocked: Boolean(student.streakBadgeUnlocked),
    ...serializeJourney(student),
    preferredDifficulty: student.preferredDifficulty,
  };
}

function summarizeDailyPerformance({
  student,
  dateKey,
  sessionLogs,
}) {
  const safeSessionLogs = Array.isArray(sessionLogs) ? sessionLogs : [];
  const legacyAttendanceXp = clampNumber(
    safeSessionLogs.some((session) => Number(session.attendanceXpAwarded || 0) > 0)
      ? ATTENDANCE_XP
      : 0,
    0,
    ATTENDANCE_XP,
  );
  const dailyLoginXp = clampNumber(
    resolveDailyLoginXp({ student, dateKey }),
    0,
    ATTENDANCE_XP,
  );
  const attendanceXp = clampNumber(
    Math.max(dailyLoginXp, legacyAttendanceXp),
    0,
    ATTENDANCE_XP,
  );
  const challengeXp = clampNumber(
    safeSessionLogs.reduce(
      (sum, session) => sum + Number(session.challengeXpAwarded || 0),
      0,
    ),
    0,
    DAILY_CHALLENGE_MAX_XP,
  );
  const assessmentXp = clampNumber(
    safeSessionLogs.reduce(
      (sum, session) => sum + Number(session.assessmentXpAwarded || 0),
      0,
    ),
    0,
    ASSESSMENT_MAX_XP,
  );
  const performanceXpBeforeStreak = calculatePerformanceXpBeforeStreak({
    attendanceXp,
    challengeXp,
    assessmentXp,
  });
  const performanceXpFinal = clampNumber(
    Math.max(
      attendanceXp,
      safeSessionLogs.reduce((maxValue, session) => {
        const cumulative = Number(
          session.performanceXpCumulative ||
            session.performanceXpAwarded ||
            session.xpAwarded ||
            0,
        );
        return Math.max(maxValue, cumulative);
      }, 0),
    ),
    0,
    PERFORMANCE_DAILY_CAP,
  );

  return {
    dailyLoginXp,
    attendanceXp,
    challengeXp,
    assessmentXp,
    performanceXpBeforeStreak,
    performanceXpFinal,
    // WHY: Daily login XP now contributes before any lesson is started, so the
    // awarded-so-far value should mirror the full current performance total.
    performanceXpAwarded: performanceXpFinal,
    subjectCompletionBonusXp: Math.max(
      0,
      safeSessionLogs.reduce(
        (sum, session) => sum + Number(session.subjectCompletionBonusXp || 0),
        0,
      ),
    ),
  };
}

function resolveNextStreakState({
  student,
  dateKey,
  nextPerformanceXpBeforeStreak,
}) {
  const qualified = nextPerformanceXpBeforeStreak >= STREAK_CONTINUE_THRESHOLD;
  const previousStreak = Number(student.streak || 0);
  const previousPerformanceDateKey = String(
    student.lastPerformanceDateKey || "",
  ).trim();

  if (!qualified) {
    return {
      nextStreak: 0,
      nextLastPerformanceDateKey: previousPerformanceDateKey,
      streakBadgeUnlocked: Boolean(student.streakBadgeUnlocked),
    };
  }

  let nextStreak = 1;

  if (previousPerformanceDateKey) {
    const dayDifference = getCalendarDayDifference(dateKey, previousPerformanceDateKey);
    if (dayDifference === 1) {
      nextStreak = previousStreak + 1;
    } else if (dayDifference === 0) {
      // WHY: Multiple sessions can complete in one day; the streak count should
      // not inflate repeatedly for the same date key.
      nextStreak = Math.max(previousStreak, 1);
    }
  }

  return {
    nextStreak,
    nextLastPerformanceDateKey: dateKey,
    streakBadgeUnlocked:
      Boolean(student.streakBadgeUnlocked) || nextStreak >= STREAK_BADGE_UNLOCK_DAYS,
  };
}

async function ensureWeeklyFixedTargets(studentId, dateKey) {
  const weekKey = getWeekKey(dateKey);
  const existingFixedTargets = await Target.find({
    studentId,
    weekKey,
    targetType: {
      $in: [TARGET_TYPE_FIXED_DAILY_MISSION, TARGET_TYPE_FIXED_ASSESSMENT],
    },
  })
    .select("targetType")
    .lean();
  const existingTypes = new Set(
    existingFixedTargets.map((target) => String(target.targetType || "")),
  );
  const toCreate = [];

  if (!existingTypes.has(TARGET_TYPE_FIXED_DAILY_MISSION)) {
    toCreate.push({
      studentId,
      title: "Finish 1 Daily Mission",
      description: "Complete one daily mission this week.",
      status: "pending",
      difficulty: "medium",
      weekKey,
      awardDateKey: dateKey,
      targetType: TARGET_TYPE_FIXED_DAILY_MISSION,
      stars: 0,
      xpAwarded: 0,
    });
  }

  if (!existingTypes.has(TARGET_TYPE_FIXED_ASSESSMENT)) {
    toCreate.push({
      studentId,
      title: "Finish 1 Assessment",
      description: "Complete one assessment mission this week.",
      status: "pending",
      difficulty: "hard",
      weekKey,
      awardDateKey: dateKey,
      targetType: TARGET_TYPE_FIXED_ASSESSMENT,
      stars: 0,
      xpAwarded: 0,
    });
  }

  if (toCreate.length > 0) {
    await Target.create(toCreate);
  }
}

async function getTargetXpSummary(studentId, dateKey) {
  const weekKey = getWeekKey(dateKey);
  const weeklyTargets = await Target.find({ studentId, weekKey }).lean();
  const dailyTargetXp = clampNumber(
    weeklyTargets
      .filter((target) => String(target.awardDateKey || "") === dateKey)
      .reduce((sum, target) => sum + Number(target.xpAwarded || 0), 0),
    0,
    TARGET_DAILY_CAP,
  );
  const weeklyTargetXp = clampNumber(
    weeklyTargets.reduce((sum, target) => sum + Number(target.xpAwarded || 0), 0),
    0,
    TARGET_WEEKLY_CAP,
  );

  return {
    dailyTargetXp,
    weeklyTargetXp,
    weekKey,
  };
}

async function getSubjectProgressData(studentId) {
  const missions = await Mission.find({
    studentId,
    manualResultOnly: { $ne: true },
    $or: [{ status: "published" }, { status: { $exists: false } }],
  })
    .populate("subjectId", "name icon color")
    .lean();
  const subjectMap = new Map();

  for (const mission of missions) {
    const totalQuestions = Array.isArray(mission.questions)
      ? mission.questions.length
      : 0;

    if (!isAssessmentQuestionCount(totalQuestions)) {
      continue;
    }

    const subject = mission.subjectId;
    const subjectId = subject && typeof subject === "object"
      ? String(subject._id || "")
      : String(mission.subjectId || "");

    if (!subjectId) {
      continue;
    }

    const existing = subjectMap.get(subjectId) || {
      subjectId,
      subjectName:
        subject && typeof subject === "object" ? String(subject.name || "") : "",
      subjectIcon:
        subject && typeof subject === "object" ? String(subject.icon || "") : "",
      subjectColor:
        subject && typeof subject === "object" ? String(subject.color || "") : "",
      totalAssessments: 0,
      completedAssessments: 0,
      averageScore: 0,
      completionPercentage: 0,
      _scoreSum: 0,
    };

    existing.totalAssessments += 1;
    const hasScore = Number(mission.latestScoreTotal || 0) > 0;
    if (hasScore) {
      existing.completedAssessments += 1;
      existing._scoreSum += clampNumber(mission.latestScorePercent, 0, 100);
    }

    subjectMap.set(subjectId, existing);
  }

  const subjectProgress = Array.from(subjectMap.values())
    .map((entry) => {
      const averageScore = entry.completedAssessments
        ? Math.round(entry._scoreSum / entry.completedAssessments)
        : 0;
      return {
        subjectId: entry.subjectId,
        subjectName: entry.subjectName,
        subjectIcon: entry.subjectIcon,
        subjectColor: entry.subjectColor,
        totalAssessments: entry.totalAssessments,
        completedAssessments: entry.completedAssessments,
        averageScore,
        completionPercentage: calculateCompletionPercentage({
          completedCount: entry.completedAssessments,
          totalCount: entry.totalAssessments,
        }),
      };
    })
    .sort((left, right) => left.subjectName.localeCompare(right.subjectName));

  return {
    subjectProgress,
    subjectProgressById: new Map(
      subjectProgress.map((entry) => [String(entry.subjectId), entry]),
    ),
  };
}

function applySubjectAwardFlags(subjectProgress, student) {
  const awardedSubjectIds = new Set(
    (student.subjectCompletionAwards || []).map((award) =>
      String(award.subjectId || ""),
    ),
  );

  return subjectProgress.map((entry) => ({
    ...entry,
    badgeUnlocked: awardedSubjectIds.has(String(entry.subjectId)),
  }));
}

async function getSubjectReport({
  requesterId,
  studentId,
  subjectId,
}) {
  assertStudentSelfAccess({
    requesterId,
    studentId,
  });

  const [student, subject] = await Promise.all([
    User.findOne({ _id: studentId, role: "student" })
      .select("subjectCompletionAwards")
      .lean(),
    Subject.findById(subjectId).lean(),
  ]);

  if (!student) {
    throw createError(404, "Student not found.");
  }

  if (!subject) {
    throw createError(404, "Subject not found.");
  }

  const [subjectProgressResult, certificationSummaries, resultPackages] = await Promise.all([
    getSubjectProgressData(studentId),
    subjectCertificationService.getStudentCertificationSummaries({
      studentId,
      subjectId,
      applyAwards: false,
    }),
    ResultPackage.find({
      studentId,
      subjectId,
    })
      .sort({ createdAt: -1 })
      .lean(),
  ]);

  const subjectProgress = applySubjectAwardFlags(
    subjectProgressResult.subjectProgress,
    student,
  ).find((entry) => String(entry?.subjectId || "") === String(subjectId)) || null;
  const certification =
    certificationSummaries[0] || buildDefaultSubjectCertificationSummary(subject);

  const missionIds = resultPackages
    .map((resultPackage) => String(resultPackage?.missionId || ""))
    .filter(Boolean);
  const missions = missionIds.length > 0 ?
    await Mission.find({
      _id: { $in: missionIds },
      studentId,
      subjectId,
    }).lean()
  : [];
  const missionById = new Map(
    missions.map((mission) => [String(mission?._id || ""), mission]),
  );

  const missionHistory = await Promise.all(
    resultPackages.map(async (resultPackage) => {
      const mission = missionById.get(String(resultPackage?.missionId || "")) || null;
      const certificationSummary = mission ?
        await subjectCertificationService.getMissionCertificationSummary({
          mission,
          resultPackage,
          subject,
        })
      : {
          certificationEligible: false,
          certificationCounted: false,
          certificationPassStatus: "not_eligible",
        };

      return buildStudentMissionHistoryItem({
        mission,
        resultPackage,
        certificationSummary,
      });
    }),
  );

  // WHY: History should only show completed subject evidence, so it is built
  // from stored result packages rather than draft/published mission records.
  return {
    subject: {
      id: String(subject?._id || ""),
      name: String(subject?.name || ""),
      icon: String(subject?.icon || ""),
      color: String(subject?.color || ""),
    },
    assessmentProgress: subjectProgress,
    certification,
    missionHistory,
  };
}

async function getStudentResultReport({
  requesterId,
  resultPackageId,
}) {
  const resultPackage = await ResultPackage.findById(resultPackageId)
    .select("studentId")
    .lean();
  if (!resultPackage) {
    throw createError(404, "Result package not found.");
  }

  assertStudentSelfAccess({
    requesterId,
    studentId: String(resultPackage.studentId || ""),
  });

  return resultService.getResultPackageForStudent({
    studentId: String(resultPackage.studentId || ""),
    resultPackageId,
  });
}

async function getDashboard(studentId) {
  const dateKey = getCurrentDateKeyForStudent(studentId);
  await ensureWeeklyFixedTargets(studentId, dateKey);

  const student = await User.findOne({ _id: studentId, role: "student" }).lean();

  if (!student) {
    throw createError(404, "Student not found.");
  }

  const timetable = await findTimetableForDay({
    studentId,
    day: getCurrentDayForStudent(studentId),
    populate: true,
  });

  const recentSessions = await SessionLog.find({ studentId })
    .sort({ createdAt: -1 })
    .limit(5)
    .populate("subjectId")
    .lean();
  const todaySessionLogs = await SessionLog.find({ studentId, dateKey }).lean();
  const [targetSummary, subjectProgressResult, subjectCertification] = await Promise.all([
    getTargetXpSummary(studentId, dateKey),
    getSubjectProgressData(studentId),
    subjectCertificationService.getStudentCertificationSummaries({
      studentId,
      applyAwards: true,
    }),
  ]);
  const todayStandalonePapers =
    await standalonePaperSessionService.listAvailableStandalonePapersForStudent({
      studentId,
      requesterId: studentId,
    });
  const dayPerformance = summarizeDailyPerformance({
    student,
    dateKey,
    sessionLogs: todaySessionLogs,
  });
  const totalDailyXp = clampNumber(
    dayPerformance.performanceXpFinal + targetSummary.dailyTargetXp,
    0,
    PERFORMANCE_DAILY_CAP + TARGET_DAILY_CAP,
  );

  return {
    student: serializeStudent(student),
    dailyXp: {
      dateKey,
      dailyLoginXp: dayPerformance.dailyLoginXp,
      attendanceXp: dayPerformance.attendanceXp,
      challengeXp: dayPerformance.challengeXp,
      assessmentXp: dayPerformance.assessmentXp,
      performanceXp: dayPerformance.performanceXpFinal,
      performanceXpAwarded: dayPerformance.performanceXpAwarded,
      subjectCompletionBonusXp: dayPerformance.subjectCompletionBonusXp,
      performanceXpCap: PERFORMANCE_DAILY_CAP,
      targetXp: targetSummary.dailyTargetXp,
      targetXpCap: TARGET_DAILY_CAP,
      weeklyTargetXp: targetSummary.weeklyTargetXp,
      weeklyTargetXpCap: TARGET_WEEKLY_CAP,
      totalXp: totalDailyXp,
      totalXpCap: PERFORMANCE_DAILY_CAP + TARGET_DAILY_CAP,
      weekKey: targetSummary.weekKey,
    },
    subjectProgress: applySubjectAwardFlags(
      subjectProgressResult.subjectProgress,
      student,
    ),
    subjectCertification,
    today: timetable ? serializeTimetableEntry(timetable) : null,
    todayStandalonePapers,
    recentSessions,
  };
}

async function getTimetable(studentId) {
  const timetable = await Timetable.find({ studentId })
    .populate("morningSubject")
    .populate("afternoonSubject")
    .populate("morningTeacherId", "name email avatar")
    .populate("afternoonTeacherId", "name email avatar")
    .lean();

  return timetable
    .sort(
      (left, right) =>
        getWeekdaySortIndex(left.day) - getWeekdaySortIndex(right.day),
    )
    .map(serializeTimetableEntry);
}

async function startSession({ studentId, subjectId, sessionType, missionId }) {
  const currentDay = getCurrentDayForStudent(studentId);
  const currentDateKey = getCurrentDateKeyForStudent(studentId);
  const [student, subject, timetable] = await Promise.all([
    User.findOne({ _id: studentId, role: "student" }).lean(),
    Subject.findById(subjectId).lean(),
    findTimetableForDay({ studentId, day: currentDay }),
  ]);

  if (!student) {
    throw createError(404, "Student not found.");
  }

  if (!subject) {
    throw createError(404, "Subject not found.");
  }

  if (!timetable) {
    // WHY: Students should only start subject work when a real lesson is
    // scheduled, otherwise the timetable loses its control over daily access.
    throw createError(403, "No lesson is scheduled for this student today.");
  }

  const scheduledSubjectId =
    sessionType === "morning" ? timetable.morningSubject : timetable.afternoonSubject;

  if (!scheduledSubjectId || String(scheduledSubjectId) !== String(subjectId)) {
    // WHY: Mission availability is locked to the real lesson slot so subject
    // teachers control when their work becomes visible to the learner.
    throw createError(
      403,
      "This mission can only be started on the day and lesson slot when that subject is scheduled.",
    );
  }

  const missionFilter = {
    studentId,
    subjectId,
    sessionType,
    availableOnDate: currentDateKey,
    manualResultOnly: { $ne: true },
    $or: [{ status: "published" }, { status: { $exists: false } }],
  };
  const requestedMissionId = String(missionId || "").trim();
  if (requestedMissionId) {
    missionFilter._id = requestedMissionId;
  }

  const [savedMission, bankQuestions] = await Promise.all([
    Mission.findOne(missionFilter)
      .sort({ publishedAt: -1, createdAt: -1 })
      .populate("subjectId", "name icon color")
      .lean(),
    Question.find({ subjectId }).sort({ createdAt: -1 }).limit(5).lean(),
  ]);

  const mission = savedMission
    ? serializeMission(savedMission)
    : buildQuestionBankMission({
        subject,
        sessionType,
        difficulty: student.preferredDifficulty || "medium",
        questions: bankQuestions,
      });

  return {
    startedAt: new Date().toISOString(),
    studentId,
    subjectId,
    sessionType,
    maxQuestions: mission.questionCount,
    mission,
  };
}

async function listAssignedMissions({
  requesterId,
  requesterRole,
  studentId,
  subjectId,
  sessionType,
}) {
  if (
    requesterRole === "student" &&
    String(requesterId) !== String(studentId)
  ) {
    throw createError(403, "You can only view your own assigned missions.");
  }

  const currentDay = getCurrentDayForStudent(studentId);
  const currentDateKey = getCurrentDateKeyForStudent(studentId);
  const [student, subject, timetable] = await Promise.all([
    User.findOne({ _id: studentId, role: "student" }).lean(),
    Subject.findById(subjectId).lean(),
    findTimetableForDay({ studentId, day: currentDay }),
  ]);

  if (!student) {
    throw createError(404, "Student not found.");
  }

  if (!subject) {
    throw createError(404, "Subject not found.");
  }

  if (!timetable) {
    throw createError(403, "No lesson is scheduled for this student today.");
  }

  const scheduledSubjectId =
    sessionType === "morning" ? timetable.morningSubject : timetable.afternoonSubject;

  if (!scheduledSubjectId || String(scheduledSubjectId) !== String(subjectId)) {
    throw createError(
      403,
      "This mission can only be started on the day and lesson slot when that subject is scheduled.",
    );
  }

  const missions = await Mission.find({
    studentId,
    subjectId,
    sessionType,
    availableOnDate: currentDateKey,
    manualResultOnly: { $ne: true },
    $or: [{ status: "published" }, { status: { $exists: false } }],
  })
    .sort({ publishedAt: -1, createdAt: -1 })
    .populate("subjectId", "name icon color")
    .lean();

  return missions.map((mission) => serializeMission(mission));
}

async function completeSession(payload) {
  const dateKey = getCurrentDateKeyForStudent(payload.studentId);
  await ensureWeeklyFixedTargets(payload.studentId, dateKey);

  let xpAwarded = 0;
  let completedQuestions = Number.isFinite(Number(payload.completedQuestions))
    ? Number(payload.completedQuestions)
    : 0;
  let correctAnswers = Number.isFinite(Number(payload.correctAnswers))
    ? Number(payload.correctAnswers)
    : 0;
  let scorePercent = 0;
  let challengeXpForSession = 0;
  let assessmentXpForSession = 0;
  let missionQuestionCount = completedQuestions;
  let missionSubjectId = payload.subjectId;
  const missionId = String(payload.missionId || "").trim();
  let completedMission = null;
  let missionToPersist = null;
  let isEssayBuilderMission = false;
  let isTheoryMission = false;
  let theoryReviewPending = false;
  let resultPackageScoreCorrect = 0;
  let resultPackageScoreTotal = 0;

  if (missionId) {
    const mission = await Mission.findOne({
      _id: missionId,
      studentId: payload.studentId,
      subjectId: payload.subjectId,
      sessionType: payload.sessionType,
      manualResultOnly: { $ne: true },
      $or: [{ status: "published" }, { status: { $exists: false } }],
    }).populate("subjectId", "name");

    if (mission) {
      completedMission = mission;
      const isEssayBuilder = mission.draftFormat === "ESSAY_BUILDER";
      const isTheory = mission.draftFormat === "THEORY";
      isEssayBuilderMission = isEssayBuilder;
      isTheoryMission = isTheory;
      const totalQuestions = Array.isArray(mission.questions)
        ? mission.questions.length
        : 0;
      const rewardPolicy = resolveMissionRewardPolicy({
        draftFormat: mission.draftFormat,
        questionCount: totalQuestions,
      });
      missionSubjectId = String(mission.subjectId || payload.subjectId);

      if (isEssayBuilder) {
        // WHY: Essay builder missions are scored by completed sentences rather
        // than question correctness, so we honor the payload totals.
        missionQuestionCount = Math.max(0, completedQuestions);
        completedQuestions = missionQuestionCount;
        correctAnswers = Math.max(0, Math.min(correctAnswers, completedQuestions));
        scorePercent = completedQuestions > 0
          ? Math.round((correctAnswers / completedQuestions) * 100)
          : 0;
        challengeXpForSession = rewardPolicy.xpReward;
        xpAwarded = challengeXpForSession;
        resultPackageScoreCorrect = correctAnswers;
        resultPackageScoreTotal = missionQuestionCount;
      } else if (isTheory) {
        const theoryResponsesByIndex = buildTheoryResponseMap(
          payload?.resultEvidence?.theoryResponses,
        );

        missionQuestionCount = totalQuestions;
        completedQuestions = totalQuestions;

        for (let index = 0; index < totalQuestions; index += 1) {
          const response = theoryResponsesByIndex.get(index);
          const answerText = String(response?.answerText || "").trim();
          const answerWordCount = countWords(answerText);
          const minimumWords = Math.max(
            1,
            Number(mission?.questions?.[index]?.minWordCount || 0),
          );

          if (!answerText) {
            throw createError(
              422,
              `Theory question ${index + 1} needs a written answer before submission.`,
            );
          }

          if (answerWordCount < minimumWords) {
            // WHY: Theory responses must hit the teacher-set minimum words so
            // students cannot progress with placeholder fragments.
            throw createError(
              422,
              `Theory question ${index + 1} needs at least ${minimumWords} words before submission.`,
            );
          }
        }

        // WHY: Theory is a teacher-reviewed short-answer mission. Completion
        // stores evidence immediately, but XP remains pending until the
        // teacher finishes manual scoring.
        correctAnswers = 0;
        scorePercent = 0;
        challengeXpForSession = 0;
        assessmentXpForSession = 0;
        xpAwarded = 0;
        theoryReviewPending = true;
        resultPackageScoreCorrect = 0;
        resultPackageScoreTotal = 0;
      } else {
        missionQuestionCount = totalQuestions;
        completedQuestions = totalQuestions;
        correctAnswers = Math.max(0, Math.min(correctAnswers, totalQuestions));
        scorePercent = totalQuestions > 0
          ? Math.round((correctAnswers / totalQuestions) * 100)
          : 0;

        if (rewardPolicy.awardMode === "score_percent") {
          assessmentXpForSession = calculateAssessmentXp(scorePercent);
        } else {
          challengeXpForSession = rewardPolicy.xpReward;
        }
        xpAwarded = challengeXpForSession + assessmentXpForSession;
        resultPackageScoreCorrect = correctAnswers;
        resultPackageScoreTotal = missionQuestionCount;
      }

      missionToPersist = mission;
    }
  } else {
    completedQuestions = Math.max(0, completedQuestions);
    correctAnswers = Math.max(0, Math.min(correctAnswers, completedQuestions));
    missionQuestionCount = completedQuestions;
    scorePercent = completedQuestions > 0
      ? Math.round((correctAnswers / completedQuestions) * 100)
      : 0;

    const rewardPolicy = resolveMissionRewardPolicy({
      draftFormat: "QUESTIONS",
      questionCount: completedQuestions,
    });
    if (rewardPolicy.awardMode === "score_percent") {
      assessmentXpForSession = calculateAssessmentXp(scorePercent);
    } else {
      challengeXpForSession = rewardPolicy.xpReward;
    }
    xpAwarded = challengeXpForSession + assessmentXpForSession;
    resultPackageScoreCorrect = correctAnswers;
    resultPackageScoreTotal = missionQuestionCount;
  }

  if (!isTheoryMission) {
    const requiredCorrectAnswers = calculateRequiredCorrectAnswers(
      missionQuestionCount,
    );
    if (
      requiredCorrectAnswers > 0 &&
      correctAnswers < requiredCorrectAnswers
    ) {
      // WHY: Submission must meet a minimum mastery bar so mission completion
      // reflects understanding for configured mission sizes; below-threshold
      // attempts stay in retry flow.
      throw createError(
        422,
        `You need at least ${requiredCorrectAnswers} correct answers out of ${missionQuestionCount} to submit. Please retry this mission.`,
      );
    }
  }

  if (isEssayBuilderMission) {
    if (
      missionQuestionCount > 0 &&
      correctAnswers < missionQuestionCount
    ) {
      // WHY: Essay builder is a guided sequence; final submission requires all
      // sentence checks correct before the free-write response is accepted.
      throw createError(
        422,
        "Complete every guided sentence correctly before submitting your final essay response.",
      );
    }

    const submissionEssayText = String(
      payload?.resultEvidence
        ?.essayBuilder
        ?.finalEssayText ||
        payload?.resultEvidence
          ?.essayBuilder
          ?.submissionEssayText ||
        "",
    ).trim();
    const submissionWordCount =
      countWords(submissionEssayText);
    if (
      submissionWordCount <
      ESSAY_SUBMISSION_MIN_WORDS
    ) {
      // WHY: Essay submission requires a final written response to confirm
      // understanding beyond guided option selection.
      throw createError(
        422,
        `Write at least ${ESSAY_SUBMISSION_MIN_WORDS} words in the final essay response before submitting.`,
      );
    }
  }

  if (missionToPersist) {
    if (isTheoryMission) {
      // WHY: Pending theory reviews should not masquerade as auto-scored
      // completion, so the live mission snapshot stays neutral until teacher
      // scoring is finalized.
      missionToPersist.latestScoreCorrect = 0;
      missionToPersist.latestScoreTotal = 0;
      missionToPersist.latestScorePercent = 0;
      missionToPersist.latestXpEarned = 0;
    } else {
      missionToPersist.latestScoreCorrect = correctAnswers;
      missionToPersist.latestScoreTotal = missionQuestionCount;
      missionToPersist.latestScorePercent = scorePercent;
      missionToPersist.latestXpEarned = xpAwarded;
    }
    await missionToPersist.save();
  }

  const [student, todaySessionLogs] = await Promise.all([
    User.findOne({ _id: payload.studentId, role: "student" }),
    SessionLog.find({ studentId: payload.studentId, dateKey }).lean(),
  ]);

  if (!student) {
    throw createError(404, "Student not found.");
  }

  const dayPerformance = summarizeDailyPerformance({
    student,
    dateKey,
    sessionLogs: todaySessionLogs,
  });
  const attendanceXpForSession = 0;
  const nextAttendanceXp = clampNumber(dayPerformance.attendanceXp, 0, ATTENDANCE_XP);
  const nextChallengeXp = clampNumber(
    dayPerformance.challengeXp + challengeXpForSession,
    0,
    DAILY_CHALLENGE_MAX_XP,
  );
  const nextAssessmentXp = clampNumber(
    dayPerformance.assessmentXp + assessmentXpForSession,
    0,
    ASSESSMENT_MAX_XP,
  );
  const nextPerformanceXpBeforeStreak = calculatePerformanceXpBeforeStreak({
    attendanceXp: nextAttendanceXp,
    challengeXp: nextChallengeXp,
    assessmentXp: nextAssessmentXp,
  });
  const streakState = resolveNextStreakState({
    student,
    dateKey,
    nextPerformanceXpBeforeStreak,
  });
  const performanceWithStreak = calculatePerformanceXpWithStreak({
    attendanceXp: nextAttendanceXp,
    challengeXp: nextChallengeXp,
    assessmentXp: nextAssessmentXp,
    streakCount: streakState.nextStreak,
  });
  const nextPerformanceXpCumulative = performanceWithStreak.finalXp;
  const performanceXpAwarded = Math.max(
    0,
    nextPerformanceXpCumulative - dayPerformance.performanceXpFinal,
  );

  let subjectCompletionBonusXp = 0;
  const subjectIdForBonus = String(missionSubjectId || "").trim();
  if (subjectIdForBonus && isAssessmentQuestionCount(missionQuestionCount)) {
    const { subjectProgressById } = await getSubjectProgressData(payload.studentId);
    const subjectProgress = subjectProgressById.get(subjectIdForBonus);
    if (!Array.isArray(student.subjectCompletionAwards)) {
      student.subjectCompletionAwards = [];
    }
    const alreadyAwarded = (student.subjectCompletionAwards || []).some(
      (award) => String(award.subjectId || "") === subjectIdForBonus,
    );
    if (
      subjectProgress &&
      subjectProgress.totalAssessments > 0 &&
      subjectProgress.completionPercentage >= 100 &&
      !alreadyAwarded
    ) {
      // WHY: Subject completion bonus should fire once at full completion and
      // remain idempotent for qualification-safe reward history.
      student.subjectCompletionAwards.push({
        subjectId: subjectIdForBonus,
        awardedAt: new Date(),
        bonusXp: SUBJECT_COMPLETION_BONUS_XP,
      });
      subjectCompletionBonusXp = SUBJECT_COMPLETION_BONUS_XP;
    }
  }

  const totalXpAwarded = performanceXpAwarded + subjectCompletionBonusXp;

  const sessionLog = await SessionLog.create({
    studentId: payload.studentId,
    subjectId: payload.subjectId,
    missionId: missionId || null,
    dateKey,
    sessionType: payload.sessionType,
    focusScore: payload.focusScore || 0,
    completedQuestions,
    correctAnswers,
    scorePercent,
    missionQuestionCount,
    attendanceXpAwarded: attendanceXpForSession,
    challengeXpAwarded: challengeXpForSession,
    assessmentXpAwarded: assessmentXpForSession,
    performanceXpBeforeStreak: nextPerformanceXpBeforeStreak,
    performanceXpAwarded,
    performanceXpCumulative: nextPerformanceXpCumulative,
    streakMultiplierApplied: performanceWithStreak.multiplier,
    performanceQualifiedForStreak:
      nextPerformanceXpBeforeStreak >= STREAK_CONTINUE_THRESHOLD,
    targetXpAwarded: 0,
    subjectCompletionBonusXp,
    totalXpAwarded,
    behaviourStatus: payload.behaviourStatus || "steady",
    notes: payload.notes || "",
    xpAwarded: totalXpAwarded,
    createdBy: payload.createdBy || payload.studentId,
  });

  const resultPackage = await resultService.createResultPackageForCompletion({
    student,
    mission: completedMission,
    sessionLog,
    scoreCorrect: resultPackageScoreCorrect,
    scoreTotal: resultPackageScoreTotal,
    scorePercent: isTheoryMission ? 0 : scorePercent,
    xpAwarded: totalXpAwarded,
    startTime: payload.startTime,
    submitTime: payload.submitTime,
    resultEvidence: payload.resultEvidence,
  });

  // WHY: XP is applied only on explicit completion so rewards remain tied to
  // finished work and deterministic score rules.
  student.xp = Math.max(0, Number(student.xp || 0) + totalXpAwarded);
  student.streak = streakState.nextStreak;
  student.lastPerformanceDateKey = streakState.nextLastPerformanceDateKey;
  student.streakBadgeUnlocked = streakState.streakBadgeUnlocked;
  await student.save();

  const [targetSummary, subjectProgressResult, subjectCertification] = await Promise.all([
    getTargetXpSummary(payload.studentId, dateKey),
    getSubjectProgressData(payload.studentId),
    subjectCertificationService.getStudentCertificationSummaries({
      studentId: payload.studentId,
      applyAwards: true,
    }),
  ]);

  return {
    sessionLog,
    dailyXp: {
      dateKey,
      dailyLoginXp: dayPerformance.dailyLoginXp,
      attendanceXp: nextAttendanceXp,
      challengeXp: nextChallengeXp,
      assessmentXp: nextAssessmentXp,
      performanceXp: nextPerformanceXpCumulative,
      performanceXpCap: PERFORMANCE_DAILY_CAP,
      targetXp: targetSummary.dailyTargetXp,
      targetXpCap: TARGET_DAILY_CAP,
      weeklyTargetXp: targetSummary.weeklyTargetXp,
      weeklyTargetXpCap: TARGET_WEEKLY_CAP,
      totalXp: clampNumber(
        nextPerformanceXpCumulative + targetSummary.dailyTargetXp,
        0,
        PERFORMANCE_DAILY_CAP + TARGET_DAILY_CAP,
      ),
      totalXpCap: PERFORMANCE_DAILY_CAP + TARGET_DAILY_CAP,
      weekKey: targetSummary.weekKey,
      performanceXpAwarded,
      subjectCompletionBonusXp,
    },
    subjectProgress: applySubjectAwardFlags(
      subjectProgressResult.subjectProgress,
      student,
    ),
    subjectCertification,
    student: {
      ...serializeStudent(student),
    },
    resultPackageId: resultPackage ? String(resultPackage._id || "") : "",
    theoryReviewStatus: theoryReviewPending ? "pending_review" : "",
    theoryXpPending: theoryReviewPending,
  };
}

module.exports = {
  getDashboard,
  getStudentResultReport,
  getSubjectReport,
  getTimetable,
  listAssignedMissions,
  startSession,
  completeSession,
};
