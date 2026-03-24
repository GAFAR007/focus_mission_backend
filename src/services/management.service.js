/**
 * WHAT:
 * management.service provides management-only result access, user creation,
 * archive recovery, and timetable setup actions.
 * WHY:
 * Management needs a dedicated, auditable route surface for reviewing student
 * outcomes, creating core users, and configuring student timetables without
 * inheriting teacher authoring flows.
 * HOW:
 * Verify management ownership boundaries, load recent mission and paper result
 * history, create student or teacher accounts with explicit validation,
 * archive/unarchive learners safely, and save weekday timetable entries with
 * explicit subject and teacher ownership.
 */
const bcrypt = require("bcryptjs");
const Mission = require("../models/Mission");
const ResultPackage = require("../models/ResultPackage");
const SessionLog = require("../models/SessionLog");
const Subject = require("../models/Subject");
const Timetable = require("../models/Timetable");
const Target = require("../models/Target");
const User = require("../models/User");
const {
  serializeMissionResultHistoryEntry,
  serializeStandalonePaperResultHistoryEntry,
  sortResultHistoryEntries,
} = require("./result.service");
const subjectCertificationService = require("./subjectCertification.service");
const { serializeMission } = require("../utils/missionSerializer");
const { normalizeStudentYearGroup } = require("../utils/studentYearGroup");
const {
  getWeekKey,
} = require("../utils/xpPolicy");

const MANAGEMENT_RESULTS_HISTORY_LIMIT = 60;
const MANAGEMENT_TARGET_HISTORY_LIMIT = 80;
const MANAGEMENT_DAY_PLAN_MISSION_LIMIT = 16;
const WEEKDAY_OPTIONS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
];

function createError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizeEmail(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function normalizeForMatch(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeWeekday(value) {
  const trimmed = String(value || "").trim().toLowerCase();
  const match = WEEKDAY_OPTIONS.find(
    (weekday) => weekday.toLowerCase() === trimmed,
  );
  return match || "";
}

function normalizeStudentStatusFilter(value) {
  const trimmed = String(value || "")
    .trim()
    .toLowerCase();

  if (["active", "archived", "all"].includes(trimmed)) {
    return trimmed;
  }

  return "active";
}

function parseRequestedDate(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12);
  }

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (!match) {
    return null;
  }

  const [, year, month, day] = match;
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

async function resolveCanonicalTeacherSubjectSpecialty(subjectSpecialty) {
  const normalizedSpecialty = normalizeForMatch(subjectSpecialty);

  if (!normalizedSpecialty) {
    return "";
  }

  const subjects = await Subject.find({})
    .select("name")
    .lean();
  const matchingSubject = subjects.find(
    (subject) => normalizeForMatch(subject.name) === normalizedSpecialty,
  );

  if (!matchingSubject) {
    throw createError(
      400,
      "Teacher subject specialty must match an existing subject name.",
    );
  }

  // WHY: Persist the catalog subject name so future teacher checks compare
  // against one canonical value instead of preserving ad hoc free-text input.
  return String(matchingSubject.name || "").trim();
}

function formatDateKey(date) {
  const year = date.getFullYear().toString().padStart(4, "0");
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function weekdayForDate(date) {
  return new Intl.DateTimeFormat("en-US", { weekday: "long" }).format(date);
}

function buildWeekdayDateKeysForMonth(anchorDate) {
  const keys = [];
  const year = anchorDate.getFullYear();
  const month = anchorDate.getMonth();
  const lastDay = new Date(year, month + 1, 0).getDate();

  for (let day = 1; day <= lastDay; day += 1) {
    const date = new Date(year, month, day, 12, 0, 0, 0);
    const weekday = date.getDay();
    if (weekday === 0 || weekday === 6) {
      continue;
    }
    keys.push(formatDateKey(date));
  }

  return keys;
}

function buildManagementTargetDateSections({
  displayDateKeys,
  targets,
  sessionComments,
}) {
  return displayDateKeys.map((dateKey) => {
    const dateWeekKey = getWeekKey(dateKey);
    const targetsForDate = targets.filter((target) => {
      const targetType = String(target.targetType || "").trim();
      if (
        targetType === "fixed_daily_mission" ||
        targetType === "fixed_assessment"
      ) {
        // WHY: Fixed targets are weekly expectations, so management should see
        // them on every weekday in that teaching week instead of only on the
        // one day the row was first created.
        return String(target.weekKey || "").trim() === dateWeekKey;
      }

      return String(target.awardDateKey || "").trim() === dateKey;
    });

    const commentsForDate = sessionComments.filter(
      (comment) => String(comment.dateKey || "").trim() === dateKey,
    );

    return {
      dateKey,
      targets: targetsForDate,
      sessionComments: commentsForDate,
    };
  });
}

function collectTeacherIdsFromTimetables(entries) {
  const teacherIds = new Set();

  for (const entry of Array.isArray(entries) ? entries : []) {
    for (const value of [entry?.morningTeacherId, entry?.afternoonTeacherId]) {
      const teacherId = String(value || "").trim();
      if (teacherId) {
        teacherIds.add(teacherId);
      }
    }
  }

  return teacherIds;
}

async function syncTeacherAssignmentsForStudent({
  studentId,
  affectedTeacherIds,
}) {
  if (!Array.isArray(affectedTeacherIds) || affectedTeacherIds.length === 0) {
    return;
  }

  const timetableEntries = await Timetable.find({ studentId })
    .select("morningTeacherId afternoonTeacherId")
    .lean();
  const activeTeacherIds = collectTeacherIdsFromTimetables(timetableEntries);

  // WHY: Teacher workspace access depends on assignedStudents, so timetable
  // edits must add newly scheduled teachers and remove teachers no longer used
  // for this student across any weekday slot.
  await User.bulkWrite(
    affectedTeacherIds.map((teacherId) => ({
      updateOne: {
        filter: { _id: teacherId, role: "teacher" },
        update: activeTeacherIds.has(teacherId)
          ? { $addToSet: { assignedStudents: studentId } }
          : { $pull: { assignedStudents: studentId } },
      },
    })),
  );
}

function serializeUser(user) {
  return {
    id: String(user._id || ""),
    name: String(user.name || ""),
    email: String(user.email || ""),
    role: String(user.role || ""),
    subjectSpecialty: String(
      user.subjectSpecialty || "",
    ),
    yearGroup: normalizeStudentYearGroup(user?.yearGroup),
    isPlaceholder: Boolean(
      user.isPlaceholder,
    ),
    avatar: String(user.avatar || ""),
    avatarSeed: String(
      user.avatarSeed || "",
    ),
    xp: Number(user.xp || 0),
    streak: Number(user.streak || 0),
    streakBadgeUnlocked: Boolean(
      user.streakBadgeUnlocked,
    ),
    firstLoginAt: user.firstLoginAt || null,
    lastLoginAt: user.lastLoginAt || null,
    loginDayCount: Number(
      user.loginDayCount || 0,
    ),
    daysSinceFirstLogin: 0,
    isArchived: Boolean(user.isArchived),
    archivedAt: user.archivedAt || null,
    preferredDifficulty: String(
      user.preferredDifficulty || "",
    ),
    assignedStudents: Array.isArray(
      user.assignedStudents,
    ) ?
        user.assignedStudents.map(
          (value) => String(value || ""),
        )
      : [],
  };
}

function serializeTeacher(user) {
  return {
    id: String(user._id || ""),
    name: String(user.name || ""),
    email: String(user.email || ""),
    avatar: String(user.avatar || ""),
    subjectSpecialty: String(user.subjectSpecialty || ""),
  };
}

function serializeTimetableEntry(entry) {
  return {
    day: String(entry.day || ""),
    room: String(entry.room || ""),
    morningMission: entry.morningSubject,
    afternoonMission: entry.afternoonSubject,
    morningTeacher: entry.morningTeacherId || null,
    afternoonTeacher: entry.afternoonTeacherId || null,
  };
}

function serializeSubjectSummary(subject) {
  if (!subject) {
    return null;
  }

  return {
    id: String(subject._id || subject.id || ""),
    name: String(subject.name || ""),
    icon: String(subject.icon || ""),
    color: String(subject.color || ""),
  };
}

function serializeTarget(target) {
  const createdByStaff =
    target?.createdByStaffId &&
    typeof target.createdByStaffId === "object"
      ? target.createdByStaffId
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
    createdByName: String(createdByStaff?.name || ""),
    createdByRole: String(createdByStaff?.role || ""),
  };
}

function serializeTargetSessionComment(sessionLog) {
  const subject =
    sessionLog?.subjectId &&
    typeof sessionLog.subjectId === "object"
      ? sessionLog.subjectId
      : null;
  const createdBy =
    sessionLog?.createdBy &&
    typeof sessionLog.createdBy === "object"
      ? sessionLog.createdBy
      : null;

  return {
    id: String(sessionLog?._id || ""),
    dateKey: String(sessionLog?.dateKey || ""),
    sessionType: String(sessionLog?.sessionType || ""),
    subjectName: String(subject?.name || ""),
    comment: String(sessionLog?.notes || ""),
    teacherName: String(createdBy?.name || ""),
    teacherRole: String(createdBy?.role || ""),
  };
}

function serializePlannedSession({
  sessionType,
  subject,
  teacher,
  missions,
}) {
  return {
    sessionType,
    hasScheduledLesson: Boolean(
      subject &&
        String(subject._id || subject.id || "").trim(),
    ),
    subject: serializeSubjectSummary(subject),
    teacher: teacher ? serializeTeacher(teacher) : null,
    missions: Array.isArray(missions)
      ? missions.map(serializeMission)
      : [],
  };
}

async function assertManagementStudentAccess(
  managementId,
  studentId,
) {
  const managementUser =
    await User.findById(
      managementId,
    )
      .select("role assignedStudents")
      .lean();

  if (
    !managementUser ||
    String(
      managementUser.role || "",
    ) !== "management"
  ) {
    throw createError(
      403,
      "Management access is required.",
    );
  }

  const studentExists = await User.exists({
    _id: studentId,
    role: "student",
    isArchived: { $ne: true },
  });

  if (!studentExists) {
    // WHY: Management owns timetable and reporting setup across the live
    // product, but the access boundary must still confirm that the requested
    // learner record actually exists before exposing student data.
    throw createError(
      404,
      "Student not found.",
    );
  }
}

async function listStudentResults({
  managementId,
  studentId,
}) {
  await assertManagementStudentAccess(
    managementId,
    studentId,
  );

  const [missions, standalonePaperResults] = await Promise.all([
    Mission.find({
      studentId,
      $or: [
        { manualResultOnly: true },
        { status: "published" },
        { status: { $exists: false } },
      ],
      latestResultPackageId: {
        $exists: true,
        $ne: null,
      },
    })
      .sort({
        publishedAt: -1,
        createdAt: -1,
      })
      .limit(
        MANAGEMENT_RESULTS_HISTORY_LIMIT,
      )
      .populate(
        "subjectId",
        "name icon color",
      )
      .lean(),
    ResultPackage.find({
      studentId,
      resultKind: "paper_assessment",
      missionId: null,
    })
      .sort({ createdAt: -1 })
      .limit(MANAGEMENT_RESULTS_HISTORY_LIMIT)
      .populate("subjectId", "name icon color")
      .lean(),
  ]);

  return sortResultHistoryEntries([
    ...missions
      .map(serializeMissionResultHistoryEntry)
      .filter(Boolean),
    ...standalonePaperResults
      .map(serializeStandalonePaperResultHistoryEntry)
      .filter(Boolean),
  ]).slice(0, MANAGEMENT_RESULTS_HISTORY_LIMIT);
}

async function listStudentTargets({
  managementId,
  studentId,
  date,
}) {
  await assertManagementStudentAccess(
    managementId,
    studentId,
  );

  const anchorDate = parseRequestedDate(date) || parseRequestedDate("");
  const displayDateKeys = buildWeekdayDateKeysForMonth(anchorDate);
  const displayWeekKeys = [
    ...new Set(displayDateKeys.map((dateKey) => getWeekKey(dateKey))),
  ];

  const targets = await Target.find({
    studentId,
    $or: [
      { awardDateKey: { $in: displayDateKeys } },
      {
        weekKey: { $in: displayWeekKeys },
        targetType: { $in: ["fixed_daily_mission", "fixed_assessment"] },
      },
    ],
  })
    .sort({
      awardDateKey: -1,
      updatedAt: -1,
      createdAt: -1,
    })
    .populate("createdByStaffId", "name role")
    .limit(
      MANAGEMENT_TARGET_HISTORY_LIMIT,
    )
    .lean();

  const serializedTargets = targets.map(serializeTarget);

  const sessionLogs = displayDateKeys.length
    ? await SessionLog.find({
        studentId,
        dateKey: { $in: displayDateKeys },
        notes: { $exists: true, $ne: "" },
      })
        .select("dateKey sessionType notes subjectId createdBy")
        .populate("subjectId", "name")
        .populate("createdBy", "name role")
        .lean()
    : [];

  const sessionComments = sessionLogs
    .map(serializeTargetSessionComment)
    .sort((left, right) => {
      const dateCompare = String(right.dateKey || "").localeCompare(
        String(left.dateKey || ""),
      );
      if (dateCompare !== 0) {
        return dateCompare;
      }

      const leftSessionOrder =
        String(left.sessionType || "").trim().toLowerCase() === "morning"
          ? 0
          : 1;
      const rightSessionOrder =
        String(right.sessionType || "").trim().toLowerCase() === "morning"
          ? 0
          : 1;
      if (leftSessionOrder !== rightSessionOrder) {
        // WHY: Morning notes should appear before afternoon notes so
        // management reads the day in lesson order instead of lexical order.
        return leftSessionOrder - rightSessionOrder;
      }

      return String(left.subjectName || "").localeCompare(
        String(right.subjectName || ""),
      );
    });

  return {
    displayDateKeys,
    targets: serializedTargets,
    sessionComments,
    dateSections: buildManagementTargetDateSections({
      displayDateKeys,
      targets: serializedTargets,
      sessionComments,
    }),
  };
}

async function listStudents({
  managementId,
  status = "active",
}) {
  const managementUser = await User.findById(managementId)
    .select("role")
    .lean();

  if (
    !managementUser ||
    String(managementUser.role || "") !== "management"
  ) {
    throw createError(403, "Management access is required.");
  }

  const normalizedStatus = normalizeStudentStatusFilter(status);
  const studentFilter = {
    role: "student",
  };

  if (normalizedStatus === "active") {
    studentFilter.isArchived = { $ne: true };
  } else if (normalizedStatus === "archived") {
    studentFilter.isArchived = true;
  }

  // WHY: Management is responsible for timetable and setup across all learners,
  // so roster views must read the live student records instead of a stale
  // login snapshot or a manually curated subset.
  return User.find(studentFilter)
    .sort({ isArchived: 1, name: 1 })
    .select(
      "name role avatar avatarSeed xp streak preferredDifficulty firstLoginAt lastLoginAt loginDayCount isArchived archivedAt yearGroup",
    )
    .lean()
    .then((students) => students.map(serializeUser));
}

async function archiveStudent({
  managementId,
  studentId,
}) {
  const managementUser = await User.findById(managementId)
    .select("role")
    .lean();

  if (
    !managementUser ||
    String(managementUser.role || "") !== "management"
  ) {
    throw createError(403, "Management access is required.");
  }

  const archivedStudent = await User.findOneAndUpdate(
    {
      _id: studentId,
      role: "student",
      isArchived: { $ne: true },
    },
    {
      isArchived: true,
      archivedAt: new Date(),
      archivedBy: managementId,
    },
    {
      new: true,
    },
  ).lean();

  if (!archivedStudent) {
    throw createError(404, "Student not found.");
  }

  // WHY: Archived students must disappear from teacher, mentor, and
  // management pickers immediately so no stale caseload entry keeps offering
  // live timetable or result actions for a learner that has been retired.
  await User.updateMany(
    {
      role: { $in: ["teacher", "mentor", "management"] },
    },
    {
      $pull: {
        assignedStudents: archivedStudent._id,
      },
    },
  );

  console.info("[management] student_archived", {
    managementId: String(managementId || ""),
    studentId: String(archivedStudent._id || ""),
  });

  return serializeUser(archivedStudent);
}

async function unarchiveStudent({
  managementId,
  studentId,
}) {
  const managementUser = await User.findById(managementId)
    .select("role")
    .lean();

  if (
    !managementUser ||
    String(managementUser.role || "") !== "management"
  ) {
    throw createError(403, "Management access is required.");
  }

  const restoredStudent = await User.findOneAndUpdate(
    {
      _id: studentId,
      role: "student",
      isArchived: true,
    },
    {
      isArchived: false,
      archivedAt: null,
      archivedBy: null,
    },
    {
      new: true,
    },
  ).lean();

  if (!restoredStudent) {
    throw createError(404, "Archived student not found.");
  }

  // WHY: Unarchived learners must reappear for broad oversight roles
  // immediately, while teacher access is restored from the live timetable so
  // classroom ownership stays schedule-driven instead of archival-history-driven.
  await User.updateMany(
    {
      role: { $in: ["management", "mentor"] },
    },
    {
      $addToSet: {
        assignedStudents: restoredStudent._id,
      },
    },
  );

  const timetableEntries = await Timetable.find({
    studentId: restoredStudent._id,
  })
    .select("morningTeacherId afternoonTeacherId")
    .lean();
  const affectedTeacherIds = Array.from(
    collectTeacherIdsFromTimetables(timetableEntries),
  );

  await syncTeacherAssignmentsForStudent({
    studentId: restoredStudent._id,
    affectedTeacherIds,
  });

  console.info("[management] student_unarchived", {
    managementId: String(managementId || ""),
    studentId: String(restoredStudent._id || ""),
  });

  return serializeUser(restoredStudent);
}

async function createManagedUser({
  managementId,
  payload,
}) {
  const managementUser =
    await User.findById(
      managementId,
    )
      .select("role assignedStudents")
      .lean();

  if (
    !managementUser ||
    String(
      managementUser.role || "",
    ) !== "management"
  ) {
    throw createError(
      403,
      "Management access is required.",
    );
  }

  const role = String(
    payload?.role || "",
  )
    .trim()
    .toLowerCase();
  const name = String(
    payload?.name || "",
  ).trim();
  const email = normalizeEmail(
    payload?.email,
  );
  const password = String(
    payload?.password || "",
  );
  const subjectSpecialty = String(
    payload?.subjectSpecialty || "",
  ).trim();
  const yearGroup = normalizeStudentYearGroup(payload?.yearGroup);
  const canonicalSubjectSpecialty =
    role === "teacher"
      ? await resolveCanonicalTeacherSubjectSpecialty(subjectSpecialty)
      : "";

  if (
    !["student", "teacher"].includes(
      role,
    )
  ) {
    throw createError(
      400,
      "Role must be student or teacher.",
    );
  }

  if (!name) {
    throw createError(
      400,
      "Name is required.",
    );
  }

  if (
    !email ||
    !email.includes("@")
  ) {
    throw createError(
      400,
      "Valid email is required.",
    );
  }

  if (password.length < 8) {
    // WHY: Management-created accounts need a minimum password floor so new
    // users do not start with weak credentials.
    throw createError(
      400,
      "Password must be at least 8 characters.",
    );
  }

  if (
    role === "teacher" &&
    !canonicalSubjectSpecialty
  ) {
    throw createError(
      400,
      "Subject specialty is required for teachers.",
    );
  }

  const existingUser =
    await User.findOne({ email })
      .select("_id")
      .lean();
  if (existingUser) {
    throw createError(
      409,
      "A user with this email already exists.",
    );
  }

  const passwordHash =
    await bcrypt.hash(password, 10);
  const createdUser =
    await User.create({
      name,
      email,
      passwordHash,
      role,
      subjectSpecialty:
        role === "teacher" ?
          canonicalSubjectSpecialty
        : "",
      yearGroup: role === "student" ? yearGroup : "",
      isPlaceholder: false,
    });

  if (role === "student") {
    await User.findByIdAndUpdate(
      managementId,
      {
        $addToSet: {
          assignedStudents:
            createdUser._id,
        },
      },
    );
  }

  console.info(
    "[management] user_created",
    {
      managementId: String(
        managementId || "",
      ),
      createdUserId: String(
        createdUser._id || "",
      ),
      role,
    },
  );

  const freshUser =
    await User.findById(
      createdUser._id,
    ).lean();
  return serializeUser(
    freshUser || createdUser,
  );
}

async function updateStudentYearGroup({
  managementId,
  studentId,
  payload,
}) {
  const managementUser = await User.findById(managementId)
    .select("role")
    .lean();

  if (
    !managementUser ||
    String(managementUser.role || "") !== "management"
  ) {
    throw createError(403, "Management access is required.");
  }

  const yearGroup = normalizeStudentYearGroup(payload?.yearGroup);
  const updatedStudent = await User.findOneAndUpdate(
    {
      _id: studentId,
      role: "student",
    },
    {
      yearGroup,
    },
    {
      new: true,
    },
  ).lean();

  if (!updatedStudent) {
    throw createError(404, "Student not found.");
  }

  console.info("[management] student_year_group_updated", {
    managementId: String(managementId || ""),
    studentId: String(updatedStudent._id || ""),
    yearGroup,
  });

  return serializeUser(updatedStudent);
}

async function listSubjects() {
  return subjectCertificationService.listCertificationSubjects();
}

async function listTeachers() {
  const teachers = await User.find({
    role: "teacher",
  })
    .sort({ name: 1 })
    .select("name email avatar subjectSpecialty")
    .lean();

  return teachers.map(serializeTeacher);
}

async function getSubjectCertificationSettings({
  subjectId,
}) {
  return subjectCertificationService.getSubjectCertificationSettings(
    subjectId,
  );
}

async function updateSubjectCertificationSettings({
  subjectId,
  payload,
}) {
  return subjectCertificationService.updateSubjectCertificationSettings({
    subjectId,
    payload,
  });
}

async function getStudentCertification({
  managementId,
  studentId,
}) {
  await assertManagementStudentAccess(
    managementId,
    studentId,
  );

  return subjectCertificationService.getStudentCertificationSummaries({
    studentId,
    applyAwards: true,
  });
}

async function saveStudentTimetableEntry({
  managementId,
  studentId,
  payload,
}) {
  await assertManagementStudentAccess(
    managementId,
    studentId,
  );

  const day = normalizeWeekday(payload?.day);
  if (!day) {
    throw createError(
      400,
      "Day must be Monday to Friday.",
    );
  }

  const room = String(payload?.room || "").trim();
  const morningSubjectId = String(payload?.morningSubjectId || "").trim();
  const afternoonSubjectId = String(payload?.afternoonSubjectId || "").trim();
  const morningTeacherId = String(payload?.morningTeacherId || "").trim();
  const afternoonTeacherId = String(payload?.afternoonTeacherId || "").trim();

  if (!room) {
    throw createError(
      400,
      "Room is required.",
    );
  }

  const [morningSubject, afternoonSubject] = await Promise.all([
    Subject.findById(morningSubjectId)
      .select("name icon color")
      .lean(),
    Subject.findById(afternoonSubjectId)
      .select("name icon color")
      .lean(),
  ]);

  // WHY: Timetable subjects drive student access and teacher lesson ownership,
  // so slot saves must reject unknown subject ids instead of storing broken refs.
  if (!morningSubject || !afternoonSubject) {
    throw createError(
      400,
      "Morning and afternoon subjects must both exist.",
    );
  }

  const teacherIds = [
    morningTeacherId,
    afternoonTeacherId,
  ].filter(Boolean);
  const teachers = await User.find({
    _id: { $in: teacherIds },
    role: "teacher",
  })
    .select("name email avatar subjectSpecialty")
    .lean();
  const teacherMap = new Map(
    teachers.map((teacher) => [String(teacher._id || ""), teacher]),
  );

  // WHY: Slot teachers are optional in the schema for legacy data, but the
  // management setup flow should save only real teacher ids when provided.
  if (morningTeacherId && !teacherMap.has(morningTeacherId)) {
    throw createError(
      400,
      "Morning teacher must be a valid teacher account.",
    );
  }
  if (afternoonTeacherId && !teacherMap.has(afternoonTeacherId)) {
    throw createError(
      400,
      "Afternoon teacher must be a valid teacher account.",
    );
  }

  const previousEntry = await Timetable.findOne({
    studentId,
    day,
  })
    .select("morningTeacherId afternoonTeacherId")
    .lean();

  const updated = await Timetable.findOneAndUpdate(
    {
      studentId,
      day,
    },
    {
      studentId,
      day,
      room,
      morningSubject: morningSubjectId,
      afternoonSubject: afternoonSubjectId,
      morningTeacherId: morningTeacherId || null,
      afternoonTeacherId: afternoonTeacherId || null,
      mentorId: null,
    },
    {
      new: true,
      upsert: true,
      setDefaultsOnInsert: true,
    },
  )
    .populate("morningSubject")
    .populate("afternoonSubject")
    .populate("morningTeacherId", "name email avatar subjectSpecialty")
    .populate("afternoonTeacherId", "name email avatar subjectSpecialty")
    .lean();

  const affectedTeacherIds = [
    ...collectTeacherIdsFromTimetables([previousEntry]),
    ...teacherIds,
  ].filter(Boolean);
  await syncTeacherAssignmentsForStudent({
    studentId,
    affectedTeacherIds: [...new Set(affectedTeacherIds)],
  });

  console.info(
    "[management] timetable_saved",
    {
      managementId: String(managementId || ""),
      studentId: String(studentId || ""),
      day,
      morningSubjectId,
      afternoonSubjectId,
    },
  );

  return serializeTimetableEntry(updated);
}

async function getStudentDayPlan({
  managementId,
  studentId,
  date,
}) {
  await assertManagementStudentAccess(
    managementId,
    studentId,
  );

  const selectedDate = parseRequestedDate(date);
  if (!selectedDate) {
    throw createError(
      400,
      "date must be in YYYY-MM-DD format.",
    );
  }

  const dateKey = formatDateKey(selectedDate);
  const weekday = weekdayForDate(selectedDate);

  const student = await User.findOne({
    _id: studentId,
    role: "student",
    isArchived: { $ne: true },
  })
    .select(
      "name avatar avatarSeed xp streak yearGroup isArchived archivedAt",
    )
    .lean();

  if (!student) {
    throw createError(
      404,
      "Student not found.",
    );
  }

  const timetable = await Timetable.findOne({
    studentId,
    day: weekday,
  })
    .populate("morningSubject", "name icon color")
    .populate("afternoonSubject", "name icon color")
    .populate(
      "morningTeacherId",
      "name email avatar subjectSpecialty",
    )
    .populate(
      "afternoonTeacherId",
      "name email avatar subjectSpecialty",
    )
    .lean();

  const morningSubjectId = String(
    timetable?.morningSubject?._id || timetable?.morningSubject || "",
  ).trim();
  const afternoonSubjectId = String(
    timetable?.afternoonSubject?._id || timetable?.afternoonSubject || "",
  ).trim();

  const [morningMissions, afternoonMissions] = await Promise.all([
    !morningSubjectId
      ? []
      : Mission.find({
          studentId,
          subjectId: morningSubjectId,
          sessionType: "morning",
          availableOnDate: dateKey,
          manualResultOnly: { $ne: true },
          $or: [{ status: "published" }, { status: { $exists: false } }],
        })
          .sort({ publishedAt: -1, createdAt: -1 })
          .limit(MANAGEMENT_DAY_PLAN_MISSION_LIMIT)
          .populate("subjectId", "name icon color")
          .lean(),
    !afternoonSubjectId
      ? []
      : Mission.find({
          studentId,
          subjectId: afternoonSubjectId,
          sessionType: "afternoon",
          availableOnDate: dateKey,
          manualResultOnly: { $ne: true },
          $or: [{ status: "published" }, { status: { $exists: false } }],
        })
          .sort({ publishedAt: -1, createdAt: -1 })
          .limit(MANAGEMENT_DAY_PLAN_MISSION_LIMIT)
          .populate("subjectId", "name icon color")
          .lean(),
  ]);

  return {
    student: serializeUser(student),
    dateKey,
    weekday,
    hasTimetableEntry: Boolean(timetable),
    room: String(timetable?.room || "").trim(),
    morning: serializePlannedSession({
      sessionType: "morning",
      subject: timetable?.morningSubject || null,
      teacher: timetable?.morningTeacherId || null,
      missions: morningMissions,
    }),
    afternoon: serializePlannedSession({
      sessionType: "afternoon",
      subject: timetable?.afternoonSubject || null,
      teacher: timetable?.afternoonTeacherId || null,
      missions: afternoonMissions,
    }),
  };
}

module.exports = {
  archiveStudent,
  unarchiveStudent,
  listStudents,
  listStudentResults,
  listStudentTargets,
  getStudentDayPlan,
  assertManagementStudentAccess,
  createManagedUser,
  listTeachers,
  listSubjects,
  updateStudentYearGroup,
  getSubjectCertificationSettings,
  updateSubjectCertificationSettings,
  getStudentCertification,
  saveStudentTimetableEntry,
};
