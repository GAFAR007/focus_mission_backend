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
  extractTextFromUploadedSource,
} = require("./sourceExtraction.service");
const { serializeMission } = require("../utils/missionSerializer");
const { serializeJourney } = require("../utils/userJourney");
const {
  ATTENDANCE_XP,
  clampNumber,
  getDateKey,
  getNow,
  isAssessmentQuestionCount,
} = require("../utils/xpPolicy");

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

function isPlaceholderOption(value) {
  return ["a", "b", "c", "d"].includes(normalizeForMatch(value));
}

function countWords(value) {
  return String(value || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

function normalizeQuestionCount(value) {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || ![5, 8, 10].includes(parsed)) {
    throw createError(400, "Question count must be 5, 8, or 10.");
  }

  return parsed;
}

function normalizeXpReward(value) {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 10 || parsed > 50 || parsed % 5 !== 0) {
    throw createError(400, "XP reward must be between 10 and 50 in steps of 5.");
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
  if (!["QUESTIONS", "ESSAY_BUILDER"].includes(normalized)) {
    throw createError(400, "Draft format must be QUESTIONS or ESSAY_BUILDER.");
  }

  return normalized;
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

function normalizeQuestions(questions) {
  if (!Array.isArray(questions) || questions.length < 1 || questions.length > 10) {
    throw createError(400, "Mission drafts must include between 1 and 10 questions.");
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

    const normalizedLearningText = normalizeForMatch(learningText);
    const normalizedAnswer = normalizeForMatch(options[correctIndex]);

    if (!normalizedLearningText.includes(normalizedAnswer)) {
      throw createError(
        400,
        `Question ${index + 1} must teach the correct answer inside the Learn First text.`,
      );
    }

    return {
      learningText,
      prompt,
      options,
      correctIndex,
      explanation,
    };
  });
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

async function listStudents() {
  return User.find({ role: "student" })
    .sort({ name: 1 })
    .select(
      "name role avatar avatarSeed xp streak preferredDifficulty firstLoginAt lastLoginAt loginDayCount",
    )
    .lean();
}

async function createTimetable(payload) {
  return Timetable.create(payload);
}

async function createSessionLog(payload) {
  const dateKey = String(payload.dateKey || getCurrentDateKey()).trim();
  const manualXpAwarded = Number.isFinite(Number(payload.xpAwarded))
    ? clampNumber(Number(payload.xpAwarded), 0, 50)
    : 0;
  const markAttendance = payload.markAttendance !== false;
  const attendanceAlreadyAwarded = await SessionLog.exists({
    studentId: payload.studentId,
    dateKey,
    attendanceXpAwarded: { $gt: 0 },
  });
  // WHY: Attendance is a one-time daily reward, so repeated session saves in
  // the same day should not inflate attendance XP.
  const attendanceXpAwarded =
    markAttendance && !attendanceAlreadyAwarded ? ATTENDANCE_XP : 0;
  const totalXpAwarded = attendanceXpAwarded + manualXpAwarded;

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
  const questionCount = normalizeQuestionCount(payload.questionCount || 5);
  const xpReward = draftFormat === "ESSAY_BUILDER"
    // WHY: Daily essay modes are fixed at 50 XP across NORMAL/STRETCH options
    // so reward consistency is independent from sentence count mode.
    ? 50
    : isAssessmentQuestionCount(questionCount)
      ? 50
      : normalizeXpReward(payload.xpReward || 20);
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
    xpReward,
    sourceFileName: String(payload.sourceFileName || "").trim(),
    sourceFileType: String(payload.sourceFileType || "").trim(),
    questions: generated.questions || [],
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
  const questionCount = normalizeQuestionCount(payload.questionCount || 5);
  const xpReward = draftFormat === "ESSAY_BUILDER"
    // WHY: Essay matrix modes keep a fixed 50 XP reward for predictable daily
    // scoring regardless of sentence/blank target size.
    ? 50
    : isAssessmentQuestionCount(questionCount)
      ? 50
      : normalizeXpReward(payload.xpReward || 20);
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
    questions: generated.questions || [],
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
    .limit(5)
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
    .limit(5)
    .populate("subjectId", "name icon color")
    .lean();

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
    if (mission.draftFormat === "ESSAY_BUILDER") {
      // WHY: Essay mode rewards are fixed by policy, so manual XP edits must
      // not override the daily 50 XP contract.
      mission.xpReward = 50;
    } else {
      mission.xpReward = normalizeXpReward(payload.xpReward);
    }
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
    if (mission.draftFormat === "ESSAY_BUILDER") {
      mission.xpReward = 50;
    }
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
      mission.questions = normalizeQuestions(payload.questions);
    }
  }

  if (isAssessmentQuestionCount(Array.isArray(mission.questions) ? mission.questions.length : 0)) {
    // WHY: Assessment-mode rewards are fixed at 50 XP so score-based scaling
    // remains predictable and aligned with the daily performance model.
    mission.xpReward = 50;
  }

  if (mission.draftFormat === "ESSAY_BUILDER") {
    mission.essayMode = normalizeEssayMode(mission.essayMode || "NORMAL");
    mission.xpReward = 50;
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
  createTimetable,
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
