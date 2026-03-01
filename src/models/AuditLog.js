/**
 * WHAT:
 * AuditLog stores progression-related events that must remain traceable over
 * time.
 * WHY:
 * Focus Mission tracks qualification progress, so important transitions such as
 * submission and reset actions must be auditable instead of existing only in
 * transient API responses.
 * HOW:
 * Persist one event per action with actor, student, criterion, event type, and
 * optional metadata for later review.
 */

const mongoose = require("mongoose");

const auditLogSchema = new mongoose.Schema(
  {
    actorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    studentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    criterionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Criterion",
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: [
        "criterion_submitted",
        "learning_check_reset",
        "criterion_approved",
        "revision_requested",
      ],
      required: true,
      index: true,
    },
    message: {
      type: String,
      required: true,
      trim: true,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
      // WHY: Audit metadata needs to remain flexible so future progression
      // events can record supporting context without schema churn.
    },
  },
  {
    timestamps: true,
  },
);

auditLogSchema.index({ studentId: 1, criterionId: 1, createdAt: -1 });

module.exports = mongoose.model("AuditLog", auditLogSchema);
