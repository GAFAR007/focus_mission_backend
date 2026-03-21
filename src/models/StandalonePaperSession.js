/**
 * WHAT:
 * StandalonePaperSession stores one live or completed student sitting for a
 * standalone Test or Exam.
 * WHY:
 * Delivery rules like timers, one-question navigation, leave-page integrity,
 * auto-submit, and teacher resets need their own auditable runtime record
 * instead of overloading the paper draft itself.
 * HOW:
 * Persist the scheduled paper snapshot, session status, saved responses,
 * integrity events, and any linked result package for each standalone attempt.
 */
const mongoose = require("mongoose");

const standalonePaperIntegrityEventSchema = new mongoose.Schema(
  {
    eventType: {
      type: String,
      enum: [
        "page_hidden",
        "window_blur",
        "fullscreen_exit",
        "route_leave",
        "app_backgrounded",
        "manual_back_attempt",
      ],
      required: true,
      trim: true,
    },
    detail: {
      type: String,
      default: "",
      trim: true,
    },
    actionTaken: {
      type: String,
      enum: ["logged", "warned", "locked"],
      default: "logged",
      trim: true,
    },
    occurredAt: {
      type: Date,
      default: Date.now,
    },
    warningCountAfter: {
      type: Number,
      min: 0,
      default: 0,
    },
    leaveCountAfter: {
      type: Number,
      min: 0,
      default: 0,
    },
  },
  { _id: false },
);

const standalonePaperResponseSchema = new mongoose.Schema(
  {
    itemIndex: {
      type: Number,
      required: true,
      min: 0,
    },
    itemType: {
      type: String,
      enum: ["OBJECTIVE", "FILL_GAP", "THEORY"],
      required: true,
      trim: true,
    },
    selectedOptionIndex: {
      type: Number,
      min: -1,
      max: 3,
      default: -1,
    },
    textAnswer: {
      type: String,
      default: "",
      trim: true,
    },
    flagged: {
      type: Boolean,
      default: false,
    },
    answeredAt: {
      type: Date,
      default: null,
    },
    teacherScorePercent: {
      type: Number,
      min: 0,
      max: 100,
      default: null,
    },
    teacherFeedback: {
      type: String,
      default: "",
      trim: true,
    },
  },
  { _id: false },
);

const standalonePaperSessionSchema = new mongoose.Schema(
  {
    paperId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "StandalonePaper",
      required: true,
      index: true,
    },
    teacherId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
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
    paperKind: {
      type: String,
      enum: ["TEST", "EXAM"],
      required: true,
      trim: true,
    },
    sessionType: {
      type: String,
      enum: ["morning", "afternoon"],
      required: true,
      trim: true,
      index: true,
    },
    targetDate: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    attemptNumber: {
      type: Number,
      min: 1,
      default: 1,
    },
    status: {
      type: String,
      enum: [
        "active",
        "locked",
        "submitted",
        "time_expired",
        "reset_by_teacher",
      ],
      required: true,
      default: "active",
      index: true,
    },
    startedAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
    endsAt: {
      type: Date,
      default: null,
    },
    submittedAt: {
      type: Date,
      default: null,
    },
    lockedAt: {
      type: Date,
      default: null,
    },
    resetAt: {
      type: Date,
      default: null,
    },
    lastHeartbeatAt: {
      type: Date,
      default: null,
    },
    currentItemIndex: {
      type: Number,
      min: 0,
      default: 0,
    },
    warningCount: {
      type: Number,
      min: 0,
      default: 0,
    },
    leaveCount: {
      type: Number,
      min: 0,
      default: 0,
    },
    totalItems: {
      type: Number,
      min: 0,
      default: 0,
    },
    answeredCount: {
      type: Number,
      min: 0,
      default: 0,
    },
    autoScorePercent: {
      type: Number,
      min: 0,
      max: 100,
      default: 0,
    },
    reviewStatus: {
      type: String,
      enum: ["not_needed", "pending_review", "scored"],
      default: "not_needed",
      index: true,
    },
    submittedReason: {
      type: String,
      enum: ["manual_submit", "time_expired", "integrity_lock"],
      default: "",
      trim: true,
    },
    resultPackageId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ResultPackage",
      default: null,
      index: true,
    },
    sessionLogId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SessionLog",
      default: null,
      index: true,
    },
    integrityEvents: {
      type: [standalonePaperIntegrityEventSchema],
      default: [],
    },
    responses: {
      type: [standalonePaperResponseSchema],
      default: [],
    },
  },
  { timestamps: true },
);

standalonePaperSessionSchema.index({
  paperId: 1,
  createdAt: -1,
});

standalonePaperSessionSchema.index({
  studentId: 1,
  targetDate: 1,
  sessionType: 1,
  createdAt: -1,
});

module.exports = mongoose.model(
  "StandalonePaperSession",
  standalonePaperSessionSchema,
);
