/**
 * WHAT:
 * QuestionEvidenceFile stores private file metadata and structured previews for
 * one exact mission question while the original bytes live in Mongo GridFS.
 * WHY:
 * Uploaded evidence must remain auditable, question-scoped, and immutable once
 * submitted without placing large binary payloads inside normal BSON records.
 * HOW:
 * Link a GridFS file id to server-resolved mission ownership, extraction data,
 * uploader provenance, and an explicit draft/submitted/superseded lifecycle.
 */
const mongoose = require("mongoose");

const questionEvidenceFileSchema = new mongoose.Schema(
  {
    originalFileName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 255,
    },
    mimeType: {
      type: String,
      required: true,
      trim: true,
      maxlength: 160,
    },
    detectedType: {
      type: String,
      enum: ["pdf", "doc", "docx", "ppt", "pptx", "xls", "xlsx"],
      required: true,
      index: true,
    },
    fileSize: {
      type: Number,
      required: true,
      min: 1,
      max: 10 * 1024 * 1024,
    },
    fileHash: {
      type: String,
      required: true,
      trim: true,
      minlength: 64,
      maxlength: 64,
    },
    storageFileId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      unique: true,
    },
    storageBucket: {
      type: String,
      default: "questionEvidence",
      trim: true,
    },
    parsedType: {
      type: String,
      enum: ["pages", "blocks", "slides", "sheets", "unavailable"],
      default: "unavailable",
    },
    extractedContent: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    extractionVersion: {
      type: String,
      default: "question-evidence-v1",
      trim: true,
    },
    previewStatus: {
      type: String,
      enum: ["available", "unavailable"],
      default: "unavailable",
    },
    extractionError: {
      type: String,
      default: "",
      trim: true,
      maxlength: 500,
    },
    uploadedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    uploadedByRole: {
      type: String,
      enum: ["student", "teacher"],
      required: true,
    },
    uploadedAt: {
      type: Date,
      default: Date.now,
      required: true,
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
    missionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Mission",
      required: true,
      index: true,
    },
    questionId: {
      type: String,
      required: true,
      trim: true,
      minlength: 1,
      maxlength: 160,
    },
    questionIndex: {
      type: Number,
      required: true,
      min: 0,
      max: 59,
      index: true,
    },
    workDraftId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "MissionWorkDraft",
      default: null,
      index: true,
    },
    resultPackageId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ResultPackage",
      default: null,
      index: true,
    },
    status: {
      type: String,
      enum: ["draft", "submitted", "superseded"],
      default: "draft",
      required: true,
      index: true,
    },
    previousSubmittedEvidenceIds: {
      type: [mongoose.Schema.Types.ObjectId],
      default: [],
      // WHY: A redo may reference earlier immutable files without copying or
      // presenting them as the learner's new submission.
    },
    supersededAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true },
);

questionEvidenceFileSchema.index({
  missionId: 1,
  questionIndex: 1,
  status: 1,
  createdAt: -1,
});

questionEvidenceFileSchema.index({
  resultPackageId: 1,
  questionIndex: 1,
  createdAt: 1,
});

questionEvidenceFileSchema.index(
  { missionId: 1, questionId: 1 },
  {
    unique: true,
    partialFilterExpression: { status: "draft" },
    name: "one_draft_question_evidence",
  },
);

questionEvidenceFileSchema.index(
  { missionId: 1, questionId: 1 },
  {
    unique: true,
    partialFilterExpression: { status: "submitted" },
    name: "one_submitted_question_evidence",
  },
);

module.exports = mongoose.model(
  "QuestionEvidenceFile",
  questionEvidenceFileSchema,
);
