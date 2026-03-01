/**
 * WHAT:
 * SessionLog records the outcome of a completed lesson session for a student.
 * WHY:
 * The current app still uses session logs for XP, focus reporting, and teacher
 * visibility while the frozen criterion workflow is being introduced.
 * HOW:
 * Save subject, slot, focus score, behaviour, notes, and XP awarded for each
 * session so progress remains auditable over time.
 */
const mongoose = require("mongoose");

const sessionLogSchema = new mongoose.Schema(
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
    },
    missionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Mission",
      default: null,
    },
    sessionType: {
      type: String,
      enum: ["morning", "afternoon"],
      required: true,
    },
    focusScore: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },
    dateKey: {
      type: String,
      default: "",
      trim: true,
      index: true,
      // WHY: Daily XP caps and streak continuity are calendar-day rules, so
      // each session needs an explicit day key for deterministic aggregation.
    },
    completedQuestions: {
      type: Number,
      default: 0,
      min: 0,
    },
    correctAnswers: {
      type: Number,
      default: 0,
      min: 0,
      // WHY: Storing correct-answer count keeps session scoring auditable and
      // lets score-based XP be traced to the exact learner outcome.
    },
    scorePercent: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },
    missionQuestionCount: {
      type: Number,
      default: 0,
      min: 0,
      // WHY: Question count distinguishes challenge and assessment sessions,
      // which drive different score-to-XP formulas.
    },
    attendanceXpAwarded: {
      type: Number,
      default: 0,
      min: 0,
      max: 20,
    },
    challengeXpAwarded: {
      type: Number,
      default: 0,
      min: 0,
      max: 30,
    },
    assessmentXpAwarded: {
      type: Number,
      default: 0,
      min: 0,
      max: 50,
    },
    performanceXpBeforeStreak: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },
    performanceXpAwarded: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },
    performanceXpCumulative: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
      // WHY: Persisting cumulative daily performance XP allows safe delta
      // calculations when a learner completes multiple sessions in one day.
    },
    streakMultiplierApplied: {
      type: Number,
      default: 1,
      min: 1,
      max: 1.2,
    },
    performanceQualifiedForStreak: {
      type: Boolean,
      default: false,
    },
    targetXpAwarded: {
      type: Number,
      default: 0,
      min: 0,
    },
    subjectCompletionBonusXp: {
      type: Number,
      default: 0,
      min: 0,
    },
    totalXpAwarded: {
      type: Number,
      default: 0,
      min: 0,
      // WHY: totalXpAwarded captures the full deterministic reward for this
      // completion event, including performance and bonus components.
    },
    behaviourStatus: {
      type: String,
      enum: ["great", "steady", "warning", "penalty"],
      default: "steady",
    },
    notes: {
      type: String,
      default: "",
      trim: true,
    },
    xpAwarded: {
      type: Number,
      default: 20,
      min: 0,
      // WHY: XP needs to be stored per session so reward history stays
      // traceable instead of relying on silent total recalculation.
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
  },
  {
    timestamps: true,
  },
);

sessionLogSchema.index({ studentId: 1, dateKey: 1 });
sessionLogSchema.index({ studentId: 1, subjectId: 1 });

module.exports = mongoose.model("SessionLog", sessionLogSchema);
