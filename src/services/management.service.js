/**
 * WHAT:
 * management.service provides management-only result access, user creation,
 * and timetable setup actions.
 * WHY:
 * Management needs a dedicated, auditable route surface for reviewing student
 * outcomes, creating core users, and configuring student timetables without
 * inheriting teacher authoring flows.
 * HOW:
 * Verify management ownership boundaries, load recent result-backed missions,
 * create student or teacher accounts with explicit validation, and save
 * weekday timetable entries with explicit subject and teacher ownership.
 */
const bcrypt = require("bcryptjs");
const Mission = require("../models/Mission");
const Subject = require("../models/Subject");
const Timetable = require("../models/Timetable");
const User = require("../models/User");
const subjectCertificationService = require("./subjectCertification.service");
const { serializeMission } = require("../utils/missionSerializer");

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

  const assignedStudents = Array.isArray(
    managementUser.assignedStudents,
  ) ?
      managementUser.assignedStudents.map(
        (value) => String(value || ""),
      )
    : [];

  if (
    !assignedStudents.includes(
      String(studentId || ""),
    )
  ) {
    // WHY: Management review stays scoped to explicitly assigned learners so
    // result access remains traceable and limited to the correct caseload.
    throw createError(
      403,
      "You do not have access to this student's results.",
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

  const missions =
    await Mission.find({
      studentId,
      $or: [
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
      .lean();

  return missions
    .map(serializeMission)
    .filter(
      (mission) =>
        String(
          mission.latestResultPackageId || "",
        ).trim().length > 0,
    );
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
  listStudentResults,
  assertManagementStudentAccess,
  createManagedUser,
  listTeachers,
  listSubjects,
  getSubjectCertificationSettings,
  updateSubjectCertificationSettings,
  getStudentCertification,
  saveStudentTimetableEntry,
};
