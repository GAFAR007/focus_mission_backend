/**
 * WHAT:
 * Stores one criterion block for either the learning-check phase or the
 * essay-builder phase.
 * WHY:
 * Blocks are the core activity unit in the frozen Focus Mission flow, and they
 * must stay auditable, ordered, and phase-aware so the system can enforce
 * attempts, locking, and essay construction correctly.
 * HOW:
 * Each block belongs to one criterion, keeps a stable base order, and stores
 * the required prompt, options, answer index, and generated sentence data used
 * by the progression engine.
 */

const mongoose = require("mongoose");

const blockSchema = new mongoose.Schema(
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
    type: {
      type: String,
      required: true,
      trim: true,
    },
    phase: {
      type: String,
      enum: ["learningCheck", "essayBuilder"],
      required: true,
      index: true,
    },
    prompt: {
      type: String,
      required: true,
      trim: true,
    },
    options: {
      type: [String],
      default: [],
      validate: {
        validator(value) {
          return Array.isArray(value) && value.length <= 4;
        },
        message: "Blocks must include at most four options.",
        // WHY:
        // ADHD-first UX rules cap blocks at four visible options to reduce
        // overload and keep the choice set qualification-safe.
      },
    },
    correctIndex: {
      type: Number,
      default: -1,
      validate: {
        validator(value) {
          return Number.isInteger(value) && value >= -1 && value <= 3;
        },
        message: "correctIndex must be between -1 and 3.",
        // WHY:
        // learningCheck blocks need a bounded answer index, while essayBuilder
        // blocks may not have one correct option so -1 keeps the field present
        // without pretending there is a marked answer.
      },
    },
    generatedSentence: {
      type: String,
      default: "",
      trim: true,
    },
    baseOrder: {
      type: Number,
      required: true,
      min: 0,
    },
    isRequired: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  },
);

blockSchema.index({ criterionId: 1, phase: 1, baseOrder: 1 }, { unique: true });

module.exports = mongoose.model("Block", blockSchema);
