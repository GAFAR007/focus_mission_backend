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
const SessionCoverAssignment = require("../models/SessionCoverAssignment");
const Timetable = require("../models/Timetable");
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

function parseRequestedDateKey(value) {
  const dateKey = String(value || "").trim();
  if (!dateKey) {
    return getDateKey();
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
    throw createError(400, "dateKey must be a valid YYYY-MM-DD date.");
  }

  return dateKey;
}

function parseDateKeyToDate(dateKey) {
  const normalizedDateKey = parseRequestedDateKey(dateKey);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(normalizedDateKey);
  const year = Number(match?.[1] || 0);
  const month = Number(match?.[2] || 0);
  const day = Number(match?.[3] || 0);
  return new Date(year, month - 1, day, 12, 0, 0, 0);
}

function weekdayForDateKey(dateKey) {
  return new Intl.DateTimeFormat("en-US", { weekday: "long" }).format(
    parseDateKeyToDate(dateKey),
  );
}

function assertDateKeyNotFuture(dateKey, fieldName = "dateKey") {
  if (String(dateKey || "").trim() > getDateKey()) {
    throw createError(400, `${fieldName} cannot be in the future.`);
  }
}

function serializeTarget(target) {
  const createdByStaff =
    target?.createdByStaffId &&
    typeof target.createdByStaffId === "object"
      ? target.createdByStaffId
      : null;
  const awardedByStaff =
    target?.awardedByStaffId &&
    typeof target.awardedByStaffId === "object"
      ? target.awardedByStaffId
      : null;
  const subject =
    target?.subjectId &&
    typeof target.subjectId === "object"
      ? target.subjectId
      : null;
  const plannedTeacher =
    target?.plannedTeacherId &&
    typeof target.plannedTeacherId === "object"
      ? target.plannedTeacherId
      : null;

  return {
    id: String(target?._id || ""),
    title: String(target?.title || ""),
    description: String(target?.description || ""),
    status: String(target?.status || ""),
    difficulty: String(target?.difficulty || ""),
    targetType: String(target?.targetType || "custom"),
    stars: Number(target?.stars || 0),
    xpAwarded: Number(target?.xpAwarded || 0),
    weekKey: String(target?.weekKey || ""),
    awardDateKey: String(target?.awardDateKey || ""),
    sessionType: String(target?.sessionType || ""),
    subjectId: String(subject?._id || target?.subjectId || ""),
    subjectName: String(subject?.name || ""),
    plannedTeacherName: String(plannedTeacher?.name || ""),
    plannedTeacherRole: String(plannedTeacher?.role || ""),
    createdByName: String(createdByStaff?.name || ""),
    createdByRole: String(createdByStaff?.role || ""),
    awardedByName: String(awardedByStaff?.name || ""),
    awardedByRole: String(awardedByStaff?.role || ""),
    createdAt: target?.createdAt || null,
    updatedAt: target?.updatedAt || null,
    awardedAt: target?.awardedAt || null,
  };
}

function serializeCoveredSessionLog(sessionLog) {
  if (!sessionLog) {
    return null;
  }

  return {
    id: String(sessionLog._id || ""),
    notes: String(sessionLog.notes || ""),
    focusScore: Number(sessionLog.focusScore || 0),
    completedQuestions: Number(sessionLog.completedQuestions || 0),
    behaviourStatus: String(sessionLog.behaviourStatus || "steady"),
    xpAwarded: Number(sessionLog.xpAwarded || 0),
    authorName: String(sessionLog.createdBy?.name || ""),
    authorRole: String(sessionLog.createdBy?.role || ""),
    createdAt: sessionLog.createdAt || null,
    updatedAt: sessionLog.updatedAt || null,
  };
}

function serializeCoveredSession(assignment, sessionLog) {
  return {
    id: String(assignment?._id || ""),
    dateKey: String(assignment?.dateKey || ""),
    sessionType: String(assignment?.sessionType || ""),
    reason: String(assignment?.reason || ""),
    subject: assignment?.subjectId
      ? {
          id: String(assignment.subjectId._id || assignment.subjectId.id || ""),
          name: String(assignment.subjectId.name || ""),
          icon: String(assignment.subjectId.icon || ""),
          color: String(assignment.subjectId.color || ""),
        }
      : null,
    plannedTeacher: assignment?.plannedTeacherId
      ? {
          id: String(assignment.plannedTeacherId._id || assignment.plannedTeacherId.id || ""),
          name: String(assignment.plannedTeacherId.name || ""),
          role: String(assignment.plannedTeacherId.role || ""),
          email: String(assignment.plannedTeacherId.email || ""),
        }
      : null,
    coverStaff: assignment?.coverStaffId
      ? {
          id: String(assignment.coverStaffId._id || assignment.coverStaffId.id || ""),
          name: String(assignment.coverStaffId.name || ""),
          role: String(assignment.coverStaffId.role || ""),
          email: String(assignment.coverStaffId.email || ""),
        }
      : null,
    sessionLog: serializeCoveredSessionLog(sessionLog),
  };
}

async function assertMentorAssignedStudent({
  mentorId,
  studentId,
}) {
  const [mentor, student] = await Promise.all([
    User.findOne({
      _id: mentorId,
      role: "mentor",
      assignedStudents: studentId,
    })
      .select("name assignedStudents")
      .lean(),
    User.findOne({
      _id: studentId,
      role: "student",
      isArchived: { $ne: true },
    })
      .select("name avatar avatarSeed xp streak yearGroup")
      .lean(),
  ]);

  if (!mentor) {
    throw createError(
      403,
      "Mentors can only work with students already assigned to them.",
    );
  }

  if (!student) {
    throw createError(404, "Student not found.");
  }

  return {
    mentor,
    student,
  };
}

async function assertTeacherAssignedStudent({
  teacherId,
  studentId,
}) {
  const [teacher, student] = await Promise.all([
    User.findOne({
      _id: teacherId,
      role: "teacher",
      assignedStudents: studentId,
    })
      .select("name assignedStudents")
      .lean(),
    User.findOne({
      _id: studentId,
      role: "student",
      isArchived: { $ne: true },
    })
      .select("name")
      .lean(),
  ]);

  if (!teacher) {
    throw createError(
      403,
      "Teachers can only manage targets for students already assigned to them.",
    );
  }

  if (!student) {
    throw createError(404, "Student not found.");
  }

  return {
    teacher,
    student,
  };
}

async function loadScheduledTeacherSessionContext({
  studentId,
  dateKey,
  sessionType,
}) {
  const timetable = await Timetable.findOne({
    studentId,
    day: weekdayForDateKey(dateKey),
  })
    .populate("morningSubject", "name")
    .populate("afternoonSubject", "name")
    .select(
      "morningSubject afternoonSubject morningTeacherId afternoonTeacherId",
    )
    .lean();

  if (!timetable) {
    return null;
  }

  if (sessionType === "morning") {
    return {
      sessionType: "morning",
      subjectId: String(
        timetable.morningSubject?._id || timetable.morningSubject || "",
      ),
      subjectName: String(timetable.morningSubject?.name || ""),
      plannedTeacherId: String(timetable.morningTeacherId || ""),
    };
  }

  if (sessionType === "afternoon") {
    return {
      sessionType: "afternoon",
      subjectId: String(
        timetable.afternoonSubject?._id || timetable.afternoonSubject || "",
      ),
      subjectName: String(timetable.afternoonSubject?.name || ""),
      plannedTeacherId: String(timetable.afternoonTeacherId || ""),
    };
  }

  return null;
}

async function resolveTeacherTargetAuditContext({
  teacherId,
  studentId,
  awardDateKey,
  targetType,
  sessionType,
  subjectId,
}) {
  await assertTeacherAssignedStudent({ teacherId, studentId });
  assertDateKeyNotFuture(awardDateKey, "awardDateKey");

  if (
    targetType === TARGET_TYPE_FIXED_DAILY_MISSION ||
    targetType === TARGET_TYPE_FIXED_ASSESSMENT
  ) {
    const morningContext = await loadScheduledTeacherSessionContext({
      studentId,
      dateKey: awardDateKey,
      sessionType: "morning",
    });
    const afternoonContext = await loadScheduledTeacherSessionContext({
      studentId,
      dateKey: awardDateKey,
      sessionType: "afternoon",
    });
    const hasScheduledSlot =
      String(morningContext?.plannedTeacherId || "") === teacherId ||
      String(afternoonContext?.plannedTeacherId || "") === teacherId;

    if (!hasScheduledSlot) {
      throw createError(
        403,
        "Teachers can only rate fixed targets on dates where they were scheduled to teach this student.",
      );
    }

    return {
      sessionType: "",
      subjectId: "",
      plannedTeacherId: "",
    };
  }

  if (!["morning", "afternoon"].includes(String(sessionType || "").trim())) {
    throw createError(
      400,
      "Teachers must save custom targets against a morning or afternoon lesson.",
    );
  }

  if (!String(subjectId || "").trim()) {
    throw createError(
      400,
      "Teachers must save custom targets against the scheduled subject for that lesson.",
    );
  }

  const sessionContext = await loadScheduledTeacherSessionContext({
    studentId,
    dateKey: awardDateKey,
    sessionType,
  });

  if (!sessionContext?.subjectId || !sessionContext?.plannedTeacherId) {
    throw createError(
      409,
      "A timetable lesson must exist for that student, date, and session before a teacher can save a target.",
    );
  }

  if (String(sessionContext.plannedTeacherId) !== teacherId) {
    throw createError(
      403,
      "Teachers can only save custom targets for lesson slots they were scheduled to teach.",
    );
  }

  if (String(sessionContext.subjectId) !== String(subjectId || "").trim()) {
    throw createError(
      403,
      "Teachers can only save custom targets for the subject scheduled in that lesson slot.",
    );
  }

  return {
    sessionType: sessionContext.sessionType,
    subjectId: sessionContext.subjectId,
    plannedTeacherId: sessionContext.plannedTeacherId,
  };
}

async function resolveMentorTargetAuditContext({
  mentorId,
  studentId,
  awardDateKey,
  sessionType,
  subjectId,
}) {
  await assertMentorAssignedStudent({ mentorId, studentId });
  assertDateKeyNotFuture(awardDateKey, "awardDateKey");

  if (!["morning", "afternoon"].includes(String(sessionType || "").trim())) {
    return {
      sessionType: "",
      subjectId: "",
      plannedTeacherId: "",
    };
  }

  const coverAssignment = await SessionCoverAssignment.findOne({
    studentId,
    dateKey: awardDateKey,
    sessionType,
    coverStaffId: mentorId,
    coverStaffRole: "mentor",
    isActive: true,
  })
    .select("subjectId plannedTeacherId")
    .lean();

  if (!coverAssignment) {
    throw createError(
      403,
      "Mentors can only attach lesson-specific targets to active covered sessions.",
    );
  }

  if (
    String(subjectId || "").trim() &&
    String(coverAssignment.subjectId || "") !== String(subjectId || "").trim()
  ) {
    throw createError(
      403,
      "Mentor lesson targets must match the covered subject for that session.",
    );
  }

  return {
    sessionType: String(sessionType || "").trim().toLowerCase(),
    subjectId: String(coverAssignment.subjectId || ""),
    plannedTeacherId: String(coverAssignment.plannedTeacherId || ""),
  };
}

async function resolveTargetAuditContext({
  staff,
  studentId,
  awardDateKey,
  targetType,
  sessionType,
  subjectId,
}) {
  const normalizedRole = String(staff?.role || "").trim().toLowerCase();
  if (normalizedRole === "teacher") {
    return resolveTeacherTargetAuditContext({
      teacherId: String(staff?.id || staff?._id || "").trim(),
      studentId,
      awardDateKey,
      targetType,
      sessionType,
      subjectId,
    });
  }

  if (normalizedRole === "mentor") {
    return resolveMentorTargetAuditContext({
      mentorId: String(staff?.id || staff?._id || "").trim(),
      studentId,
      awardDateKey,
      sessionType,
      subjectId,
    });
  }

  throw createError(403, "Only teachers or mentors can manage targets.");
}

async function loadSerializedTarget(targetId) {
  const target = await Target.findById(targetId)
    .populate("createdByStaffId", "name role")
    .populate("awardedByStaffId", "name role")
    .populate("subjectId", "name")
    .populate("plannedTeacherId", "name role")
    .lean();

  if (!target) {
    throw createError(404, "Target not found.");
  }

  return serializeTarget(target);
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

async function getOverview(studentId, options = {}) {
  const dateKey = parseRequestedDateKey(options?.dateKey);
  assertDateKeyNotFuture(dateKey, "dateKey");
  const student = await User.findOne({ _id: studentId, role: "student" }).lean();

  if (!student) {
    throw createError(404, "Student not found.");
  }

  await ensureWeeklyFixedTargets(studentId, dateKey);
  const weekKey = getWeekKey(dateKey);
  const targets = await Target.find({ studentId, weekKey })
    .populate("createdByStaffId", "name role")
    .populate("awardedByStaffId", "name role")
    .populate("subjectId", "name")
    .populate("plannedTeacherId", "name role")
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
    targets: targets.map(serializeTarget),
    recentSessions,
  };
}

async function listCoveredSessions({
  mentorId,
  studentId,
  dateKey,
}) {
  const resolvedDateKey = parseRequestedDateKey(dateKey);
  const { student } = await assertMentorAssignedStudent({
    mentorId,
    studentId,
  });

  const coverAssignments = await SessionCoverAssignment.find({
    studentId,
    dateKey: resolvedDateKey,
    coverStaffId: mentorId,
    coverStaffRole: "mentor",
    isActive: true,
    sessionType: { $in: ["morning", "afternoon"] },
  })
    .sort({ sessionType: 1, createdAt: 1 })
    .populate("subjectId", "name icon color")
    .populate("plannedTeacherId", "name role email")
    .populate("coverStaffId", "name role email")
    .lean();

  const assignmentIds = coverAssignments
    .map((assignment) => String(assignment._id || "").trim())
    .filter(Boolean);
  const sessionLogs = assignmentIds.length
    ? await SessionLog.find({
        studentId,
        coverAssignmentId: { $in: assignmentIds },
      })
        .populate("createdBy", "name role")
        .lean()
    : [];
  const logsByAssignmentId = new Map(
    sessionLogs.map((sessionLog) => [
      String(sessionLog.coverAssignmentId || "").trim(),
      sessionLog,
    ]),
  );

  return {
    student: serializeStudent(student),
    dateKey: resolvedDateKey,
    sessions: coverAssignments.map((assignment) =>
      serializeCoveredSession(
        assignment,
        logsByAssignmentId.get(String(assignment._id || "").trim()) || null,
      )),
  };
}

async function createCoveredSessionLog({
  mentorId,
  payload,
}) {
  const studentId = String(payload?.studentId || "").trim();
  const sessionType = String(payload?.sessionType || "")
    .trim()
    .toLowerCase();
  const dateKey = parseRequestedDateKey(payload?.dateKey);
  const { student } = await assertMentorAssignedStudent({
    mentorId,
    studentId,
  });

  if (!["morning", "afternoon"].includes(sessionType)) {
    throw createError(400, "sessionType must be morning or afternoon.");
  }
  assertDateKeyNotFuture(dateKey, "dateKey");

  const coverAssignment = await SessionCoverAssignment.findOne({
    studentId,
    dateKey,
    sessionType,
    coverStaffId: mentorId,
    coverStaffRole: "mentor",
    isActive: true,
  })
    .populate("subjectId", "name icon color")
    .populate("plannedTeacherId", "name role email")
    .populate("coverStaffId", "name role email")
    .lean();

  if (!coverAssignment) {
    throw createError(
      403,
      "An active mentor cover assignment is required before this lesson can be logged.",
    );
  }

  const manualXpAwarded = Number.isFinite(Number(payload?.xpAwarded))
    ? clampNumber(Number(payload.xpAwarded), 0, 50)
    : 0;
  const totalXpAwarded = manualXpAwarded;
  const existingLog = await SessionLog.findOne({
    studentId,
    dateKey,
    sessionType,
    coverAssignmentId: coverAssignment._id,
  })
    .select("xpAwarded")
    .lean();
  const xpDelta = totalXpAwarded - Number(existingLog?.xpAwarded || 0);

  const sessionLog = await SessionLog.findOneAndUpdate(
    {
      studentId,
      dateKey,
      sessionType,
      coverAssignmentId: coverAssignment._id,
    },
    {
      studentId,
      subjectId: coverAssignment.subjectId?._id || coverAssignment.subjectId,
      sessionType,
      dateKey,
      focusScore: clampNumber(Number(payload?.focusScore || 0), 0, 100),
      completedQuestions: Math.max(0, Number(payload?.completedQuestions || 0)),
      behaviourStatus: ["great", "steady", "warning", "penalty"].includes(
        String(payload?.behaviourStatus || "").trim(),
      )
        ? String(payload.behaviourStatus).trim()
        : "steady",
      notes: String(payload?.notes || "").trim(),
      attendanceXpAwarded: 0,
      challengeXpAwarded: 0,
      assessmentXpAwarded: 0,
      performanceXpBeforeStreak: 0,
      performanceXpAwarded: 0,
      performanceXpCumulative: 0,
      streakMultiplierApplied: 1,
      performanceQualifiedForStreak: false,
      targetXpAwarded: manualXpAwarded,
      subjectCompletionBonusXp: 0,
      totalXpAwarded,
      xpAwarded: totalXpAwarded,
      createdBy: mentorId,
      plannedTeacherId:
        coverAssignment.plannedTeacherId?._id || coverAssignment.plannedTeacherId,
      conductedByStaffId: mentorId,
      coverAssignmentId: coverAssignment._id,
    },
    {
      new: true,
      upsert: true,
      setDefaultsOnInsert: true,
    },
  )
    .populate("createdBy", "name role")
    .populate("plannedTeacherId", "name role email")
    .populate("coverAssignmentId")
    .lean();

  if (xpDelta !== 0) {
    await User.findByIdAndUpdate(studentId, {
      $inc: { xp: xpDelta },
    });
  }

  return {
    student: serializeStudent({
      ...student,
      xp: Number(student.xp || 0) + xpDelta,
    }),
    session: serializeCoveredSession(coverAssignment, sessionLog),
  };
}

async function createTarget(payload, staff) {
  const dateKey = String(payload.awardDateKey || getDateKey()).trim();
  const weekKey = String(payload.weekKey || getWeekKey(dateKey)).trim();
  const targetType = String(payload.targetType || TARGET_TYPE_CUSTOM).trim();
  const sessionType = String(payload.sessionType || "").trim().toLowerCase();
  const subjectId = String(payload.subjectId || "").trim();
  const stars = clampNumber(payload.stars || 0, 0, 3);
  const xpAwarded = calculateTargetXpFromStars(stars);
  const auditContext = await resolveTargetAuditContext({
    staff,
    studentId: String(payload.studentId || "").trim(),
    awardDateKey: dateKey,
    targetType,
    sessionType,
    subjectId,
  });

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
    sessionType: auditContext.sessionType,
    subjectId: auditContext.subjectId || null,
    plannedTeacherId: auditContext.plannedTeacherId || null,
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

  return loadSerializedTarget(target._id);
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
  const nextTargetType = String(
    payload.targetType || target.targetType || TARGET_TYPE_CUSTOM,
  ).trim();
  const nextSessionType = String(
    payload.sessionType || target.sessionType || "",
  )
    .trim()
    .toLowerCase();
  const nextSubjectId = String(
    payload.subjectId || target.subjectId || "",
  ).trim();
  const nextWeekKey = String(
    payload.weekKey || target.weekKey || getWeekKey(nextAwardDateKey),
  ).trim();
  const auditContext = await resolveTargetAuditContext({
    staff,
    studentId: String(target.studentId || ""),
    awardDateKey: nextAwardDateKey,
    targetType: nextTargetType,
    sessionType: nextSessionType,
    subjectId: nextSubjectId,
  });

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
  target.targetType = nextTargetType;
  target.sessionType = auditContext.sessionType;
  target.subjectId = auditContext.subjectId || null;
  target.plannedTeacherId = auditContext.plannedTeacherId || null;
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

  return loadSerializedTarget(target._id);
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
  listCoveredSessions,
  createCoveredSessionLog,
  createTarget,
  updateTarget,
  updateDifficulty,
};
