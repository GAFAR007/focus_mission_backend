/**
 * WHAT:
 * Target stores short-term student goals used by teachers and mentors.
 * WHY:
 * Even while criterion-based qualification tracking is being added, the app
 * still needs lightweight visible targets that support daily motivation.
 * HOW:
 * Save student-specific goals with status, difficulty, and optional dates so
 * support staff can track progress without affecting core qualification state.
 */
const mongoose = require("mongoose");
const { getDateKey, getWeekKey } = require("../utils/xpPolicy");

const targetSchema = new mongoose.Schema(
  {
    studentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
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
    status: {
      type: String,
      enum: ["pending", "in_progress", "completed"],
      default: "pending",
      // WHY: Target status stays separate from criterion state because support
      // goals should not silently rewrite qualification progression.
    },
    difficulty: {
      type: String,
      enum: ["easy", "medium", "hard"],
      default: "medium",
    },
    startDate: Date,
    endDate: Date,
    weekKey: {
      type: String,
      default: () => getWeekKey(),
      trim: true,
      index: true,
      // WHY: Weekly caps and weekly target grouping need one stable ISO week key.
    },
    awardDateKey: {
      type: String,
      default: () => getDateKey(),
      trim: true,
      index: true,
      // WHY: Target XP contributes to daily and weekly totals, so each award
      // requires an explicit calendar-day identity.
    },
    targetType: {
      type: String,
      enum: ["fixed_daily_mission", "fixed_assessment", "custom"],
      default: "custom",
      index: true,
      // WHY: Two fixed targets and teacher-defined targets follow different
      // business rules, so target type must remain explicit.
    },
    stars: {
      type: Number,
      default: 0,
      min: 0,
      max: 3,
      // WHY: The target economy uses a 3-star rubric instead of binary checks.
    },
    xpAwarded: {
      type: Number,
      default: 0,
      min: 0,
      max: 15,
      // WHY: Star grading maps deterministically to XP (5/10/15) and should
      // stay persisted for auditing and dashboard calculations.
    },
    awardedByStaffId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    awardedAt: {
      type: Date,
      default: null,
    },
    createdByStaffId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

module.exports = mongoose.model("Target", targetSchema);
