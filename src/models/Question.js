/**
 * WHAT:
 * Question stores the reusable fallback subject question bank.
 * WHY:
 * The app still needs non-AI question coverage when a teacher has not yet
 * published a mission for a scheduled lesson.
 * HOW:
 * Keep subject-scoped multiple-choice questions with bounded options and a
 * difficulty label so services can assemble lightweight practice safely.
 */
const mongoose = require("mongoose");

const questionSchema = new mongoose.Schema(
  {
    subjectId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Subject",
      required: true,
      index: true,
    },
    question: {
      type: String,
      required: true,
      trim: true,
    },
    options: {
      type: [String],
      required: true,
      validate: {
        validator(value) {
          return Array.isArray(value) && value.length >= 2;
        },
        message: "Questions must include at least two answer options.",
      },
      // WHY: The fallback bank still needs explicit choices so students are not
      // forced into open-ended recall when no teacher-authored mission exists.
    },
    correctIndex: {
      type: Number,
      required: true,
      min: 0,
    },
    difficulty: {
      type: String,
      enum: ["easy", "medium", "hard"],
      required: true,
      // WHY: Difficulty tagging allows services to keep fallback practice
      // proportionate to the learner's current level.
    },
    tags: {
      type: [String],
      default: [],
    },
  },
  {
    timestamps: true,
  },
);

module.exports = mongoose.model("Question", questionSchema);
