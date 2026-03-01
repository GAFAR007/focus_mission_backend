/**
 * WHAT:
 * Stores the structured learning content for a criterion.
 * WHY:
 * Focus Mission must teach before it checks knowledge, and AI is only allowed
 * to produce drafts that a teacher can review and approve. Learning content
 * therefore needs its own auditable record with draft and approval metadata.
 * HOW:
 * Each learning content record belongs to one criterion and keeps ordered
 * sections, draft/approved status, and teacher approval fields so the student
 * flow can enforce learning before any block unlocks.
 */

const mongoose = require("mongoose");

const learningSectionSchema = new mongoose.Schema(
  {
    heading: {
      type: String,
      default: "",
      trim: true,
    },
    body: {
      type: String,
      required: true,
      trim: true,
    },
    baseOrder: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  { _id: false },
);

const learningContentSchema = new mongoose.Schema(
  {
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
    title: {
      type: String,
      required: true,
      trim: true,
    },
    summary: {
      type: String,
      default: "",
      trim: true,
    },
    sections: {
      type: [learningSectionSchema],
      default: [],
    },
    status: {
      type: String,
      enum: ["draft", "approved"],
      default: "draft",
    },
    source: {
      type: String,
      enum: ["teacher", "ai"],
      default: "teacher",
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    approvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    approvedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

learningContentSchema.index({ criterionId: 1, status: 1, updatedAt: -1 });

module.exports = mongoose.model("LearningContent", learningContentSchema);
