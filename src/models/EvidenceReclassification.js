/**
 * WHAT:
 * EvidenceReclassification records one teacher-confirmed move of submitted
 * Theory or Essay Builder evidence between qualification task focuses.
 * WHY:
 * ResultPackage is historical evidence and must never be rewritten to pretend
 * that the learner originally submitted under a different task code.
 * HOW:
 * Link the untouched source evidence to its derived target mission/result,
 * record the source consequence, and attribute the decision to the teacher.
 */
const mongoose = require("mongoose");

const evidenceReclassificationSchema = new mongoose.Schema(
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
    stageType: {
      type: String,
      enum: ["THEORY", "ESSAY_BUILDER"],
      required: true,
      index: true,
    },
    sourceTaskCode: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      match: /^[PMD]\d+$/,
    },
    targetTaskCode: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      match: /^[PMD]\d+$/,
    },
    sourceMissionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Mission",
      required: true,
      index: true,
    },
    sourceResultPackageId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ResultPackage",
      required: true,
      unique: true,
      index: true,
    },
    targetMissionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Mission",
      required: true,
    },
    targetResultPackageId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ResultPackage",
      required: true,
    },
    restoredSourceMissionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Mission",
      default: null,
    },
    sourceRedoMissionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Mission",
      default: null,
    },
    replacedTargetMissionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Mission",
      default: null,
    },
    replacedTargetResultPackageId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ResultPackage",
      default: null,
    },
    questionEvidenceFileIds: {
      type: [mongoose.Schema.Types.ObjectId],
      ref: "QuestionEvidenceFile",
      default: [],
      // WHY: Move Evidence records the immutable attachment ids it carried so
      // an audit can prove the original files were neither replaced nor lost.
    },
    movedByTeacherId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    movedAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
    reason: {
      type: String,
      default: "",
      trim: true,
      maxlength: 2000,
    },
    sourceOutcome: {
      type: String,
      enum: ["restore_previous", "redo_required"],
      required: true,
    },
    targetOutcome: {
      type: String,
      enum: ["moved_evidence", "replaced_current"],
      required: true,
    },
    status: {
      type: String,
      enum: ["completed"],
      default: "completed",
      required: true,
    },
  },
  { timestamps: true },
);

evidenceReclassificationSchema.index({
  studentId: 1,
  subjectId: 1,
  targetTaskCode: 1,
  movedAt: -1,
});

module.exports = mongoose.model(
  "EvidenceReclassification",
  evidenceReclassificationSchema,
);
