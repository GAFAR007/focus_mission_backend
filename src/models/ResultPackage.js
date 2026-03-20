/**
 * WHAT:
 * ResultPackage stores one immutable teacher-facing mission evidence bundle
 * created at mission submission time.
 * WHY:
 * Qualification evidence must remain auditable and retrievable after the live
 * session ends, including per-question or per-sentence proof.
 * HOW:
 * Persist mission meta, structured evidence, and latest delivery status with
 * refs to student, teacher, mission, subject, and session log.
 */

const mongoose = require("mongoose");

const resultPackageSchema = new mongoose.Schema(
  {
    studentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    teacherId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    missionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Mission",
      default: null,
      index: true,
    },
    sessionLogId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SessionLog",
      default: null,
      index: true,
    },
    subjectId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Subject",
      default: null,
      index: true,
    },
    resultKind: {
      type: String,
      enum: ["mission", "paper_assessment"],
      default: "mission",
      index: true,
      // WHY: Mission submissions and teacher-uploaded paper assessments now
      // share the same audit package model, but the source type must stay
      // explicit so history screens never have to pretend paper evidence was a
      // mission.
    },
    missionType: {
      type: String,
      enum: ["QUESTIONS", "THEORY", "ESSAY_BUILDER"],
      required: true,
      index: true,
    },
    meta: {
      studentName: {
        type: String,
        required: true,
        trim: true,
      },
      studentId: {
        type: String,
        required: true,
        trim: true,
      },
      teacherId: {
        type: String,
        default: "",
        trim: true,
      },
      missionId: {
        type: String,
        default: "",
        trim: true,
      },
      missionTitle: {
        type: String,
        required: true,
        trim: true,
      },
      subject: {
        type: String,
        default: "",
        trim: true,
      },
      taskCodes: {
        type: [String],
        default: [],
      },
      assignedDate: {
        type: String,
        default: "",
        trim: true,
      },
      startTime: {
        type: Date,
        default: null,
      },
      submitTime: {
        type: Date,
        required: true,
      },
      durationSeconds: {
        type: Number,
        min: 0,
        default: 0,
      },
      score: {
        correct: { type: Number, min: 0, default: 0 },
        total: { type: Number, min: 0, default: 0 },
        percent: { type: Number, min: 0, max: 100, default: 0 },
      },
      xpAwarded: {
        type: Number,
        min: 0,
        default: 0,
      },
    },
    evidence: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
      // WHY: Result evidence differs between QUESTIONS, THEORY, and
      // ESSAY_BUILDER, so this payload must stay flexible while remaining
      // persisted.
    },
    latestSendStatus: {
      type: String,
      enum: [
        "not_sent",
        "in_app_sent",
        "email_sent",
        "email_pending_retry",
        "email_failed",
        "partial_failure",
      ],
      default: "not_sent",
      index: true,
    },
  },
  {
    timestamps: true,
  },
);

resultPackageSchema.index({
  teacherId: 1,
  createdAt: -1,
});

module.exports = mongoose.model("ResultPackage", resultPackageSchema);
