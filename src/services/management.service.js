/**
 * WHAT:
 * management.service provides management-only result access and user-creation
 * actions.
 * WHY:
 * Management needs a dedicated, auditable route surface for reviewing student
 * outcomes and creating core users without inheriting teacher authoring flows.
 * HOW:
 * Verify management ownership boundaries, load recent result-backed missions,
 * and create student or teacher accounts with explicit validation.
 */
const bcrypt = require("bcryptjs");
const Mission = require("../models/Mission");
const User = require("../models/User");
const subjectCertificationService = require("./subjectCertification.service");
const { serializeMission } = require("../utils/missionSerializer");

const MANAGEMENT_RESULTS_HISTORY_LIMIT = 60;

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

module.exports = {
  listStudentResults,
  assertManagementStudentAccess,
  createManagedUser,
  listSubjects,
  getSubjectCertificationSettings,
  updateSubjectCertificationSettings,
  getStudentCertification,
};
