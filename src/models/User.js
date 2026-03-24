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
    yearGroup: {
      type: String,
      default: "",
      trim: true,
      index: true,
      // WHY: Year-group targeting powers roster filtering and same-time
      // standalone Test/Exam assignment without forcing teachers to select
      // every student one by one each time.
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
    failedLoginAttempts: {
      type: Number,
      default: 0,
      min: 0,
      // WHY: Password-reset email access opens only after repeated wrong
      // password attempts, so the backend must persist a trustworthy counter.
    },
    lastFailedLoginAt: {
      type: Date,
      default: null,
      // WHY: The last failure timestamp keeps reset-eligibility changes
      // auditable without exposing raw password values anywhere.
    },
    passwordResetCodeHash: {
      type: String,
      default: "",
      trim: true,
      select: false,
      // WHY: Reset codes must never be stored in plain text because email
      // delivery is a recovery boundary, not a second password store.
    },
    passwordResetCodeExpiresAt: {
      type: Date,
      default: null,
      select: false,
      // WHY: Email reset codes need a short validity window so stale inbox
      // copies cannot keep reopening account access indefinitely.
    },
    passwordResetLastSentAt: {
      type: Date,
      default: null,
      // WHY: Recovery emails are security-sensitive, so the last send time
      // must stay visible for audit and anti-spam checks.
    },
    loginDayCount: {
      type: Number,
      default: 0,
      min: 0,
      // WHY: Login-day tracking supports ADHD-friendly continuity without
      // conflating attendance with assessment completion.
    },
    lastDailyLoginXpDateKey: {
      type: String,
      default: "",
      trim: true,
      // WHY: Daily login XP is once per calendar day, so the awarded date key
      // must be persisted to keep bonus grants idempotent across sessions.
    },
    lastDailyLoginXpAwardedAt: {
      type: Date,
      default: null,
      // WHY: The bonus timestamp keeps the daily login reward auditable even
      // though it is no longer attached to a lesson session row.
    },
    preferredDifficulty: {
      type: String,
      enum: ["easy", "medium", "hard"],
      default: "medium",
    },
    isArchived: {
      type: Boolean,
      default: false,
      index: true,
      // WHY: Archived students must disappear from active login and staff
      // pickers without deleting their audit history or result evidence.
    },
    archivedAt: {
      type: Date,
      default: null,
    },
    archivedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      // WHY: Student archiving changes who can access timetable and result
      // flows, so the staff account that archived the learner must be traceable.
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
