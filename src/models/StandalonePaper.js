/**
 * WHAT:
 * StandalonePaper stores teacher-authored standalone Test and Exam drafts that
 * sit outside the daily mission and timetable assessment flows.
 * WHY:
 * Tests and Exams now need their own auditable authoring space with mixed item
 * types, so this model must not overload the mission schema that only supports
 * one draft format at a time.
 * HOW:
 * Persist a teacher-owned paper draft with reviewed unit text, upload metadata,
 * mixed paper items, and explicit paper kind for separate teacher workflows.
 */
const mongoose = require("mongoose");

const standalonePaperItemSchema = new mongoose.Schema(
  {
    itemType: {
      type: String,
      enum: ["OBJECTIVE", "FILL_GAP", "THEORY"],
      required: true,
      trim: true,
    },
    learningText: {
      type: String,
      default: "",
      trim: true,
      // WHY: Imported or teacher-authored mixed papers still need explicit
      // teach-first guidance per item so the review copy stays readable.
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
          if (this.itemType !== "OBJECTIVE") {
            return Array.isArray(value) && value.length === 0;
          }

          return Array.isArray(value) && value.length === 4;
        },
        message:
          "Standalone paper objective items must include exactly four answer options.",
      },
    },
    correctIndex: {
      type: Number,
      default: -1,
      validate: {
        validator(value) {
          if (this.itemType !== "OBJECTIVE") {
            return Number(value) === -1;
          }

          return Number.isInteger(value) && value >= 0 && value <= 3;
        },
        message:
          "Standalone paper objective items must use a correctIndex between 0 and 3.",
      },
    },
    expectedAnswer: {
      type: String,
      default: "",
      trim: true,
      // WHY: Fill-gap and theory items need a teacher-reviewed answer key so
      // import, export, and marking remain deterministic.
    },
    acceptedAnswers: {
      type: [String],
      default: [],
      validate: {
        validator(value) {
          if (this.itemType !== "FILL_GAP") {
            return Array.isArray(value) && value.length === 0;
          }

          return (
            Array.isArray(value) &&
            value.length > 0 &&
            value.every((item) => String(item || "").trim().length > 0)
          );
        },
        message:
          "Standalone paper fill-gap items must include at least one accepted answer.",
      },
    },
    explanation: {
      type: String,
      default: "",
      trim: true,
    },
    minWordCount: {
      type: Number,
      min: 0,
      max: 1000,
      default: 0,
      validate: {
        validator(value) {
          if (this.itemType !== "THEORY") {
            return Number(value) === 0;
          }

          return Number.isInteger(value) && value >= 0 && value <= 1000;
        },
        message:
          "Standalone paper theory items must use a minWordCount between 0 and 1000.",
      },
    },
  },
  { _id: false },
);

const standalonePaperSchema = new mongoose.Schema(
  {
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
      index: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    teacherNote: {
      type: String,
      default: "",
      trim: true,
    },
    sourceUnitText: {
      type: String,
      default: "",
      trim: true,
    },
    sourceRawText: {
      type: String,
      default: "",
      trim: true,
    },
    sourceFileName: {
      type: String,
      default: "",
      trim: true,
    },
    sourceFileType: {
      type: String,
      default: "",
      trim: true,
    },
    targetDate: {
      type: String,
      default: "",
      trim: true,
      index: true,
      // WHY: Standalone papers can be planned ahead without being tied to the
      // timetable mission date model, so the saved date stays explicit here.
    },
    durationMinutes: {
      type: Number,
      min: 0,
      max: 600,
      default: 0,
    },
    status: {
      type: String,
      enum: ["draft", "published"],
      default: "draft",
      index: true,
    },
    publishedAt: {
      type: Date,
      default: null,
    },
    items: {
      type: [standalonePaperItemSchema],
      default: [],
      validate: {
        validator(value) {
          return Array.isArray(value) && value.length > 0 && value.length <= 60;
        },
        message:
          "Standalone papers must include between 1 and 60 saved items.",
      },
    },
  },
  { timestamps: true },
);

standalonePaperSchema.index({
  teacherId: 1,
  studentId: 1,
  paperKind: 1,
  updatedAt: -1,
});

module.exports = mongoose.model("StandalonePaper", standalonePaperSchema);
