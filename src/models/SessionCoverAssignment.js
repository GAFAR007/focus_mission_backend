/**
 * WHAT:
 * SessionCoverAssignment stores a date-specific morning or afternoon cover
 * override for one student lesson slot.
 * WHY:
 * The timetable remains the planned lesson source of truth, but management
 * needs an audit-safe way to record when a mentor is covering a teacher slot.
 * HOW:
 * Save one active cover assignment per student/date/session so session-log
 * creation can confirm the planned teacher, actual conductor, and approver.
 */
const mongoose = require("mongoose");

const sessionCoverAssignmentSchema = new mongoose.Schema(
  {
    studentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    dateKey: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    sessionType: {
      type: String,
      enum: ["morning", "afternoon"],
      required: true,
      index: true,
    },
    subjectId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Subject",
      required: true,
    },
    plannedTeacherId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      // WHY: The planned teacher is the timetable owner, so cover audit must
      // still preserve who was originally responsible for the lesson slot.
    },
    coverStaffId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    coverStaffRole: {
      type: String,
      enum: ["mentor", "teacher"],
      required: true,
      // WHY: Role is persisted explicitly so management can see whether the
      // lesson was covered by a mentor or another teacher account later on.
    },
    createdByManagementId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    reason: {
      type: String,
      default: "",
      trim: true,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
      // WHY: Soft deactivation keeps historical cover records available for
      // session-log audit trails even after management removes the live cover.
    },
    deactivatedAt: {
      type: Date,
      default: null,
    },
    deactivatedByManagementId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

sessionCoverAssignmentSchema.index(
  { studentId: 1, dateKey: 1, sessionType: 1 },
  {
    unique: true,
    partialFilterExpression: { isActive: true },
  },
);

module.exports = mongoose.model(
  "SessionCoverAssignment",
  sessionCoverAssignmentSchema,
);
