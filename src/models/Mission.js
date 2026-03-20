/**
 * WHAT:
 * Mission stores teacher-authored or bank-backed lesson activities assigned to
 * a student for a specific subject, date, and timetable slot.
 * WHY:
 * The current mission flow is still active while the frozen criterion-based
 * progression system is being built, so this model needs explicit boundaries.
 * HOW:
 * Save date-scoped draft and published missions with teach-first question
 * content so teachers can prepare work ahead of the scheduled lesson.
 */
const mongoose = require("mongoose");

const missionQuestionSchema = new mongoose.Schema(
  {
    answerMode: {
      type: String,
      enum: ["multiple_choice", "short_answer"],
      default: "multiple_choice",
      trim: true,
      // WHY: Theory missions use teacher-reviewed short answers while the
      // standard mission flow still uses multiple-choice questions.
    },
    learningText: {
      type: String,
      default: "",
      trim: true,
      // WHY: Missions teach before questioning so the student answers from
      // taught content instead of being tested on untaught knowledge.
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
          if (this.answerMode === "short_answer") {
            // WHY: Theory questions are written responses, so they do not store
            // A/B/C/D options in persistence.
            return Array.isArray(value) && value.length === 0;
          }
          return Array.isArray(value) && value.length === 4;
        },
        message:
          "Mission questions must include exactly four answer options unless they are short-answer theory questions.",
      },
    },
    correctIndex: {
      type: Number,
      default: -1,
      validate: {
        validator(value) {
          if (this.answerMode === "short_answer") {
            return Number(value) === -1;
          }
          return Number.isInteger(value) && value >= 0 && value <= 3;
        },
        message:
          "Mission questions must use a correctIndex between 0 and 3 unless they are short-answer theory questions.",
      },
    },
    explanation: {
      type: String,
      default: "",
      trim: true,
    },
    expectedAnswer: {
      type: String,
      default: "",
      trim: true,
      // WHY: Theory answers need teacher-authored success criteria so result
      // review stays auditable without forcing brittle auto-marking.
    },
    minWordCount: {
      type: Number,
      min: 0,
      max: 500,
      default: 0,
      // WHY: Teachers set a short-answer word expectation per theory question
      // so students know the minimum depth required before progression.
    },
  },
  { _id: false },
);

const missionSchema = new mongoose.Schema(
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
      index: true,
    },
    sessionType: {
      type: String,
      enum: ["morning", "afternoon"],
      required: true,
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
      // WHY: Teachers need to re-open the exact full extracted upload text
      // later (not only a task-scoped subset) when editing or regenerating.
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
    draftFormat: {
      type: String,
      enum: ["QUESTIONS", "THEORY", "ESSAY_BUILDER"],
      default: "QUESTIONS",
      // WHY: Daily missions can be standard questions, fast-focus theory
      // checks, or essay-builder drafts, and the frontend must know which
      // rendering path to use.
    },
    essayMode: {
      type: String,
      enum: ["NORMAL", "STRETCH_15", "STRETCH_20"],
      default: null,
      // WHY: Essay builder missions use a fixed teacher-selected matrix mode so
      // generated sentence/word targets remain explicit and auditable.
    },
    draftJson: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
      // WHY: Essay builder drafts store the Groq JSON payload as-is so the
      // student experience can render the exact A/B/C/D sentence structure.
    },
    source: {
      type: String,
      enum: ["groq", "bank"],
      default: "groq",
    },
    status: {
      type: String,
      enum: ["draft", "published"],
      default: "draft",
      index: true,
      // WHY: Teacher review must happen before a student can access AI-assisted
      // content, so missions cannot skip the draft state.
    },
    aiModel: {
      type: String,
      default: "",
      trim: true,
    },
    publishedAt: {
      type: Date,
      default: null,
    },
    availableOnDate: {
      type: String,
      default: "",
      trim: true,
      index: true,
      // WHY: A mission should only surface on the exact lesson date it was
      // prepared for, even if the teacher drafted it earlier.
    },
    availableOnDay: {
      type: String,
      default: "",
      trim: true,
    },
    difficulty: {
      type: String,
      enum: ["easy", "medium", "hard"],
      default: "medium",
    },
    taskCodes: {
      type: [String],
      default: [],
      validate: {
        validator(value) {
          return (
            Array.isArray(value) &&
            value.length <= 8 &&
            value.every((item) => /^[PMD]\d+$/i.test(String(item || "").trim()))
          );
        },
        message: "Task codes must be like P1, P2, M1, or D1.",
      },
      // WHY: Teachers need explicit task targeting (for example P1/P2) so the
      // generated mission assesses the selected qualification criteria.
    },
    certificationPlanId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "StudentCertificationPlan",
      default: null,
      // WHY: Certification evidence must point back to the exact active plan
      // version the teacher used when authoring the mission.
    },
    certificationPlanVersion: {
      type: Number,
      min: 0,
      default: 0,
      // WHY: Version snapshots stop later plan edits from silently changing the
      // qualification meaning of already-assigned missions.
    },
    certificationPlanSource: {
      type: String,
      enum: ["none", "teacher_plan", "subject_template"],
      default: "none",
      trim: true,
      // WHY: Older missions may still fall back to subject templates, so the
      // snapshot must record which certification source was active.
    },
    certificationLabelSnapshot: {
      type: String,
      default: "",
      trim: true,
    },
    certificationRequiredTaskCodesSnapshot: {
      type: [String],
      default: [],
      validate: {
        validator(value) {
          return (
            Array.isArray(value) &&
            value.every((item) => /^[PMD]\d+$/i.test(String(item || "").trim()))
          );
        },
        message:
          "certificationRequiredTaskCodesSnapshot must use task codes like P1, P2, M1, or D1.",
      },
      // WHY: Mission-level snapshots preserve the exact required objective set
      // used at author time even if the live student plan changes later.
    },
    xpReward: {
      type: Number,
      min: 10,
      max: 50,
      default: 20,
      // WHY: Teacher-authored missions should carry an explicit reward so the
      // earned XP matches the planned effort instead of always using one fixed value.
    },
    manualResultOnly: {
      type: Boolean,
      default: false,
      index: true,
      // WHY: Teacher-uploaded offline results need a lesson-linked mission id
      // for audit history without surfacing as a playable student mission.
    },
    latestScoreCorrect: {
      type: Number,
      min: 0,
      default: 0,
      // WHY: Assigned-mission progress needs a persisted correct-answer count
      // so teacher dashboards can show score state without recomputing from text.
    },
    latestScoreTotal: {
      type: Number,
      min: 0,
      default: 0,
      // WHY: Persisting score denominator keeps score labels stable (for
      // example 0/8) even before a student has completed the mission.
    },
    latestScorePercent: {
      type: Number,
      min: 0,
      max: 100,
      default: 0,
    },
    latestXpEarned: {
      type: Number,
      min: 0,
      default: 0,
      // WHY: XP for assigned missions is score-based, so each mission must
      // keep the last earned XP value for panel and card progress rendering.
    },
    latestResultPackageId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ResultPackage",
      default: null,
      // WHY: Teachers need one-click access to the newest auditable result
      // package linked to this mission from the session dashboard.
    },
    questions: {
      type: [missionQuestionSchema],
      default: [],
      validate: {
        validator(value) {
          if (this.draftFormat === "ESSAY_BUILDER") {
            return Array.isArray(value);
          }
          if (this.draftFormat === "THEORY") {
            // WHY: Theory is intentionally a short fast-focus format, so saved
            // drafts must remain between 2 and 5 short-answer questions.
            return Array.isArray(value) && value.length >= 2 && value.length <= 5;
          }
          return Array.isArray(value) && value.length > 0 && value.length <= 10;
        },
        message:
          "Mission must include 2 to 5 theory questions or 1 to 10 standard questions.",
      },
      // WHY: Missions stay intentionally bounded so the flow remains suitable
      // for attention support and does not overwhelm the learner.
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  {
    timestamps: true,
  },
);

missionSchema.index({
  studentId: 1,
  subjectId: 1,
  sessionType: 1,
  status: 1,
  createdAt: -1,
});

module.exports = mongoose.model("Mission", missionSchema);
