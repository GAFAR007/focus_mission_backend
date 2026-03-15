/**
 * WHAT:
 * teacher.service handles teacher-owned timetable, mission, and criterion
 * authoring workflows.
 * WHY:
 * Stage 7 keeps AI as a draft-only assistant, so teachers need one service
 * boundary that enforces subject ownership, review-before-save, and safe
 * approval of criterion content.
 * HOW:
 * Validate teacher authority, generate unsaved drafts with Groq, and only
 * persist approved learning content and blocks when the teacher explicitly
 * approves the draft.
 */
const Block = require("../models/Block");
const Criterion = require("../models/Criterion");
const LearningContent = require("../models/LearningContent");
const Mission = require("../models/Mission");
const SessionLog = require("../models/SessionLog");
const StudentProgress = require("../models/StudentProgress");
const Subject = require("../models/Subject");
const Timetable = require("../models/Timetable");
const Unit = require("../models/Unit");
const User = require("../models/User");
const {
  generateLearningAndBlocksWithGroq,
  generateEssayBuilderDraft,
  generateMissionWithGroq,
  planUnitFromSourceWithGroq,
} = require("./groq.service");
const {
  ensureResultPackageForMission,
} = require("./result.service");
const subjectCertificationService = require("./subjectCertification.service");
const {
  extractTextFromUploadedSource,
} = require("./sourceExtraction.service");
const { serializeMission } = require("../utils/missionSerializer");
const { serializeJourney } = require("../utils/userJourney");
const {
  clampNumber,
  getDateKey,
  getNow,
  resolveMissionRewardPolicy,
} = require("../utils/xpPolicy");

const DRAFT_MISSIONS_LIMIT = 5;
const RECENT_MISSIONS_HISTORY_LIMIT = 50;
const THEORY_QUESTION_COUNT_MIN = 2;
const THEORY_QUESTION_COUNT_MAX = 5;
const WEEKDAY_OPTIONS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];

function createError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function getCurrentDay() {
  return new Intl.DateTimeFormat("en-US", { weekday: "long" }).format(getNow());
}

function getCurrentDateKey() {
  return getDateKey(getNow());
}

function parseDateKey(dateKey) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey || "").trim());

  if (!match) {
    throw createError(400, "targetDate must use YYYY-MM-DD format.");
  }

  const [, year, month, day] = match;
  const parsed = new Date(Number(year), Number(month) - 1, Number(day));

  if (
    parsed.getFullYear() !== Number(year) ||
    parsed.getMonth() !== Number(month) - 1 ||
    parsed.getDate() !== Number(day)
  ) {
    throw createError(400, "targetDate is not a valid calendar date.");
  }

  return parsed;
}

function getWeekdayFromDateKey(dateKey) {
  return new Intl.DateTimeFormat("en-US", { weekday: "long" }).format(
    parseDateKey(dateKey),
  );
}

function assertDateIsTodayOrFuture(dateKey) {
  if (String(dateKey) < getCurrentDateKey()) {
    throw createError(
      400,
      "Teachers can only prepare missions for today or an upcoming class date.",
    );
  }
}

function normalizeForMatch(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function collectSubjectIdsForTeacherTimetables({ timetables, teacherId }) {
  const subjectIds = new Set();
  const normalizedTeacherId = String(teacherId || "").trim();

  for (const timetable of Array.isArray(timetables) ? timetables : []) {
    if (
      String(timetable?.morningTeacherId || "").trim() === normalizedTeacherId
    ) {
      const subjectId = String(timetable?.morningSubject || "").trim();
      if (subjectId) {
        subjectIds.add(subjectId);
      }
    }

    if (
      String(timetable?.afternoonTeacherId || "").trim() === normalizedTeacherId
    ) {
      const subjectId = String(timetable?.afternoonSubject || "").trim();
      if (subjectId) {
        subjectIds.add(subjectId);
      }
    }
  }

  return [...subjectIds];
}

function isPlaceholderOption(value) {
  return ["a", "b", "c", "d"].includes(normalizeForMatch(value));
}

function countWords(value) {
  return String(value || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

function normalizeQuestionCount(value, { draftFormat = "QUESTIONS" } = {}) {
  const parsed = Number(value);
  const normalizedDraftFormat = String(draftFormat || "QUESTIONS")
    .trim()
    .toUpperCase();

  if (!Number.isInteger(parsed)) {
    throw createError(400, "Question count must be a whole number.");
  }

  if (normalizedDraftFormat === "ESSAY_BUILDER") {
    // WHY: Essay builder does not use the question count contract, so the
    // request should not fail just because the teacher switched formats.
    return parsed > 0 ? parsed : 5;
  }

  if (normalizedDraftFormat === "THEORY") {
    if (
      parsed < THEORY_QUESTION_COUNT_MIN ||
      parsed > THEORY_QUESTION_COUNT_MAX
    ) {
      throw createError(400, "Theory question count must be between 2 and 5.");
    }

    return parsed;
  }

  if (![5, 8, 10].includes(parsed)) {
    throw createError(400, "Question count must be 5, 8, or 10.");
  }

  return parsed;
}

function normalizeTaskCodes(taskCodes) {
  if (taskCodes === undefined) {
    return [];
  }

  if (!Array.isArray(taskCodes)) {
    throw createError(400, "Task codes must be provided as an array.");
  }

  if (taskCodes.length > 8) {
    throw createError(400, "Select up to 8 task codes.");
  }

  const normalized = taskCodes
    .map((value) => String(value || "").trim().toUpperCase())
    .filter(Boolean);

  if (!normalized.every((value) => /^[PMD]\d+$/.test(value))) {
    throw createError(400, "Task codes must be like P1, P2, M1, or D1.");
  }

  return [...new Set(normalized)];
}

function normalizeDraftFormat(value) {
  const normalized = String(value || "").trim().toUpperCase();

  if (!normalized) {
    return "QUESTIONS";
  }

  // WHY: Draft format must be explicit so the backend can safely switch
  // generation paths without guessing the teacher's intent.
  if (!["QUESTIONS", "THEORY", "ESSAY_BUILDER"].includes(normalized)) {
    throw createError(
      400,
      "Draft format must be QUESTIONS, THEORY, or ESSAY_BUILDER.",
    );
  }

  return normalized;
}

async function loadMissionCertificationSnapshot({ studentId, subjectId }) {
  const settingsContext =
    await subjectCertificationService.getStudentSubjectCertificationContext({
      studentId,
      subjectId,
    });

  return subjectCertificationService.buildMissionCertificationSnapshot(
    settingsContext,
  );
}

const ESSAY_MODE_OPTIONS = ["NORMAL", "STRETCH_15", "STRETCH_20"];

function normalizeEssayMode(value, { required = false } = {}) {
  const normalized = String(value || "").trim().toUpperCase();
  if (!normalized) {
    if (required) {
      throw createError(
        400,
        "essayMode is required when draftFormat is ESSAY_BUILDER.",
      );
    }
    return "NORMAL";
  }

  // WHY: Essay mode selects the teacher's fixed daily matrix workload, so only
  // approved mode keys can drive the AI generation prompt.
  if (!ESSAY_MODE_OPTIONS.includes(normalized)) {
    throw createError(
      400,
      "Essay mode must be NORMAL, STRETCH_15, or STRETCH_20.",
    );
  }

  return normalized;
}

function buildTheoryQuestionsFromGenerated(questions) {
  return normalizeQuestions(
    (Array.isArray(questions) ? questions : []).map((question) => {
      const options = Array.isArray(question?.options)
        ? question.options.map((option) => String(option || "").trim())
        : [];
      const correctIndex = Number(question?.correctIndex);
      const correctAnswer = Number.isInteger(correctIndex) &&
          correctIndex >= 0 &&
          correctIndex < options.length
        ? options[correctIndex]
        : "";

      return {
        answerMode: "short_answer",
        learningText: String(
          question?.learningText || question?.explanation || "",
        ).trim(),
        prompt: String(question?.prompt || "").trim(),
        expectedAnswer: String(
          correctAnswer || question?.explanation || "",
        ).trim(),
        minWordCount: 12,
        explanation: String(question?.explanation || "").trim(),
        options: [],
        correctIndex: -1,
      };
    }),
    { draftFormat: "THEORY" },
  );
}

function normalizeQuestions(
  questions,
  { draftFormat = "QUESTIONS" } = {},
) {
  const normalizedDraftFormat = normalizeDraftFormat(draftFormat);

  if (!Array.isArray(questions) || questions.length < 1 || questions.length > 10) {
    throw createError(400, "Mission drafts must include between 1 and 10 questions.");
  }

  if (normalizedDraftFormat === "THEORY") {
    if (
      questions.length < THEORY_QUESTION_COUNT_MIN ||
      questions.length > THEORY_QUESTION_COUNT_MAX
    ) {
      throw createError(
        400,
        "Theory drafts must include between 2 and 5 questions.",
      );
    }

    return questions.map((question, index) => {
      const learningText = String(question?.learningText || "").trim();
      const prompt = String(question?.prompt || "").trim();
      const expectedAnswer = String(question?.expectedAnswer || "").trim();
      const minWordCount = Number(question?.minWordCount);
      const explanation = String(question?.explanation || "").trim();

      if (!learningText) {
        throw createError(
          400,
          `Theory question ${index + 1} needs Learn First guidance.`,
        );
      }

      if (!prompt) {
        throw createError(400, `Theory question ${index + 1} needs a prompt.`);
      }

      if (!expectedAnswer) {
        throw createError(
          400,
          `Theory question ${index + 1} needs an expected answer for teacher review.`,
        );
      }

      if (!Number.isInteger(minWordCount) || minWordCount < 1 || minWordCount > 500) {
        throw createError(
          400,
          `Theory question ${index + 1} needs a minimum word count between 1 and 500.`,
        );
      }

      return {
        answerMode: "short_answer",
        learningText,
        prompt,
        options: [],
        correctIndex: -1,
        explanation,
        expectedAnswer,
        minWordCount,
      };
    });
  }

  return questions.map((question, index) => {
    const learningText = String(question?.learningText || "").trim();
    const prompt = String(question?.prompt || "").trim();
    const options = Array.isArray(question?.options)
      ? question.options.map((option) => String(option || "").trim())
      : [];
    const correctIndex = Number(question?.correctIndex);
    const explanation = String(question?.explanation || "").trim();

    if (!learningText) {
      throw createError(
        400,
        `Question ${index + 1} needs a short teaching note before the question.`,
      );
    }

    if (!prompt) {
      throw createError(400, `Question ${index + 1} needs a prompt.`);
    }

    if (options.length !== 4 || options.some((option) => !option)) {
      throw createError(
        400,
        `Question ${index + 1} needs exactly four answer options.`,
      );
    }

    if (options.some((option) => isPlaceholderOption(option))) {
      throw createError(
        400,
        `Question ${index + 1} needs full answer options, not placeholder letters.`,
      );
    }

    if (new Set(options.map(normalizeForMatch)).size !== 4) {
      throw createError(
        400,
        `Question ${index + 1} needs four distinct answer options.`,
      );
    }

    if (!Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex > 3) {
      throw createError(
        400,
        `Question ${index + 1} must have a correct answer between 0 and 3.`,
      );
    }

    return {
      answerMode: "multiple_choice",
      learningText,
      prompt,
      options,
      correctIndex,
      explanation,
      expectedAnswer: "",
      minWordCount: 0,
    };
  });
}

function haveDraftOptionsChanged(previousQuestion, nextQuestion) {
  const previousOptions = Array.isArray(previousQuestion?.options)
    ? previousQuestion.options
    : [];
  const nextOptions = Array.isArray(nextQuestion?.options)
    ? nextQuestion.options
    : [];

  if (previousOptions.length !== nextOptions.length) {
    return true;
  }

  return nextOptions.some(
    (option, index) =>
      normalizeForMatch(option) !==
      normalizeForMatch(previousOptions[index]),
  );
}

function hasDraftCorrectAnswerChanged(previousQuestion, nextQuestion) {
  const previousOptions = Array.isArray(previousQuestion?.options)
    ? previousQuestion.options
    : [];
  const nextOptions = Array.isArray(nextQuestion?.options)
    ? nextQuestion.options
    : [];
  const previousCorrectIndex = Number(previousQuestion?.correctIndex);
  const nextCorrectIndex = Number(nextQuestion?.correctIndex);
  const previousCorrectAnswer =
    Number.isInteger(previousCorrectIndex) &&
    previousCorrectIndex >= 0 &&
    previousCorrectIndex < previousOptions.length ?
      previousOptions[previousCorrectIndex]
    : "";
  const nextCorrectAnswer =
    Number.isInteger(nextCorrectIndex) &&
    nextCorrectIndex >= 0 &&
    nextCorrectIndex < nextOptions.length ?
      nextOptions[nextCorrectIndex]
    : "";

  return (
    previousCorrectIndex !== nextCorrectIndex ||
    normalizeForMatch(previousCorrectAnswer) !==
      normalizeForMatch(nextCorrectAnswer)
  );
}

function enforceLearnFirstReviewDependencies(
  previousQuestions,
  nextQuestions,
  { draftFormat = "QUESTIONS" } = {},
) {
  const normalizedDraftFormat = normalizeDraftFormat(draftFormat);
  const compareCount = Math.min(
    Array.isArray(previousQuestions) ? previousQuestions.length : 0,
    Array.isArray(nextQuestions) ? nextQuestions.length : 0,
  );

  for (let index = 0; index < compareCount; index += 1) {
    const previousQuestion = previousQuestions[index] || {};
    const nextQuestion = nextQuestions[index] || {};
    const previousLearningText = normalizeForMatch(
      previousQuestion.learningText,
    );
    const nextLearningText = normalizeForMatch(nextQuestion.learningText);

    if (
      !previousLearningText ||
      !nextLearningText ||
      previousLearningText === nextLearningText
    ) {
      continue;
    }

    // WHY: Once the teaching note changes, the linked question must be revised
    // too, otherwise the student can see stale prompts and answers that no
    // longer match the updated instruction.
    if (
      normalizeForMatch(previousQuestion.prompt) ===
      normalizeForMatch(nextQuestion.prompt)
    ) {
      throw createError(
        400,
        normalizedDraftFormat === "THEORY" ?
          `Theory question ${index + 1} changed Learn First, so the prompt must be updated too.`
        : `Question ${index + 1} changed Learn First, so the prompt must be updated too.`,
      );
    }

    if (normalizedDraftFormat === "THEORY") {
      if (
        normalizeForMatch(previousQuestion.expectedAnswer) ===
        normalizeForMatch(nextQuestion.expectedAnswer)
      ) {
        throw createError(
          400,
          `Theory question ${index + 1} changed Learn First, so the expected answer must be updated too.`,
        );
      }
      continue;
    }

    if (!haveDraftOptionsChanged(previousQuestion, nextQuestion)) {
      throw createError(
        400,
        `Question ${index + 1} changed Learn First, so the answer options must be updated too.`,
      );
    }

    if (!hasDraftCorrectAnswerChanged(previousQuestion, nextQuestion)) {
      throw createError(
        400,
        `Question ${index + 1} changed Learn First, so the correct answer must be updated too.`,
      );
    }
  }
}

function normalizeLearningSections(sections) {
  if (!Array.isArray(sections) || sections.length < 2) {
    throw createError(400, "Learning content must include at least two sections.");
  }

  return sections.map((section, index) => {
    const body = String(section?.body || "").trim();

    if (!body) {
      throw createError(
        400,
        `Learning section ${index + 1} needs body text.`,
      );
    }

    return {
      heading: String(section?.heading || `Section ${index + 1}`).trim(),
      body,
      baseOrder: index,
    };
  });
}

function normalizeLearningCheckBlocks(blocks, taughtText) {
  if (!Array.isArray(blocks) || blocks.length < 3) {
    throw createError(400, "LearningCheck must include at least three blocks.");
  }

  return blocks.map((block, index) => {
    const prompt = String(block?.prompt || "").trim();
    const options = Array.isArray(block?.options)
      ? block.options.map((option) => String(option || "").trim()).filter(Boolean)
      : [];
    const correctIndex = Number(block?.correctIndex);

    if (!prompt) {
      throw createError(
        400,
        `LearningCheck block ${index + 1} needs a prompt.`,
      );
    }

    if (options.length !== 4) {
      throw createError(
        400,
        `LearningCheck block ${index + 1} needs exactly four options.`,
      );
    }

    if (options.some((option) => isPlaceholderOption(option))) {
      throw createError(
        400,
        `LearningCheck block ${index + 1} uses placeholder answers.`,
      );
    }

    if (new Set(options.map(normalizeForMatch)).size !== 4) {
      throw createError(
        400,
        `LearningCheck block ${index + 1} needs four distinct options.`,
      );
    }

    if (!Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex > 3) {
      throw createError(
        400,
        `LearningCheck block ${index + 1} needs a correctIndex between 0 and 3.`,
      );
    }

    // WHY: Knowledge-check answers must come from taught content, not outside
    // knowledge, so the approval boundary validates the learning-to-check link.
    if (!normalizeForMatch(taughtText).includes(normalizeForMatch(options[correctIndex]))) {
      throw createError(
        400,
        `LearningCheck block ${index + 1} tests content that is not explicitly taught.`,
      );
    }

    return {
      type: "multipleChoice",
      phase: "learningCheck",
      prompt,
      options,
      correctIndex,
      generatedSentence: "",
      baseOrder: index,
      isRequired: true,
    };
  });
}

function normalizeEssayBuilderBlocks(blocks, requiredWordCount) {
  if (!Array.isArray(blocks) || blocks.length < 3) {
    throw createError(400, "EssayBuilder must include at least three blocks.");
  }

  const normalized = blocks.map((block, index) => {
    const prompt = String(block?.prompt || "").trim();
    const generatedSentence = String(block?.generatedSentence || "").trim();
    const type = String(block?.type || "").trim() || "sentenceBuilder";

    if (!prompt) {
      throw createError(
        400,
        `EssayBuilder block ${index + 1} needs a prompt.`,
      );
    }

    if (!generatedSentence) {
      throw createError(
        400,
        `EssayBuilder block ${index + 1} needs a generatedSentence.`,
      );
    }

    return {
      type,
      phase: "essayBuilder",
      prompt,
      options: [],
      correctIndex: -1,
      generatedSentence,
      baseOrder: index,
      isRequired: true,
    };
  });

  const generatedWordCount = normalized.reduce(
    (sum, block) => sum + countWords(block.generatedSentence),
    0,
  );

  // WHY: EssayBuilder drafts must already be sufficient for the criterion word
  // threshold so the teacher is reviewing a usable scaffold, not an empty shell.
  if (generatedWordCount < requiredWordCount) {
    throw createError(
      400,
      `EssayBuilder draft only supports ${generatedWordCount} words, below the required ${requiredWordCount}.`,
    );
  }

  return normalized;
}

function normalizeApprovedCriterionDraft(payload, criterion) {
  const learningContentTitle = String(payload?.learningContent?.title || "").trim();

  if (!learningContentTitle) {
    throw createError(400, "Learning content title is required.");
  }

  const sections = normalizeLearningSections(payload?.learningContent?.sections);
  const taughtText = sections.map((section) => section.body).join(" ");

  return {
    learningContent: {
      title: learningContentTitle,
      summary: String(payload?.learningContent?.summary || "").trim(),
      sections,
    },
    learningCheckBlocks: normalizeLearningCheckBlocks(
      payload?.learningCheckBlocks,
      taughtText,
    ),
    essayBuilderBlocks: normalizeEssayBuilderBlocks(
      payload?.essayBuilderBlocks,
      criterion.requiredWordCount,
    ),
  };
}

function serializeCriterionDraft({
  criterion,
  subject,
  unit,
  learningContent,
  learningCheckBlocks,
  essayBuilderBlocks,
  aiModel = null,
}) {
  return {
    criterion: {
      id: String(criterion._id || criterion.id),
      title: criterion.title,
      description: criterion.description,
      requiredWordCount: criterion.requiredWordCount,
      learningPassRate: criterion.learningPassRate,
    },
    subject: subject
      ? {
          id: String(subject._id || subject.id),
          name: subject.name,
          icon: subject.icon,
          color: subject.color,
        }
      : null,
    unit: unit
      ? {
          id: String(unit._id || unit.id),
          title: unit.title,
          description: unit.description,
          baseOrder: unit.baseOrder,
        }
      : null,
    source: "groq",
    aiModel,
    learningContent,
    learningCheckBlocks,
    essayBuilderBlocks,
  };
}

async function loadCriterionAuthoringContext(criterionId) {
  const criterion = await Criterion.findById(criterionId).lean();

  if (!criterion) {
    throw createError(404, "Criterion not found.");
  }

  const [subject, unit] = await Promise.all([
    Subject.findById(criterion.subjectId).lean(),
    Unit.findById(criterion.unitId).lean(),
  ]);

  if (!subject || !unit) {
    throw createError(404, "Criterion subject or unit could not be loaded.");
  }

  return { criterion, subject, unit };
}

async function assertTeacherOwnsCriterionSubject(teacherId, context) {
  const teacher = await User.findOne({
    _id: teacherId,
    role: "teacher",
  })
    .select("name subjectSpecialty")
    .lean();

  if (!teacher) {
    throw createError(404, "Teacher not found.");
  }

  if (
    normalizeForMatch(teacher.subjectSpecialty) !==
    normalizeForMatch(context.subject.name)
  ) {
    throw createError(
      403,
      "Only the teacher responsible for this subject can generate or approve this criterion draft.",
    );
  }

  return teacher;
}

async function assertCriterionApprovalIsSafe(criterionId) {
  const startedProgress = await StudentProgress.findOne({
    criterionId,
    $or: [
      { learningCompletedAt: { $ne: null } },
      { attemptsUsed: { $gt: 0 } },
      { essayBuilderUnlockedAt: { $ne: null } },
      { wordCount: { $gt: 0 } },
      { submittedAt: { $ne: null } },
      { approvedAt: { $ne: null } },
      { revisionRequestedAt: { $ne: null } },
      { xpAwarded: { $gt: 0 } },
      { completed: true },
      { criterionState: { $ne: "learning_required" } },
      { learningStatus: { $ne: "pending" } },
    ],
  })
    .select("_id")
    .lean();

  // WHY: Approving a new shared criterion draft after students have started it
  // would silently change an assessed pathway mid-progress, so approval stops here.
  if (startedProgress) {
    throw createError(
      409,
      "This criterion already has learner progress, so the draft cannot be approved safely.",
    );
  }
}

async function assertTeacherOwnsScheduledLesson({
  teacherId,
  studentId,
  subjectId,
  sessionType,
  targetDate,
}) {
  assertDateIsTodayOrFuture(targetDate);
  const targetDay = getWeekdayFromDateKey(targetDate);
  const timetable = await Timetable.findOne({
    studentId,
    day: targetDay,
  }).lean();

  if (!timetable) {
    throw createError(
      403,
      "This student does not have a timetable entry for that date, so no mission can be created.",
    );
  }

  const scheduledSubjectId =
    sessionType === "morning" ? timetable.morningSubject : timetable.afternoonSubject;
  const scheduledTeacherId =
    sessionType === "morning"
      ? timetable.morningTeacherId
      : timetable.afternoonTeacherId;

  if (!scheduledSubjectId || String(scheduledSubjectId) !== String(subjectId)) {
    throw createError(
      403,
      "Teachers can only generate missions for the subject scheduled in that lesson slot on the selected date.",
    );
  }

  if (!scheduledTeacherId || String(scheduledTeacherId) !== String(teacherId)) {
    throw createError(
      403,
      "Only the teacher assigned to this student's subject on the selected date can generate that mission.",
    );
  }

  return {
    availableOnDay: targetDay,
    availableOnDate: targetDate,
  };
}

async function listStudents(teacherId) {
  const teacher = await User.findOne({
    _id: teacherId,
    role: "teacher",
  })
    .select("assignedStudents")
    .lean();

  if (!teacher) {
    throw createError(404, "Teacher not found.");
  }

  const assignedStudentIds = Array.isArray(teacher.assignedStudents)
    ? teacher.assignedStudents
        .map((studentId) => String(studentId || "").trim())
        .filter(Boolean)
    : [];

  if (assignedStudentIds.length === 0) {
    // WHY: Teachers should only bootstrap into students they actually own. An
    // empty list is a valid state and should render the frontend empty-state
    // instead of leaking other students into the picker.
    return [];
  }

  return User.find({
    _id: { $in: assignedStudentIds },
    role: "student",
  })
    .sort({ name: 1 })
    .select(
      "name role avatar avatarSeed xp streak preferredDifficulty firstLoginAt lastLoginAt loginDayCount",
    )
    .lean();
}

async function listSubjects(teacherId) {
  const teacher = await User.findOne({
    _id: teacherId,
    role: "teacher",
  })
    .select("assignedStudents subjectSpecialty")
    .lean();

  if (!teacher) {
    throw createError(404, "Teacher not found.");
  }

  const assignedStudentIds = Array.isArray(teacher.assignedStudents)
    ? teacher.assignedStudents
        .map((studentId) => String(studentId || "").trim())
        .filter(Boolean)
    : [];

  if (assignedStudentIds.length > 0) {
    const timetableEntries = await Timetable.find({
      studentId: { $in: assignedStudentIds },
      $or: [
        { morningTeacherId: teacherId },
        { afternoonTeacherId: teacherId },
      ],
    })
      .select(
        "morningSubject afternoonSubject morningTeacherId afternoonTeacherId",
      )
      .lean();
    const subjectIds = collectSubjectIdsForTeacherTimetables({
      timetables: timetableEntries,
      teacherId,
    });

    if (subjectIds.length > 0) {
      // WHY: The timetable is the live ownership source for teacher lesson
      // slots, so teacher subject access should prefer actual timetable
      // assignments over free-text specialty labels.
      return Subject.find({
        _id: { $in: subjectIds },
      })
        .sort({ name: 1 })
        .select("name icon color")
        .lean();
    }
  }

  const specialty = normalizeForMatch(teacher.subjectSpecialty);
  if (!specialty) {
    // WHY: Teachers should only edit timetable slots for their own subject.
    // Returning an empty list is safer than exposing the full subject catalog
    // when a teacher account has no specialty configured.
    return [];
  }

  const subjects = await Subject.find({})
    .sort({ name: 1 })
    .select("name icon color")
    .lean();

  return subjects.filter(
    (subject) => normalizeForMatch(subject.name) === specialty,
  );
}

async function createTimetable(payload) {
  return Timetable.create(payload);
}

async function assertTeacherOwnsStudent(teacherId, studentId) {
  const teacher = await User.findOne({
    _id: teacherId,
    role: "teacher",
  })
    .select("assignedStudents subjectSpecialty")
    .lean();

  if (!teacher) {
    throw createError(404, "Teacher not found.");
  }

  const assignedStudentIds = Array.isArray(teacher.assignedStudents)
    ? teacher.assignedStudents.map((value) => String(value || "").trim())
    : [];

  // WHY: Teacher timetable editing must stay scoped to the teacher's own
  // caseload so clicking around the calendar never mutates another teacher's
  // student by accident.
  if (!assignedStudentIds.includes(String(studentId))) {
    throw createError(403, "Teachers can only edit timetable slots for assigned students.");
  }

  return teacher;
}

function serializeTimetableEntry(entry) {
  return {
    day: String(entry.day || ""),
    room: String(entry.room || ""),
    morningMission: entry.morningSubject,
    afternoonMission: entry.afternoonSubject,
    morningTeacher: entry.morningTeacherId || null,
    afternoonTeacher: entry.afternoonTeacherId || null,
  };
}

async function updateTimetableSlot({ teacherId, studentId, payload }) {
  const day = String(payload.day || "").trim();
  const sessionType = String(payload.sessionType || "")
    .trim()
    .toLowerCase();
  const subjectId = String(payload.subjectId || "").trim();
  const room = String(payload.room || "").trim();

  if (!WEEKDAY_OPTIONS.includes(day)) {
    throw createError(400, "Timetable day must be Monday to Friday.");
  }

  if (!["morning", "afternoon"].includes(sessionType)) {
    throw createError(400, "sessionType must be morning or afternoon.");
  }

  if (!room) {
    throw createError(400, "Room is required.");
  }

  const teacher = await assertTeacherOwnsStudent(teacherId, studentId);
  const subject = await Subject.findById(subjectId)
    .select("name icon color")
    .lean();

  if (!subject) {
    throw createError(404, "Subject not found.");
  }

  const teacherSpecialty = normalizeForMatch(teacher.subjectSpecialty);
  const subjectName = normalizeForMatch(subject.name);

  // WHY: Teachers may only place their own specialty into a slot. Management
  // remains responsible for assigning other teachers or unrelated subjects.
  if (!teacherSpecialty || subjectName !== teacherSpecialty) {
    throw createError(
      403,
      "Teachers can only add or edit timetable subjects that match their own specialty.",
    );
  }

  const timetable = await Timetable.findOne({
    studentId,
    day,
  });

  if (!timetable) {
    // WHY: The timetable schema requires both weekday slots. Management owns
    // the initial weekday setup, while teachers safely refine an existing slot.
    throw createError(
      409,
      "Management must create this weekday timetable before teachers edit lesson slots.",
    );
  }

  if (sessionType === "morning") {
    const assignedTeacherId = String(timetable.morningTeacherId || "").trim();
    if (assignedTeacherId && assignedTeacherId !== String(teacherId)) {
      throw createError(403, "Morning lesson is already assigned to another teacher.");
    }
    timetable.morningSubject = subjectId;
    timetable.morningTeacherId = teacherId;
  } else {
    const assignedTeacherId = String(timetable.afternoonTeacherId || "").trim();
    if (assignedTeacherId && assignedTeacherId !== String(teacherId)) {
      throw createError(403, "Afternoon lesson is already assigned to another teacher.");
    }
    timetable.afternoonSubject = subjectId;
    timetable.afternoonTeacherId = teacherId;
  }

  timetable.room = room;
  await timetable.save();

  const saved = await Timetable.findById(timetable._id)
    .populate("morningSubject", "name icon color")
    .populate("afternoonSubject", "name icon color")
    .populate("morningTeacherId", "name email avatar subjectSpecialty")
    .populate("afternoonTeacherId", "name email avatar subjectSpecialty")
    .lean();

  return serializeTimetableEntry(saved);
}

async function createSessionLog(payload) {
  const dateKey = String(payload.dateKey || getCurrentDateKey()).trim();
  const manualXpAwarded = Number.isFinite(Number(payload.xpAwarded))
    ? clampNumber(Number(payload.xpAwarded), 0, 50)
    : 0;
  const attendanceXpAwarded = 0;
  const totalXpAwarded = manualXpAwarded;

  const sessionLog = await SessionLog.create({
    ...payload,
    dateKey,
    attendanceXpAwarded,
    challengeXpAwarded: 0,
    assessmentXpAwarded: 0,
    performanceXpBeforeStreak: attendanceXpAwarded,
    performanceXpAwarded: attendanceXpAwarded,
    performanceXpCumulative: attendanceXpAwarded,
    streakMultiplierApplied: 1,
    performanceQualifiedForStreak: false,
    targetXpAwarded: manualXpAwarded,
    subjectCompletionBonusXp: 0,
    totalXpAwarded,
    xpAwarded: totalXpAwarded,
  });

  const student = await User.findByIdAndUpdate(
    payload.studentId,
    {
      $inc: {
        xp: totalXpAwarded,
      },
    },
    { new: true },
  ).lean();

  return {
    sessionLog,
    student: student
      ? {
          id: String(student._id),
          name: student.name,
          xp: student.xp,
          streak: student.streak,
          ...serializeJourney(student),
        }
      : null,
  };
}

async function generateLearningAndBlocksDraft(teacherId, payload) {
  const context = await loadCriterionAuthoringContext(payload.criterionId);
  await assertTeacherOwnsCriterionSubject(teacherId, context);

  // WHY: AI can draft criterion content, but it must stay unsaved until the
  // teacher explicitly approves the returned structure.
  const generated = await generateLearningAndBlocksWithGroq({
    subjectName: context.subject.name,
    unitTitle: context.unit.title,
    criterionTitle: context.criterion.title,
    criterionDescription: context.criterion.description,
    requiredWordCount: context.criterion.requiredWordCount,
    learningPassRate: context.criterion.learningPassRate,
    unitText: String(payload.unitText || "").trim(),
  });

  return serializeCriterionDraft({
    criterion: context.criterion,
    subject: context.subject,
    unit: context.unit,
    learningContent: generated.learningContent,
    learningCheckBlocks: generated.learningCheckBlocks,
    essayBuilderBlocks: generated.essayBuilderBlocks,
    aiModel: generated.aiModel,
  });
}

async function extractSourcePlan(teacherId, payload) {
  const [teacher, subject] = await Promise.all([
    User.findOne({ _id: teacherId, role: "teacher" })
      .select("name subjectSpecialty")
      .lean(),
    Subject.findById(payload.subjectId).lean(),
  ]);

  if (!teacher) {
    throw createError(404, "Teacher not found.");
  }

  if (!subject) {
    throw createError(404, "Subject not found.");
  }

  if (
    normalizeForMatch(teacher.subjectSpecialty) !==
    normalizeForMatch(subject.name)
  ) {
    throw createError(
      403,
      "Teachers can only upload and plan source material for their own subject.",
    );
  }

  const extractedSource = await extractTextFromUploadedSource(payload.file);
  const unitPlan = await planUnitFromSourceWithGroq({
    subjectName: subject.name,
    sessionType: payload.sessionType,
    sourceText: extractedSource.extractedText,
    fileName: extractedSource.fileName,
  });

  return {
    ...extractedSource,
    subject: {
      id: String(subject._id),
      name: subject.name,
      icon: subject.icon,
      color: subject.color,
    },
    unitPlan,
  };
}

async function extractCriterionSourcePlan(teacherId, payload) {
  const context = await loadCriterionAuthoringContext(payload.criterionId);
  await assertTeacherOwnsCriterionSubject(teacherId, context);

  const extractedSource = await extractTextFromUploadedSource(payload.file);
  const unitPlan = await planUnitFromSourceWithGroq({
    subjectName: context.subject.name,
    sessionType: "unit",
    sourceText: extractedSource.extractedText,
    fileName: extractedSource.fileName,
  });

  return {
    ...extractedSource,
    criterion: {
      id: String(context.criterion._id),
      title: context.criterion.title,
    },
    subject: {
      id: String(context.subject._id),
      name: context.subject.name,
      icon: context.subject.icon,
      color: context.subject.color,
    },
    unit: {
      id: String(context.unit._id),
      title: context.unit.title,
      description: context.unit.description,
      baseOrder: context.unit.baseOrder,
    },
    unitPlan,
  };
}

async function approveLearningAndBlocks(teacherId, payload) {
  const context = await loadCriterionAuthoringContext(payload.criterionId);
  const teacher = await assertTeacherOwnsCriterionSubject(teacherId, context);
  await assertCriterionApprovalIsSafe(payload.criterionId);

  const normalizedDraft = normalizeApprovedCriterionDraft(payload, context.criterion);

  await Promise.all([
    Block.deleteMany({ criterionId: context.criterion._id }),
  ]);

  const learningContent = await LearningContent.create({
    subjectId: context.subject._id,
    unitId: context.unit._id,
    criterionId: context.criterion._id,
    title: normalizedDraft.learningContent.title,
    summary: normalizedDraft.learningContent.summary,
    sections: normalizedDraft.learningContent.sections,
    status: "approved",
    source: "ai",
    createdBy: teacherId,
    approvedBy: teacherId,
    approvedAt: new Date(),
  });

  const createdBlocks = await Block.create([
    ...normalizedDraft.learningCheckBlocks.map((block) => ({
      ...block,
      subjectId: context.subject._id,
      unitId: context.unit._id,
      criterionId: context.criterion._id,
    })),
    ...normalizedDraft.essayBuilderBlocks.map((block) => ({
      ...block,
      subjectId: context.subject._id,
      unitId: context.unit._id,
      criterionId: context.criterion._id,
    })),
  ]);

  return serializeCriterionDraft({
    criterion: context.criterion,
    subject: context.subject,
    unit: context.unit,
    learningContent: {
      title: learningContent.title,
      summary: learningContent.summary,
      sections: learningContent.sections,
    },
    learningCheckBlocks: createdBlocks
      .filter((block) => block.phase === "learningCheck")
      .sort((left, right) => left.baseOrder - right.baseOrder)
      .map((block) => ({
        type: block.type,
        phase: block.phase,
        prompt: block.prompt,
        options: block.options,
        correctIndex: block.correctIndex,
        generatedSentence: block.generatedSentence,
        baseOrder: block.baseOrder,
        isRequired: block.isRequired,
      })),
    essayBuilderBlocks: createdBlocks
      .filter((block) => block.phase === "essayBuilder")
      .sort((left, right) => left.baseOrder - right.baseOrder)
      .map((block) => ({
        type: block.type,
        phase: block.phase,
        prompt: block.prompt,
        options: block.options,
        correctIndex: block.correctIndex,
        generatedSentence: block.generatedSentence,
        baseOrder: block.baseOrder,
        isRequired: block.isRequired,
      })),
  });
}

async function generateMission(teacherId, payload) {
  const [student, teacher, subject] = await Promise.all([
    User.findOne({ _id: payload.studentId, role: "student" }).lean(),
    User.findOne({ _id: teacherId, role: "teacher" }).lean(),
    Subject.findById(payload.subjectId).lean(),
  ]);

  if (!student) {
    throw createError(404, "Student not found.");
  }

  if (!teacher) {
    throw createError(404, "Teacher not found.");
  }

  if (!subject) {
    throw createError(404, "Subject not found.");
  }

  const availability = await assertTeacherOwnsScheduledLesson({
    teacherId,
    studentId: payload.studentId,
    subjectId: payload.subjectId,
    sessionType: payload.sessionType,
    targetDate: payload.targetDate || getCurrentDateKey(),
  });

  const draftFormat = normalizeDraftFormat(payload.draftFormat);
  const essayMode = draftFormat === "ESSAY_BUILDER"
    ? normalizeEssayMode(payload.essayMode, { required: true })
    : normalizeEssayMode(payload.essayMode);
  const questionCount = normalizeQuestionCount(payload.questionCount || 5, {
    draftFormat,
  });
  const xpReward = resolveMissionRewardPolicy({
    draftFormat,
    questionCount,
  }).xpReward;
  const normalizedTaskCodes = normalizeTaskCodes(payload.taskCodes);
  const unitText = payload.unitText.trim();
  const draftBase = {
    title: payload.title.trim(),
    subjectName: subject.name,
    sessionType: payload.sessionType,
    studentName: student.name,
    difficulty: payload.difficulty || "medium",
    questionCount,
    taskCodes: normalizedTaskCodes,
    unitText,
    mode: essayMode,
    teacherId,
    missionDraftId: String(payload.missionDraftId || "").trim(),
    allowOverflowBlanks: essayMode === "STRETCH_20",
  };

  // WHY: Draft format determines the Groq generation path (questions vs essay builder)
  // so daily missions stay aligned to the teacher's intended experience.
  const generated = draftFormat === "ESSAY_BUILDER"
    ? await generateEssayBuilderDraft(draftBase)
    : await generateMissionWithGroq(draftBase);
  const normalizedQuestions = draftFormat === "THEORY"
    ? buildTheoryQuestionsFromGenerated(generated.questions || [])
    : normalizeQuestions(generated.questions || [], { draftFormat });
  const certificationSnapshot = await loadMissionCertificationSnapshot({
    studentId: String(student._id),
    subjectId: String(subject._id),
  });

  const mission = await Mission.create({
    studentId: student._id,
    subjectId: subject._id,
    sessionType: payload.sessionType,
    title: generated.title,
    teacherNote: generated.teacherNote,
    sourceUnitText: unitText,
    sourceRawText: String(payload.sourceRawText || payload.unitText || "").trim(),
    draftFormat,
    essayMode: draftFormat === "ESSAY_BUILDER" ? essayMode : null,
    draftJson: generated.draftJson || null,
    source: "groq",
    status: "draft",
    aiModel: generated.aiModel,
    availableOnDate: availability.availableOnDate,
    availableOnDay: availability.availableOnDay,
    difficulty: payload.difficulty || "medium",
    taskCodes: normalizedTaskCodes,
    ...certificationSnapshot,
    xpReward,
    sourceFileName: String(payload.sourceFileName || "").trim(),
    sourceFileType: String(payload.sourceFileType || "").trim(),
    questions: normalizedQuestions,
    createdBy: teacher._id,
  });

  const savedMission = await Mission.findById(mission._id)
    .populate("subjectId", "name icon color")
    .lean();

  return serializeMission(savedMission);
}

async function previewMission(teacherId, payload) {
  const [student, teacher, subject] = await Promise.all([
    User.findOne({ _id: payload.studentId, role: "student" }).lean(),
    User.findOne({ _id: teacherId, role: "teacher" }).lean(),
    Subject.findById(payload.subjectId).lean(),
  ]);

  if (!student) {
    throw createError(404, "Student not found.");
  }

  if (!teacher) {
    throw createError(404, "Teacher not found.");
  }

  if (!subject) {
    throw createError(404, "Subject not found.");
  }

  const availability = await assertTeacherOwnsScheduledLesson({
    teacherId,
    studentId: payload.studentId,
    subjectId: payload.subjectId,
    sessionType: payload.sessionType,
    targetDate: payload.targetDate || getCurrentDateKey(),
  });

  const draftFormat = normalizeDraftFormat(payload.draftFormat);
  const essayMode = draftFormat === "ESSAY_BUILDER"
    ? normalizeEssayMode(payload.essayMode, { required: true })
    : normalizeEssayMode(payload.essayMode);
  const questionCount = normalizeQuestionCount(payload.questionCount || 5, {
    draftFormat,
  });
  const xpReward = resolveMissionRewardPolicy({
    draftFormat,
    questionCount,
  }).xpReward;
  const normalizedTaskCodes = normalizeTaskCodes(payload.taskCodes);
  const unitText = payload.unitText.trim();
  const draftBase = {
    title: payload.title.trim(),
    subjectName: subject.name,
    sessionType: payload.sessionType,
    studentName: student.name,
    difficulty: payload.difficulty || "medium",
    questionCount,
    taskCodes: normalizedTaskCodes,
    unitText,
    mode: essayMode,
    teacherId,
    missionDraftId: String(payload.missionDraftId || "").trim(),
    allowOverflowBlanks: essayMode === "STRETCH_20",
  };
  // WHY: Preview must mirror the same draft format as the final generation
  // so the teacher reviews exactly what Groq will produce.
  const generated = draftFormat === "ESSAY_BUILDER"
    ? await generateEssayBuilderDraft(draftBase)
    : await generateMissionWithGroq(draftBase);
  const normalizedQuestions = draftFormat === "THEORY"
    ? buildTheoryQuestionsFromGenerated(generated.questions || [])
    : normalizeQuestions(generated.questions || [], { draftFormat });

  return serializeMission({
    id: "",
    title: generated.title,
    teacherNote: generated.teacherNote,
    sourceUnitText: unitText,
    sourceRawText: String(payload.sourceRawText || payload.unitText || "").trim(),
    draftFormat,
    essayMode: draftFormat === "ESSAY_BUILDER" ? essayMode : null,
    draftJson: generated.draftJson || null,
    source: "groq",
    status: "draft",
    aiModel: generated.aiModel,
    sessionType: payload.sessionType,
    availableOnDate: availability.availableOnDate,
    availableOnDay: availability.availableOnDay,
    difficulty: payload.difficulty || "medium",
    taskCodes: normalizedTaskCodes,
    xpReward,
    sourceFileName: String(payload.sourceFileName || "").trim(),
    sourceFileType: String(payload.sourceFileType || "").trim(),
    questions: normalizedQuestions,
    subjectId: subject,
    createdAt: new Date(),
    publishedAt: null,
  });
}

async function listDraftMissions(teacherId, studentId) {
  const missions = await Mission.find({
    createdBy: teacherId,
    studentId,
    status: "draft",
  })
    .sort({ updatedAt: -1, createdAt: -1 })
    .limit(DRAFT_MISSIONS_LIMIT)
    .populate("subjectId", "name icon color")
    .lean();

  return missions.map(serializeMission);
}

async function listRecentMissions(teacherId, studentId) {
  const missions = await Mission.find({
    createdBy: teacherId,
    studentId,
    $or: [{ status: "published" }, { status: { $exists: false } }],
  })
    .sort({ publishedAt: -1, createdAt: -1 })
    // WHY: Teachers need mission history visibility for sending result reports
    // from previously assigned work, not only the latest five rows.
    .limit(RECENT_MISSIONS_HISTORY_LIMIT)
    .populate("subjectId", "name icon color")
    .lean();

  // WHY: Historical missions completed before the result-package rollout can be
  // missing latestResultPackageId. We backfill/link them here so teachers can
  // still send results from old assigned missions.
  await Promise.all(
    missions.map(async (mission) => {
      if (
        mission?.latestResultPackageId ||
        (
          Number(
            mission?.latestScoreTotal || 0,
          ) <= 0 &&
          Number(
            mission?.latestXpEarned || 0,
          ) <= 0
        )
      ) {
        return;
      }

      try {
        const ensured =
          await ensureResultPackageForMission(
            {
              teacherId,
              missionId: String(
                mission?._id || "",
              ),
            },
          );
        if (
          ensured?.resultPackageId
        ) {
          mission.latestResultPackageId =
            ensured.resultPackageId;
        }
      } catch (error) {
        console.warn(
          "[results] backfill skipped for mission",
          {
            missionId: String(
              mission?._id || "",
            ),
            teacherId: String(
              teacherId || "",
            ),
            reason: String(
              error?.message || "",
            ),
          },
        );
      }
    }),
  );

  return missions.map(serializeMission);
}

async function updateMission(teacherId, missionId, payload) {
  const mission = await Mission.findOne({
    _id: missionId,
    createdBy: teacherId,
  });

  if (!mission) {
    throw createError(404, "Mission not found.");
  }

  const previousDraftFormat = String(mission.draftFormat || "QUESTIONS").trim()
    .toUpperCase();
  const previousQuestions = Array.isArray(mission.questions)
    ? mission.questions.map((question) => ({
        learningText: String(question?.learningText || ""),
        prompt: String(question?.prompt || ""),
        options: Array.isArray(question?.options) ? [...question.options] : [],
        correctIndex: Number(question?.correctIndex),
        expectedAnswer: String(question?.expectedAnswer || ""),
      }))
    : [];

  if (payload.sessionType !== undefined || payload.targetDate !== undefined) {
    const nextSessionType = String(
      payload.sessionType || mission.sessionType || "",
    )
      .trim()
      .toLowerCase();
    const nextTargetDate = String(
      payload.targetDate || mission.availableOnDate || getCurrentDateKey(),
    ).trim();

    if (!["morning", "afternoon"].includes(nextSessionType)) {
      throw createError(400, "Session type must be morning or afternoon.");
    }

    // WHY: Rescheduling a mission must obey the student's timetable ownership
    // boundary so teachers can only move missions to valid slots for their subject.
    const availability = await assertTeacherOwnsScheduledLesson({
      teacherId,
      studentId: String(mission.studentId),
      subjectId: String(mission.subjectId),
      sessionType: nextSessionType,
      targetDate: nextTargetDate,
    });

    mission.sessionType = nextSessionType;
    mission.availableOnDate = availability.availableOnDate;
    mission.availableOnDay = availability.availableOnDay;
  }

  if (payload.title !== undefined) {
    const title = String(payload.title || "").trim();

    if (!title) {
      throw createError(400, "Mission title is required.");
    }

    mission.title = title;
  }

  if (payload.teacherNote !== undefined) {
    mission.teacherNote = String(payload.teacherNote || "").trim();
  }

  if (payload.sourceUnitText !== undefined) {
    mission.sourceUnitText = String(payload.sourceUnitText || "").trim();
  }

  if (payload.sourceRawText !== undefined) {
    mission.sourceRawText = String(payload.sourceRawText || "").trim();
  }

  if (payload.difficulty !== undefined) {
    if (!["easy", "medium", "hard"].includes(payload.difficulty)) {
      throw createError(400, "Difficulty must be easy, medium, or hard.");
    }

    mission.difficulty = payload.difficulty;
  }

  if (payload.taskCodes !== undefined) {
    // WHY: Task targeting is teacher-authored intent, so updates should keep a
    // validated canonical list instead of raw unchecked values.
    mission.taskCodes = normalizeTaskCodes(payload.taskCodes);
  }

  if (payload.xpReward !== undefined) {
    // WHY: Mission rewards now come from one backend-owned policy so stored XP
    // cannot drift away from the draft format and question count.
    mission.xpReward = resolveMissionRewardPolicy({
      draftFormat: mission.draftFormat,
      questionCount: Array.isArray(mission.questions) ? mission.questions.length : 0,
    }).xpReward;
  }

  if (payload.sourceFileName !== undefined) {
    mission.sourceFileName = String(payload.sourceFileName || "").trim();
  }

  if (payload.sourceFileType !== undefined) {
    mission.sourceFileType = String(payload.sourceFileType || "").trim();
  }

  if (payload.draftFormat !== undefined) {
    // WHY: Teachers can switch a saved draft into essay-builder mode before
    // publishing, so updates must persist the selected format explicitly.
    mission.draftFormat = normalizeDraftFormat(payload.draftFormat);
    mission.essayMode = mission.draftFormat === "ESSAY_BUILDER"
      ? normalizeEssayMode(payload.essayMode)
      : null;
    mission.xpReward = resolveMissionRewardPolicy({
      draftFormat: mission.draftFormat,
      questionCount: mission.questions.length,
    }).xpReward;
    if (mission.draftFormat === "ESSAY_BUILDER" && payload.questions === undefined) {
      mission.questions = [];
    }
  }

  if (payload.essayMode !== undefined) {
    mission.essayMode = mission.draftFormat === "ESSAY_BUILDER"
      ? normalizeEssayMode(payload.essayMode, { required: true })
      : null;
  }

  if (payload.draftJson !== undefined) {
    // WHY: Essay-builder publishing depends on the saved draft JSON, so this
    // update path must preserve the teacher-reviewed sentence scaffold.
    mission.draftJson =
      payload.draftJson &&
      typeof payload.draftJson === "object" ?
        payload.draftJson
      : null;
  }

  if (payload.questions !== undefined) {
    if (mission.draftFormat === "ESSAY_BUILDER") {
      // WHY: Essay builder missions do not store question lists, so updates
      // should keep questions empty without failing validation.
      mission.questions = Array.isArray(payload.questions)
        ? payload.questions
        : [];
    } else {
      const normalizedQuestions = normalizeQuestions(payload.questions, {
        draftFormat: mission.draftFormat,
      });
      if (previousDraftFormat === mission.draftFormat) {
        // WHY: Teachers can revise Learn First, but the saved prompt and answer
        // set must be revised in the same save so student-facing content stays
        // aligned with the updated teaching note.
        enforceLearnFirstReviewDependencies(
          previousQuestions,
          normalizedQuestions,
          { draftFormat: mission.draftFormat },
        );
      }
      mission.questions = normalizedQuestions;
    }
  }

  mission.xpReward = resolveMissionRewardPolicy({
    draftFormat: mission.draftFormat,
    questionCount: Array.isArray(mission.questions) ? mission.questions.length : 0,
  }).xpReward;

  if (mission.draftFormat === "ESSAY_BUILDER") {
    mission.essayMode = normalizeEssayMode(mission.essayMode || "NORMAL");
    mission.xpReward = resolveMissionRewardPolicy({
      draftFormat: mission.draftFormat,
      questionCount: Array.isArray(mission.questions) ? mission.questions.length : 0,
    }).xpReward;
  }

  if (!mission.latestResultPackageId) {
    // WHY: Draft mission edits should keep certification intent aligned to the
    // current active plan until the mission produces evidence. After evidence
    // exists, the original snapshot must stay frozen for audit.
    const certificationSnapshot = await loadMissionCertificationSnapshot({
      studentId: String(mission.studentId),
      subjectId: String(mission.subjectId),
    });
    mission.certificationPlanId = certificationSnapshot.certificationPlanId;
    mission.certificationPlanVersion =
      certificationSnapshot.certificationPlanVersion;
    mission.certificationPlanSource =
      certificationSnapshot.certificationPlanSource;
    mission.certificationLabelSnapshot =
      certificationSnapshot.certificationLabelSnapshot;
    mission.certificationRequiredTaskCodesSnapshot =
      certificationSnapshot.certificationRequiredTaskCodesSnapshot;
  }

  if (payload.status !== undefined) {
    if (!["draft", "published"].includes(payload.status)) {
      throw createError(400, "Status must be draft or published.");
    }

    mission.status = payload.status;
    if (payload.status === "published") {
      mission.publishedAt = mission.publishedAt || new Date();
      mission.availableOnDate = mission.availableOnDate || getCurrentDateKey();
      mission.availableOnDay = mission.availableOnDay || getCurrentDay();
    } else {
      mission.publishedAt = null;
    }
  }

  await mission.save();

  const savedMission = await Mission.findById(mission._id)
    .populate("subjectId", "name icon color")
    .lean();

  return serializeMission(savedMission);
}

async function deleteMission(teacherId, missionId) {
  const mission = await Mission.findOne({
    _id: missionId,
    createdBy: teacherId,
  }).lean();

  if (!mission) {
    throw createError(404, "Mission not found.");
  }

  // WHY: Published missions represent assigned work and audit history, so this
  // delete path is intentionally limited to draft-only missions.
  if (mission.status !== "draft") {
    throw createError(400, "Only draft missions can be deleted.");
  }

  const deletion = await Mission.deleteOne({
    _id: missionId,
    createdBy: teacherId,
    status: "draft",
  });

  if (!deletion.deletedCount) {
    throw createError(409, "Draft mission could not be deleted.");
  }

  return { missionId: String(missionId) };
}

async function reextractMissionSource(teacherId, missionId) {
  const mission = await Mission.findOne({
    _id: missionId,
    createdBy: teacherId,
  });

  if (!mission) {
    throw createError(404, "Mission not found.");
  }

  const existingRaw = String(mission.sourceRawText || "").trim();
  if (existingRaw.length >= 80) {
    const savedMission = await Mission.findById(mission._id)
      .populate("subjectId", "name icon color")
      .lean();
    return serializeMission(savedMission);
  }

  const sourceUnitText = String(mission.sourceUnitText || "").trim();
  const questionFallback = (Array.isArray(mission.questions) ? mission.questions : [])
    .map((question) => {
      const learningText = String(question.learningText || "").trim();
      const prompt = String(question.prompt || "").trim();
      return [learningText, prompt].filter(Boolean).join("\n");
    })
    .filter(Boolean)
    .join("\n\n");

  const recoveredRawText = [sourceUnitText, questionFallback]
    .filter(Boolean)
    .join("\n\n")
    .trim();

  // WHY: Old drafts created before raw-text persistence still need one-click
  // recovery. We reconstruct from saved draft content so teachers do not have
  // to reupload manually unless recovery is truly impossible.
  if (recoveredRawText.length < 80) {
    throw createError(
      422,
      "Could not recover full source text from this draft. Upload the source file once to restore it.",
    );
  }

  mission.sourceRawText = recoveredRawText;
  await mission.save();

  const savedMission = await Mission.findById(mission._id)
    .populate("subjectId", "name icon color")
    .lean();
  return serializeMission(savedMission);
}

module.exports = {
  listStudents,
  listSubjects,
  createTimetable,
  updateTimetableSlot,
  createSessionLog,
  generateLearningAndBlocksDraft,
  approveLearningAndBlocks,
  extractSourcePlan,
  extractCriterionSourcePlan,
  generateMission,
  previewMission,
  listDraftMissions,
  listRecentMissions,
  updateMission,
  deleteMission,
  reextractMissionSource,
};
