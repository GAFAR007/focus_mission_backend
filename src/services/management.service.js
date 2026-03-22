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
const Subject = require("../models/Subject");
const Timetable = require("../models/Timetable");
const User = require("../models/User");
const {
  serializeMissionResultHistoryEntry,
  serializeStandalonePaperResultHistoryEntry,
  sortResultHistoryEntries,
} = require("./result.service");
const subjectCertificationService = require("./subjectCertification.service");
const { normalizeStudentYearGroup } = require("../utils/studentYearGroup");

const MANAGEMENT_RESULTS_HISTORY_LIMIT = 60;
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
    !subjectSpecialty
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
          subjectSpecialty
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

module.exports = {
  archiveStudent,
  unarchiveStudent,
  listStudents,
  listStudentResults,
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
