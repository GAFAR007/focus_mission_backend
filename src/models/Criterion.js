/**
 * WHAT:
 * Defines a criterion inside a unit that students work through from learning
 * to teacher-reviewed submission.
 * WHY:
 * The frozen production flow is criterion-led, so every learning draft,
 * knowledge check, essay builder, and submission must hang off a single
 * auditable criterion record.
 * HOW:
 * Each criterion belongs to one subject and one unit, keeps ordered placement,
 * and stores the mandatory pass-rate and word-count thresholds used by the
 * progression engine.
 */

const mongoose = require("mongoose");

const criterionSchema = new mongoose.Schema(
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
    title: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      default: "",
      trim: true,
    },
    baseOrder: {
      type: Number,
      default: 0,
      min: 0,
    },
    requiredWordCount: {
      type: Number,
      required: true,
      min: 1,
    },
    learningPassRate: {
      type: Number,
      default: 75,
      min: 60,
      max: 100,
      // WHY:
      // LearningCheck needs a teacher-controlled threshold, but the system
      // must keep it inside a qualification-safe range so progress rules stay
      // predictable and auditable.
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  },
);

criterionSchema.index(
  { unitId: 1, baseOrder: 1, title: 1 },
  { unique: true },
);

module.exports = mongoose.model("Criterion", criterionSchema);
