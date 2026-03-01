/**
 * WHAT:
 * Stores a curriculum unit inside a subject.
 * WHY:
 * The frozen Focus Mission hierarchy requires Subject -> Unit -> Criterion so
 * teachers can organise learning content and progress against real course
 * structure instead of loose standalone missions.
 * HOW:
 * Each unit belongs to one subject, keeps a stable display order, and can be
 * toggled active without deleting historical student progress.
 */

const mongoose = require("mongoose");

const unitSchema = new mongoose.Schema(
  {
    subjectId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Subject",
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
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  },
);

unitSchema.index({ subjectId: 1, baseOrder: 1, title: 1 }, { unique: true });

module.exports = mongoose.model("Unit", unitSchema);
