/**
 * WHAT:
 * Stores one student's progress through one criterion.
 * WHY:
 * The frozen lifecycle is student-specific, not global. Attempts, lock states,
 * essay progress, submission, revision, and approval all need one auditable
 * record per student and criterion.
 * HOW:
 * This model links a student to a criterion and tracks lifecycle state,
 * learning-check attempts, essay-builder progress, submission locks, and review
 * outcomes without blocking the rest of the app.
 */

const mongoose = require("mongoose");

const studentProgressSchema = new mongoose.Schema(
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
    unitId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Unit",
      required: true,
      index: true,
    },
    criterionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Criterion",
      required: true,
      index: true,
    },
    criterionState: {
      type: String,
      enum: [
        "learning_required",
        "learning_check_active",
        "essay_builder_unlocked",
        "ready_for_submission",
        "submitted",
        "approved",
        "revision_requested",
      ],
      default: "learning_required",
      index: true,
    },
    learningStatus: {
      type: String,
      enum: ["pending", "active", "passed", "locked_review_required"],
      default: "pending",
      index: true,
    },
    learningCompletedAt: {
      type: Date,
      default: null,
    },
    learningCheckBlockOrder: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Block",
      },
    ],
    attemptsUsed: {
      type: Number,
      default: 0,
      min: 0,
      max: 3,
      // WHY:
      // LearningCheck is capped at three attempts so the criterion can lock
      // for teacher review without blocking the student's other subjects.
    },
    latestLearningCheckScore: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },
    essayBuilderUnlockedAt: {
      type: Date,
      default: null,
    },
    appendedBlockIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Block",
      },
    ],
    essayText: {
      type: String,
      default: "",
      trim: true,
    },
    wordCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    submissionUnlocked: {
      type: Boolean,
      default: false,
      // WHY:
      // Submission must only unlock when the required word count and required
      // essay-builder blocks are complete, but it must still wait for the
      // student to press submit manually.
    },
    submittedAt: {
      type: Date,
      default: null,
    },
    completed: {
      type: Boolean,
      default: false,
      // WHY:
      // Submission should explicitly mark the criterion as completed so review
      // state can be audited without inferring completion from timestamps.
    },
    approvedAt: {
      type: Date,
      default: null,
    },
    revisionRequestedAt: {
      type: Date,
      default: null,
    },
    xpAwarded: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  {
    timestamps: true,
  },
);

studentProgressSchema.index(
  { studentId: 1, criterionId: 1 },
  { unique: true },
);

module.exports = mongoose.model("StudentProgress", studentProgressSchema);
