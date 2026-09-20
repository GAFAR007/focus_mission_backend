/**
 * WHAT:
 * MissionWorkDraft stores one learner's unfinished Theory or Essay Builder work.
 * WHY:
 * Refreshes and later sessions must restore editable work without turning a
 * save action into scored, completed, or qualification evidence.
 * HOW:
 * Keep one versioned draft per student and mission, with format-specific
 * response fields and an explicit in-progress/submitted lifecycle.
 */
const mongoose = require("mongoose");

const theoryResponseSchema = new mongoose.Schema(
  {
    questionIndex: { type: Number, required: true, min: 0, max: 9 },
    answerText: { type: String, default: "", maxlength: 20000 },
    wordCount: { type: Number, default: 0, min: 0, max: 5000 },
    updatedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const blankSelectionSchema = new mongoose.Schema(
  {
    sentenceId: { type: String, required: true, trim: true, maxlength: 120 },
    blankId: { type: String, required: true, trim: true, maxlength: 120 },
    selectedOption: {
      type: String,
      enum: ["A", "B", "C", "D"],
      required: true,
    },
  },
  { _id: false },
);

const missionWorkDraftSchema = new mongoose.Schema(
  {
    studentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    missionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Mission",
      required: true,
      index: true,
    },
    subjectId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Subject",
      required: true,
      index: true,
    },
    missionType: {
      type: String,
      enum: ["THEORY", "ESSAY_BUILDER"],
      required: true,
    },
    theoryResponses: {
      type: [theoryResponseSchema],
      default: [],
    },
    essayBuilder: {
      selectedAnswers: { type: [blankSelectionSchema], default: [] },
      currentSentenceIndex: { type: Number, default: 0, min: 0, max: 60 },
      finalEssayText: { type: String, default: "", maxlength: 100000 },
      finalEssayWordCount: { type: Number, default: 0, min: 0, max: 20000 },
      updatedAt: { type: Date, default: null },
    },
    status: {
      type: String,
      enum: ["in_progress", "submitted"],
      default: "in_progress",
      index: true,
    },
    version: { type: Number, default: 1, min: 1 },
    submittedAt: { type: Date, default: null },
    resultPackageId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ResultPackage",
      default: null,
    },
  },
  { timestamps: true },
);

missionWorkDraftSchema.index(
  { studentId: 1, missionId: 1 },
  { unique: true, name: "unique_student_mission_work_draft" },
);

module.exports = mongoose.model("MissionWorkDraft", missionWorkDraftSchema);
