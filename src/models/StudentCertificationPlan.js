/**
 * WHAT:
 * StudentCertificationPlan stores the active teacher-authored task-focus
 * certification objectives for one student in one subject, plus version history.
 * WHY:
 * Teachers own the live certification objective set for their students, but the
 * app still needs an auditable, versioned source of truth instead of silently
 * overwriting course requirements.
 * HOW:
 * Persist immutable plan versions keyed by student and subject, with one active
 * version at a time and explicit authorship/change-reason metadata.
 */
const mongoose = require("mongoose");

const studentCertificationPlanSchema = new mongoose.Schema(
  {
    studentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    subjectId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Subject",
      required: true,
      index: true,
    },
    certificationLabel: {
      type: String,
      default: "Course Certification",
      trim: true,
    },
    requiredTaskCodes: {
      type: [String],
      default: [],
      validate: {
        validator(value) {
          return (
            Array.isArray(value) &&
            value.length > 0 &&
            value.every((item) =>
              /^[PMD]\d+$/i.test(String(item || "").trim()),
            )
          );
        },
        message:
          "requiredTaskCodes must contain valid task codes like P1, P2, M1, or D1.",
      },
      // WHY: Certification plans are explicit course objectives, so the stored
      // task-focus list must remain normalized and qualification-safe.
    },
    version: {
      type: Number,
      required: true,
      min: 1,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
      // WHY: Only one active version should drive current certification
      // progress, while old versions stay queryable for audit.
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    changeReason: {
      type: String,
      default: "",
      trim: true,
      maxlength: 240,
      // WHY: Teachers must explain why certification objectives changed so the
      // audit trail stays readable when plans are versioned later.
    },
  },
  {
    timestamps: true,
  },
);

studentCertificationPlanSchema.index(
  { studentId: 1, subjectId: 1, version: 1 },
  { unique: true },
);

studentCertificationPlanSchema.index(
  { studentId: 1, subjectId: 1, isActive: 1 },
  {
    unique: true,
    partialFilterExpression: { isActive: true },
  },
);

module.exports = mongoose.model(
  "StudentCertificationPlan",
  studentCertificationPlanSchema,
);
