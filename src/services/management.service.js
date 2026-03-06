/**
 * WHAT:
 * management.service provides read-only student result access for management
 * users.
 * WHY:
 * Management needs a dedicated, auditable route surface for reviewing student
 * outcomes without inheriting teacher authoring or send-result permissions.
 * HOW:
 * Verify that the management user is assigned to the requested student, then
 * load recent published missions that already have result packages attached.
 */
const Mission = require("../models/Mission");
const User = require("../models/User");
const { serializeMission } = require("../utils/missionSerializer");

const MANAGEMENT_RESULTS_HISTORY_LIMIT = 60;

function createError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
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

module.exports = {
  listStudentResults,
  assertManagementStudentAccess,
};
