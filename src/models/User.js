/**
 * WHAT:
 * User stores authenticated student, teacher, mentor, and management identities.
 * WHY:
 * Focus Mission uses role-controlled access, assigned relationships, and
 * learner continuity signals such as XP and login-day tracking.
 * HOW:
 * Keep role, credentials, profile state, and assignment references in one
 * schema so services can enforce permissions consistently.
 */
const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    passwordHash: {
      type: String,
      required: true,
      select: false,
    },
    role: {
      type: String,
      enum: ["student", "teacher", "mentor", "management"],
      required: true,
      index: true,
      // WHY: Role is the main permission boundary across student learning,
      // teacher authoring, and mentor/management review flows.
    },
    subjectSpecialty: {
      type: String,
      default: "",
      trim: true,
    },
    isPlaceholder: {
      type: Boolean,
      default: false,
    },
    avatar: {
      type: String,
      default: "",
    },
    avatarSeed: {
      type: String,
      default: "",
    },
    xp: {
      type: Number,
      default: 0,
      min: 0,
    },
    streak: {
      type: Number,
      default: 0,
      min: 0,
    },
    lastPerformanceDateKey: {
      type: String,
      default: "",
      trim: true,
      // WHY: Performance streak rules are day-based, so the last qualifying
      // date key must be persisted to avoid accidental duplicate streak increments.
    },
    streakBadgeUnlocked: {
      type: Boolean,
      default: false,
      // WHY: Badge unlock state is persisted so the reward can be shown once
      // and never re-triggered accidentally across sessions.
    },
    subjectCompletionAwards: {
      type: [
        {
          subjectId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Subject",
            required: true,
          },
          awardedAt: {
            type: Date,
            required: true,
          },
          bonusXp: {
            type: Number,
            required: true,
            min: 0,
          },
        },
      ],
      default: [],
      // WHY: Subject-completion bonus XP must stay idempotent, so each awarded
      // subject is tracked explicitly per learner.
    },
    subjectCertificationAwards: {
      type: [
        {
          subjectId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Subject",
            required: true,
          },
          awardedAt: {
            type: Date,
            required: true,
          },
          requiredTaskCodesSnapshot: {
            type: [String],
            default: [],
          },
          averagePassedScoreAtUnlock: {
            type: Number,
            min: 0,
            max: 100,
            default: 0,
          },
        },
      ],
      default: [],
      // WHY: Task-focus certification is separate from the older
      // assessment-completion reward, so its unlock history must be tracked in
      // its own audit-safe award list.
    },
    firstLoginAt: {
      type: Date,
      default: null,
    },
    lastLoginAt: {
      type: Date,
      default: null,
    },
    loginDayCount: {
      type: Number,
      default: 0,
      min: 0,
      // WHY: Login-day tracking supports ADHD-friendly continuity without
      // conflating attendance with assessment completion.
    },
    preferredDifficulty: {
      type: String,
      enum: ["easy", "medium", "hard"],
      default: "medium",
    },
    assignedStudents: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        // WHY: Teachers, mentors, and management need stable student links so mission and
        // review actions stay auditable and permission-safe.
      },
    ],
  },
  {
    timestamps: true,
  },
);

module.exports = mongoose.model("User", userSchema);
