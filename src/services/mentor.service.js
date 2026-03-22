/**
 * WHAT:
 * mentor.service assembles mentor overview data and updates mentor-owned
 * support settings such as targets and preferred difficulty.
 * WHY:
 * Mentor actions should stay separate from teacher review and student mission
 * logic so support workflows remain focused and auditable.
 * HOW:
 * Load the student, aggregate recent targets and session metrics, then expose
 * helpers for target and difficulty updates.
 */
const SessionLog = require("../models/SessionLog");
const Target = require("../models/Target");
const User = require("../models/User");
const { serializeJourney } = require("../utils/userJourney");
const {
  TARGET_DAILY_CAP,
  TARGET_TYPE_CUSTOM,
  TARGET_TYPE_FIXED_ASSESSMENT,
  TARGET_TYPE_FIXED_DAILY_MISSION,
  TARGET_WEEKLY_CAP,
  calculateTargetXpFromStars,
  clampNumber,
  getDateKey,
  getWeekKey,
} = require("../utils/xpPolicy");

function createError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function serializeStudent(student) {
  return {
    id: String(student._id),
    name: student.name,
    yearGroup: String(student.yearGroup || ""),
    xp: student.xp,
    streak: student.streak,
    streakBadgeUnlocked: Boolean(student.streakBadgeUnlocked),
    ...serializeJourney(student),
    preferredDifficulty: student.preferredDifficulty,
  };
}

function normalizeTargetStatus(stars, fallbackStatus = "pending") {
  const parsedStars = clampNumber(stars, 0, 3);
  if (parsedStars >= 3) {
    return "completed";
  }

  if (parsedStars > 0) {
    return "in_progress";
  }

  return ["pending", "in_progress", "completed"].includes(fallbackStatus)
    ? fallbackStatus
    : "pending";
}

async function ensureWeeklyFixedTargets(studentId, dateKey) {
  const weekKey = getWeekKey(dateKey);
  const fixedTargets = await Target.find({
    studentId,
    weekKey,
    targetType: {
      $in: [TARGET_TYPE_FIXED_DAILY_MISSION, TARGET_TYPE_FIXED_ASSESSMENT],
    },
  })
    .select("targetType")
    .lean();
  const existingTypes = new Set(
    fixedTargets.map((target) => String(target.targetType || "")),
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

async function assertTargetCaps({
  studentId,
  weekKey,
  awardDateKey,
  nextXpAwarded,
  excludeTargetId = null,
}) {
  const filter = {
    studentId,
    weekKey,
  };
  if (excludeTargetId) {
    filter._id = { $ne: excludeTargetId };
  }

  const weeklyTargets = await Target.find(filter).select("xpAwarded awardDateKey").lean();
  const currentWeeklyXp = weeklyTargets.reduce(
    (sum, target) => sum + Number(target.xpAwarded || 0),
    0,
  );
  const currentDailyXp = weeklyTargets
    .filter((target) => String(target.awardDateKey || "") === awardDateKey)
    .reduce((sum, target) => sum + Number(target.xpAwarded || 0), 0);

  if (currentDailyXp + nextXpAwarded > TARGET_DAILY_CAP) {
    throw createError(
      400,
      "Daily target XP cap reached. Reduce stars before awarding more target XP.",
    );
  }

  if (currentWeeklyXp + nextXpAwarded > TARGET_WEEKLY_CAP) {
    throw createError(
      400,
      "Weekly target XP cap reached. Reset or lower target stars first.",
    );
  }
}

async function getOverview(studentId) {
  const dateKey = getDateKey();
  const student = await User.findOne({ _id: studentId, role: "student" }).lean();

  if (!student) {
    throw createError(404, "Student not found.");
  }

  await ensureWeeklyFixedTargets(studentId, dateKey);
  const weekKey = getWeekKey(dateKey);
  const targets = await Target.find({ studentId, weekKey })
    .sort({ targetType: 1, updatedAt: -1, createdAt: -1 })
    .lean();
  const recentSessions = await SessionLog.find({ studentId })
    .sort({ createdAt: -1 })
    .limit(6)
    .lean();

  const completedMissions = recentSessions.reduce(
    (sum, session) => sum + session.completedQuestions,
    0,
  );
  const averageFocusScore = recentSessions.length
    ? Math.round(
        // WHY: Mentors need one simple focus indicator they can compare week to
        // week without reading every individual session log.
        recentSessions.reduce((sum, session) => sum + session.focusScore, 0) /
          recentSessions.length,
      )
    : 0;
  const dailyTargetXp = clampNumber(
    targets
      .filter((target) => String(target.awardDateKey || "") === dateKey)
      .reduce((sum, target) => sum + Number(target.xpAwarded || 0), 0),
    0,
    TARGET_DAILY_CAP,
  );
  const weeklyTargetXp = clampNumber(
    targets.reduce((sum, target) => sum + Number(target.xpAwarded || 0), 0),
    0,
    TARGET_WEEKLY_CAP,
  );

  return {
    student: serializeStudent(student),
    metrics: {
      averageFocusScore,
      weeklyXp: student.xp,
      completedMissions,
      dailyTargetXp,
      weeklyTargetXp,
      targetDailyCap: TARGET_DAILY_CAP,
      targetWeeklyCap: TARGET_WEEKLY_CAP,
    },
    targets,
    recentSessions,
  };
}

async function createTarget(payload, staff) {
  const dateKey = String(payload.awardDateKey || getDateKey()).trim();
  const weekKey = String(payload.weekKey || getWeekKey(dateKey)).trim();
  const targetType = String(payload.targetType || TARGET_TYPE_CUSTOM).trim();
  const stars = clampNumber(payload.stars || 0, 0, 3);
  const xpAwarded = calculateTargetXpFromStars(stars);

  if (
    targetType === TARGET_TYPE_CUSTOM &&
    String(payload.studentId || "").trim() &&
    weekKey
  ) {
    const customTargetCount = await Target.countDocuments({
      studentId: payload.studentId,
      weekKey,
      targetType: TARGET_TYPE_CUSTOM,
    });
    if (customTargetCount >= 5) {
      throw createError(
        400,
        "Only five teacher-defined weekly targets can be created per student.",
      );
    }
  }

  await assertTargetCaps({
    studentId: payload.studentId,
    weekKey,
    awardDateKey: dateKey,
    nextXpAwarded: xpAwarded,
  });

  const target = await Target.create({
    ...payload,
    targetType,
    weekKey,
    awardDateKey: dateKey,
    stars,
    xpAwarded,
    status: normalizeTargetStatus(stars, payload.status),
    createdByStaffId: staff?.id || null,
    awardedByStaffId: xpAwarded > 0 ? staff?.id || null : null,
    awardedAt: xpAwarded > 0 ? new Date() : null,
  });

  if (xpAwarded > 0) {
    await User.findByIdAndUpdate(payload.studentId, {
      $inc: { xp: xpAwarded },
    });
  }

  return target;
}

async function updateTarget(targetId, payload, staff) {
  const target = await Target.findById(targetId);

  if (!target) {
    throw createError(404, "Target not found.");
  }

  const previousXpAwarded = Number(target.xpAwarded || 0);
  const nextStars = payload.stars === undefined
    ? Number(target.stars || 0)
    : clampNumber(payload.stars, 0, 3);
  const nextXpAwarded = calculateTargetXpFromStars(nextStars);
  const nextAwardDateKey = String(
    payload.awardDateKey || target.awardDateKey || getDateKey(),
  ).trim();
  const nextWeekKey = String(
    payload.weekKey || target.weekKey || getWeekKey(nextAwardDateKey),
  ).trim();

  await assertTargetCaps({
    studentId: String(target.studentId),
    weekKey: nextWeekKey,
    awardDateKey: nextAwardDateKey,
    nextXpAwarded,
    excludeTargetId: String(target._id),
  });

  target.title = payload.title === undefined ? target.title : String(payload.title || "").trim();
  target.description = payload.description === undefined
    ? target.description
    : String(payload.description || "").trim();
  target.difficulty = payload.difficulty || target.difficulty;
  target.startDate = payload.startDate === undefined ? target.startDate : payload.startDate;
  target.endDate = payload.endDate === undefined ? target.endDate : payload.endDate;
  target.weekKey = nextWeekKey;
  target.awardDateKey = nextAwardDateKey;
  target.stars = nextStars;
  target.xpAwarded = nextXpAwarded;
  target.status = normalizeTargetStatus(nextStars, payload.status || target.status);
  target.awardedByStaffId = nextXpAwarded > 0 ? staff?.id || target.awardedByStaffId : null;
  target.awardedAt = nextXpAwarded > 0 ? new Date() : null;

  await target.save();

  const deltaXp = nextXpAwarded - previousXpAwarded;
  if (deltaXp !== 0) {
    await User.findByIdAndUpdate(target.studentId, {
      $inc: { xp: deltaXp },
    });
  }

  return target;
}

async function updateDifficulty(studentId, { preferredDifficulty }) {
  const student = await User.findByIdAndUpdate(
    studentId,
    { preferredDifficulty },
    { new: true },
  ).lean();

  if (!student) {
    throw createError(404, "Student not found.");
  }

  return {
    id: String(student._id),
    name: student.name,
    preferredDifficulty: student.preferredDifficulty,
  };
}

module.exports = {
  getOverview,
  createTarget,
  updateTarget,
  updateDifficulty,
};
