/**
 * WHAT:
 * criterionProgress.service centralizes student criterion progression rules for
 * learning access, learning completion, and block unlocking.
 * WHY:
 * Learning enforcement must stay consistent across student, teacher, and mentor
 * routes so students cannot bypass the required learn-first phase.
 * HOW:
 * Load criterion context, validate access, create default progress records when
 * needed, and gate block access until learning has been completed.
 */
const Block = require("../models/Block");
const AuditLog = require("../models/AuditLog");
const Criterion = require("../models/Criterion");
const LearningContent = require("../models/LearningContent");
const Notification = require("../models/Notification");
const StudentProgress = require("../models/StudentProgress");
const Subject = require("../models/Subject");
const Timetable = require("../models/Timetable");
const Unit = require("../models/Unit");
const User = require("../models/User");

function createError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function serializeSubject(subject) {
  if (!subject) {
    return null;
  }

  return {
    id: String(subject._id),
    name: subject.name,
    icon: subject.icon,
    color: subject.color,
  };
}

function serializeUnit(unit) {
  if (!unit) {
    return null;
  }

  return {
    id: String(unit._id),
    title: unit.title,
    description: unit.description,
    baseOrder: unit.baseOrder,
  };
}

function serializeCriterion(criterion) {
  return {
    id: String(criterion._id),
    title: criterion.title,
    description: criterion.description,
    baseOrder: criterion.baseOrder,
    requiredWordCount: criterion.requiredWordCount,
    learningPassRate: criterion.learningPassRate,
    isActive: criterion.isActive,
  };
}

function serializeLearningContent(learningContent) {
  if (!learningContent) {
    return null;
  }

  return {
    id: String(learningContent._id),
    title: learningContent.title,
    summary: learningContent.summary,
    status: learningContent.status,
    source: learningContent.source,
    sections: learningContent.sections.map((section) => ({
      heading: section.heading,
      body: section.body,
      baseOrder: section.baseOrder,
    })),
    approvedAt: learningContent.approvedAt,
  };
}

function serializeBlock(block) {
  return {
    id: String(block._id),
    type: block.type,
    phase: block.phase,
    prompt: block.prompt,
    options: block.options,
    correctIndex: block.correctIndex,
    generatedSentence: block.generatedSentence,
    baseOrder: block.baseOrder,
    isRequired: block.isRequired,
  };
}

function serializeProgress(progress) {
  return {
    id: String(progress._id),
    criterionState: progress.criterionState,
    learningStatus: progress.learningStatus,
    learningCompletedAt: progress.learningCompletedAt,
    learningCheckBlockOrder: (progress.learningCheckBlockOrder || []).map((value) =>
      String(value),
    ),
    attemptsUsed: progress.attemptsUsed,
    latestLearningCheckScore: progress.latestLearningCheckScore,
    essayBuilderUnlockedAt: progress.essayBuilderUnlockedAt,
    appendedBlockIds: progress.appendedBlockIds.map((value) => String(value)),
    essayText: progress.essayText,
    wordCount: progress.wordCount,
    submissionUnlocked: progress.submissionUnlocked,
    submittedAt: progress.submittedAt,
    completed: progress.completed,
    approvedAt: progress.approvedAt,
    revisionRequestedAt: progress.revisionRequestedAt,
    xpAwarded: progress.xpAwarded,
  };
}

function normalizeComparableValue(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function calculateCriterionXp(criterion) {
  // WHY: Submission XP should reward meaningful completed work while staying
  // bounded so longer criteria do not become an exploit for excessive XP.
  return Math.max(30, Math.min(100, Math.ceil(criterion.requiredWordCount / 2)));
}

async function assertUserCanAccessStudent({
  requesterId,
  requesterRole,
  studentId,
}) {
  const student = await User.findOne({
    _id: studentId,
    role: "student",
  }).lean();

  if (!student) {
    throw createError(404, "Student not found.");
  }

  if (requesterRole === "student") {
    if (String(requesterId) !== String(studentId)) {
      throw createError(
        403,
        "Students can only access their own criterion progress.",
      );
    }

    return student;
  }

  if (
    requesterRole === "teacher" ||
    requesterRole === "mentor" ||
    requesterRole === "management"
  ) {
    const owner = await User.findById(requesterId).select("assignedStudents").lean();

    // WHY: Teacher, mentor, and management access must stay tied to assigned
    // learners so progress cannot be inspected outside the support chain.
    const isAssigned = Boolean(
      owner?.assignedStudents?.some(
        (assignedStudentId) => String(assignedStudentId) === String(studentId),
      ),
    );

    if (!isAssigned) {
      throw createError(
        403,
        "You can only access criterion progress for assigned students.",
      );
    }

    return student;
  }

  throw createError(403, "This role cannot access criterion progress.");
}

async function loadCriterionContext(criterionId) {
  const criterion = await Criterion.findOne({
    _id: criterionId,
    isActive: true,
  }).lean();

  if (!criterion) {
    throw createError(404, "Criterion not found.");
  }

  const [subject, unit, learningContent] = await Promise.all([
    Subject.findById(criterion.subjectId).lean(),
    Unit.findById(criterion.unitId).lean(),
    LearningContent.findOne({
      criterionId,
      status: "approved",
    })
      .sort({ updatedAt: -1, createdAt: -1 })
      .lean(),
  ]);

  return {
    criterion,
    subject,
    unit,
    learningContent,
  };
}

async function ensureProgressRecord({ studentId, context }) {
  let progress = await StudentProgress.findOne({
    studentId,
    criterionId: context.criterion._id,
  });

  if (!progress) {
    progress = await StudentProgress.create({
      studentId,
      subjectId: context.criterion.subjectId,
      unitId: context.criterion.unitId,
      criterionId: context.criterion._id,
      criterionState: "learning_required",
      learningStatus: "pending",
    });
  }

  return progress;
}

function buildProgressFlags(progress, learningContent) {
  return {
    learningContentReady: Boolean(learningContent),
    learningCompleted: Boolean(progress.learningCompletedAt),
    learningCheckLocked: progress.learningStatus === "locked_review_required",
    attemptsRemaining: Math.max(0, 3 - (progress.attemptsUsed || 0)),
    learningCheckUnlocked:
      progress.criterionState !== "learning_required" &&
      progress.learningStatus !== "pending",
    essayBuilderUnlocked:
      progress.criterionState === "essay_builder_unlocked" ||
      progress.criterionState === "ready_for_submission" ||
      progress.criterionState === "submitted" ||
      progress.criterionState === "approved" ||
      progress.criterionState === "revision_requested",
    submissionReady:
      progress.criterionState === "ready_for_submission" &&
      progress.submissionUnlocked,
    teacherReviewPending: progress.criterionState === "submitted",
    revisionRequested: progress.criterionState === "revision_requested",
    approved: progress.criterionState === "approved",
  };
}

function countWords(text) {
  return String(text || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

function shuffleArray(values) {
  const items = [...values];

  for (let index = items.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    const current = items[index];
    items[index] = items[swapIndex];
    items[swapIndex] = current;
  }

  return items;
}

function canStudentUseEssayBuilder(progress) {
  return (
    progress.criterionState === "essay_builder_unlocked" ||
    progress.criterionState === "ready_for_submission" ||
    progress.criterionState === "revision_requested"
  );
}

function canStudentUseLearningCheck(progress) {
  return Boolean(progress.learningCompletedAt) &&
    progress.learningStatus !== "locked_review_required";
}

async function getLearningCheckBlocksForCriterion(criterionId) {
  return Block.find({
    criterionId,
    phase: "learningCheck",
  })
    .sort({ baseOrder: 1 })
    .lean();
}

function getOrderedLearningCheckBlocks(progress, blocks) {
  if (!progress.learningCheckBlockOrder?.length) {
    return blocks;
  }

  const blockMap = new Map(blocks.map((block) => [String(block._id), block]));
  const ordered = progress.learningCheckBlockOrder
    .map((blockId) => blockMap.get(String(blockId)))
    .filter(Boolean);

  if (ordered.length !== blocks.length) {
    return blocks;
  }

  return ordered;
}

async function getEssayBuilderCompletion(criterionId, progress, criterion) {
  const requiredBlocks = await Block.find({
    criterionId,
    phase: "essayBuilder",
    isRequired: true,
  })
    .select("_id")
    .lean();

  const appendedBlockIds = new Set(
    progress.appendedBlockIds.map((value) => String(value)),
  );
  const allRequiredBlocksCompleted = requiredBlocks.every((requiredBlock) =>
    appendedBlockIds.has(String(requiredBlock._id)),
  );
  const currentWordCount = countWords(progress.essayText);
  const wordCountMet = currentWordCount >= criterion.requiredWordCount;

  return {
    requiredBlocks,
    allRequiredBlocksCompleted,
    currentWordCount,
    wordCountMet,
  };
}

async function resolveTeacherRecipients({ studentId, subjectId, subjectName }) {
  const timetableEntries = await Timetable.find({ studentId }).lean();
  const recipientIds = new Set();

  for (const entry of timetableEntries) {
    if (
      entry.morningSubject &&
      String(entry.morningSubject) === String(subjectId) &&
      entry.morningTeacherId
    ) {
      recipientIds.add(String(entry.morningTeacherId));
    }

    if (
      entry.afternoonSubject &&
      String(entry.afternoonSubject) === String(subjectId) &&
      entry.afternoonTeacherId
    ) {
      recipientIds.add(String(entry.afternoonTeacherId));
    }
  }

  if (recipientIds.size > 0) {
    return [...recipientIds];
  }

  const fallbackTeachers = await User.find({
    role: "teacher",
    assignedStudents: studentId,
  })
    .select("_id subjectSpecialty")
    .lean();

  for (const teacher of fallbackTeachers) {
    if (
      normalizeComparableValue(teacher.subjectSpecialty) ===
      normalizeComparableValue(subjectName)
    ) {
      recipientIds.add(String(teacher._id));
    }
  }

  return [...recipientIds];
}

async function assertTeacherCanReviewCriterion({
  teacherId,
  studentId,
  context,
}) {
  const teacher = await User.findOne({
    _id: teacherId,
    role: "teacher",
  })
    .select("name subjectSpecialty assignedStudents")
    .lean();

  if (!teacher) {
    throw createError(404, "Teacher not found.");
  }

  const isAssigned = teacher.assignedStudents.some(
    (assignedStudentId) => String(assignedStudentId) === String(studentId),
  );

  if (!isAssigned) {
    throw createError(
      403,
      "You can only review criteria for students assigned to you.",
    );
  }

  if (
    normalizeComparableValue(teacher.subjectSpecialty) ===
    normalizeComparableValue(context.subject?.name)
  ) {
    return teacher;
  }

  const timetableEntries = await Timetable.find({ studentId }).lean();
  const ownsSubjectSlot = timetableEntries.some(
    (entry) =>
      (entry.morningSubject &&
        String(entry.morningSubject) === String(context.criterion.subjectId) &&
        entry.morningTeacherId &&
        String(entry.morningTeacherId) === String(teacherId)) ||
      (entry.afternoonSubject &&
        String(entry.afternoonSubject) === String(context.criterion.subjectId) &&
        entry.afternoonTeacherId &&
        String(entry.afternoonTeacherId) === String(teacherId)),
  );

  if (!ownsSubjectSlot) {
    throw createError(
      403,
      "Only the teacher responsible for this subject can review the criterion.",
    );
  }

  return teacher;
}

async function getEssayBuilderBlocks({
  requesterId,
  requesterRole,
  studentId,
  criterionId,
}) {
  await assertUserCanAccessStudent({
    requesterId,
    requesterRole,
    studentId,
  });
  const context = await loadCriterionContext(criterionId);
  const progress = await ensureProgressRecord({ studentId, context });

  if (requesterRole === "student" && !canStudentUseEssayBuilder(progress)) {
    throw createError(
      403,
      "Essay Builder unlocks only after the learning check has been passed.",
    );
  }

  const blocks = await Block.find({
    criterionId,
    phase: "essayBuilder",
  })
    .sort({ baseOrder: 1 })
    .lean();

  return {
    criterion: serializeCriterion(context.criterion),
    progress: serializeProgress(progress),
    flags: buildProgressFlags(progress, context.learningContent),
    blocks: blocks.map(serializeBlock),
  };
}

async function appendEssayBuilderBlock({
  requesterId,
  requesterRole,
  studentId,
  criterionId,
  blockId,
}) {
  if (requesterRole !== "student" || String(requesterId) !== String(studentId)) {
    throw createError(
      403,
      "Only the student can build the essay for this criterion.",
    );
  }

  await assertUserCanAccessStudent({
    requesterId,
    requesterRole,
    studentId,
  });
  const context = await loadCriterionContext(criterionId);
  const progress = await ensureProgressRecord({ studentId, context });

  if (!canStudentUseEssayBuilder(progress)) {
    throw createError(
      403,
      "Essay Builder is locked until the learning check has been passed.",
    );
  }

  const block = await Block.findOne({
    _id: blockId,
    criterionId,
    phase: "essayBuilder",
  }).lean();

  if (!block) {
    throw createError(404, "Essay Builder block not found.");
  }

  if (!block.generatedSentence.trim()) {
    throw createError(
      400,
      "This Essay Builder block does not include a generated sentence to append.",
    );
  }

  const alreadyAppended = progress.appendedBlockIds.some(
    (appendedBlockId) => String(appendedBlockId) === String(blockId),
  );

  if (alreadyAppended) {
    // WHY: Each generated sentence should only be appended once so students do
    // not inflate the word count or duplicate scaffolded support silently.
    throw createError(
      409,
      "This block has already been added to the essay.",
    );
  }

  const nextEssayText = [progress.essayText, block.generatedSentence]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join("\n\n");

  progress.appendedBlockIds.push(block._id);
  progress.essayText = nextEssayText;
  progress.wordCount = countWords(nextEssayText);

  const { allRequiredBlocksCompleted, wordCountMet } =
    await getEssayBuilderCompletion(criterionId, progress, context.criterion);

  // WHY: Submission only unlocks after both the minimum word count and the
  // required scaffolded essay steps are complete, so students build enough
  // content without skipping the planned support sequence.
  if (wordCountMet && allRequiredBlocksCompleted) {
    progress.submissionUnlocked = true;
    progress.criterionState = "ready_for_submission";
  } else {
    progress.submissionUnlocked = false;
    if (progress.criterionState !== "revision_requested") {
      progress.criterionState = "essay_builder_unlocked";
    }
  }

  // WHY: Submission is not automatic because the student must explicitly choose
  // to hand in the final draft once they feel ready.
  await progress.save();

  return {
    appendedBlock: serializeBlock(block),
    progress: serializeProgress(progress),
    flags: buildProgressFlags(progress, context.learningContent),
  };
}

async function listCriteriaForStudent({
  requesterId,
  requesterRole,
  studentId,
}) {
  const student = await assertUserCanAccessStudent({
    requesterId,
    requesterRole,
    studentId,
  });

  const [criteria, progressRecords] = await Promise.all([
    Criterion.find({ isActive: true }).sort({ baseOrder: 1, title: 1 }).lean(),
    StudentProgress.find({ studentId }).lean(),
  ]);

  const progressByCriterionId = new Map(
    progressRecords.map((progress) => [String(progress.criterionId), progress]),
  );

  const contexts = await Promise.all(
    criteria.map(async (criterion) => {
      const [subject, unit, learningContent] = await Promise.all([
        Subject.findById(criterion.subjectId).lean(),
        Unit.findById(criterion.unitId).lean(),
        LearningContent.findOne({
          criterionId: criterion._id,
          status: "approved",
        })
          .sort({ updatedAt: -1, createdAt: -1 })
          .lean(),
      ]);

      const progress =
        progressByCriterionId.get(String(criterion._id)) || {
          _id: `${studentId}:${criterion._id}`,
          criterionState: "learning_required",
          learningStatus: "pending",
          learningCompletedAt: null,
          attemptsUsed: 0,
          latestLearningCheckScore: 0,
          essayBuilderUnlockedAt: null,
          appendedBlockIds: [],
          essayText: "",
          wordCount: 0,
          submissionUnlocked: false,
          submittedAt: null,
          completed: false,
          approvedAt: null,
          revisionRequestedAt: null,
          xpAwarded: 0,
        };

      return {
        subject: serializeSubject(subject),
        unit: serializeUnit(unit),
        criterion: serializeCriterion(criterion),
        progress: serializeProgress(progress),
        flags: buildProgressFlags(progress, learningContent),
      };
    }),
  );

  return {
    student: {
      id: String(student._id),
      name: student.name,
    },
    criteria: contexts,
  };
}

async function getCriterionDetail({
  requesterId,
  requesterRole,
  studentId,
  criterionId,
}) {
  const student = await assertUserCanAccessStudent({
    requesterId,
    requesterRole,
    studentId,
  });
  const context = await loadCriterionContext(criterionId);
  const progress = await ensureProgressRecord({ studentId, context });

  return {
    student: {
      id: String(student._id),
      name: student.name,
    },
    subject: serializeSubject(context.subject),
    unit: serializeUnit(context.unit),
    criterion: serializeCriterion(context.criterion),
    learningContent: serializeLearningContent(context.learningContent),
    progress: serializeProgress(progress),
    flags: buildProgressFlags(progress, context.learningContent),
  };
}

async function completeLearning({
  requesterId,
  requesterRole,
  studentId,
  criterionId,
}) {
  if (requesterRole !== "student" || String(requesterId) !== String(studentId)) {
    throw createError(
      403,
      "Only the student can complete the learning phase for this criterion.",
    );
  }

  await assertUserCanAccessStudent({
    requesterId,
    requesterRole,
    studentId,
  });
  const context = await loadCriterionContext(criterionId);

  if (!context.learningContent) {
    throw createError(
      400,
      "Learning content is not approved yet, so the criterion cannot begin.",
    );
  }

  const progress = await ensureProgressRecord({ studentId, context });

  if (!progress.learningCompletedAt) {
    // WHY: Students must complete structured learning first so recall tasks do
    // not test untaught knowledge or encourage guessing.
    const learningCheckBlocks = await getLearningCheckBlocksForCriterion(criterionId);

    progress.learningCompletedAt = new Date();
    progress.learningStatus = "active";
    progress.criterionState = "learning_check_active";
    progress.learningCheckBlockOrder = learningCheckBlocks.map((block) => block._id);
    await progress.save();
  }

  return {
    progress: serializeProgress(progress),
    flags: buildProgressFlags(progress, context.learningContent),
  };
}

async function getLearningCheckBlocks({
  requesterId,
  requesterRole,
  studentId,
  criterionId,
}) {
  await assertUserCanAccessStudent({
    requesterId,
    requesterRole,
    studentId,
  });
  const context = await loadCriterionContext(criterionId);
  const progress = await ensureProgressRecord({ studentId, context });

  if (requesterRole === "student" && !canStudentUseLearningCheck(progress)) {
    // WHY: LearningCheck blocks stay locked until learning is completed so the
    // student must read the teaching content before attempting recall.
    throw createError(
      403,
      progress.learningStatus === "locked_review_required"
        ? "This knowledge check is locked until a teacher resets it."
        : "Complete the learning content first before opening the knowledge check.",
    );
  }

  const blocks = await getLearningCheckBlocksForCriterion(criterionId);
  const orderedBlocks = getOrderedLearningCheckBlocks(progress, blocks);

  return {
    criterion: serializeCriterion(context.criterion),
    progress: serializeProgress(progress),
    flags: buildProgressFlags(progress, context.learningContent),
    blocks: orderedBlocks.map(serializeBlock),
  };
}

async function submitLearningCheckAttempt({
  requesterId,
  requesterRole,
  studentId,
  criterionId,
  answers,
}) {
  if (requesterRole !== "student" || String(requesterId) !== String(studentId)) {
    throw createError(
      403,
      "Only the student can submit a learning check attempt.",
    );
  }

  const student = await assertUserCanAccessStudent({
    requesterId,
    requesterRole,
    studentId,
  });
  const context = await loadCriterionContext(criterionId);
  const progress = await ensureProgressRecord({ studentId, context });

  if (!canStudentUseLearningCheck(progress)) {
    throw createError(
      403,
      progress.learningStatus === "locked_review_required"
        ? "This knowledge check is locked until a teacher resets it."
        : "Complete the learning content first before submitting the knowledge check.",
    );
  }

  const blocks = getOrderedLearningCheckBlocks(
    progress,
    await getLearningCheckBlocksForCriterion(criterionId),
  );

  if (!Array.isArray(answers) || answers.length !== blocks.length) {
    throw createError(
      400,
      "Submit one answer for every learning-check block.",
    );
  }

  const answersByBlockId = new Map();
  for (const answer of answers) {
    const blockId = String(answer?.blockId || "");
    const selectedIndex = Number(answer?.selectedIndex);

    if (!blockId || !Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex > 3) {
      throw createError(
        400,
        "Each learning-check answer needs a valid blockId and selectedIndex between 0 and 3.",
      );
    }

    answersByBlockId.set(blockId, selectedIndex);
  }

  let correctAnswers = 0;
  for (const block of blocks) {
    const selectedIndex = answersByBlockId.get(String(block._id));

    if (selectedIndex === undefined) {
      throw createError(
        400,
        "Each learning-check block must be answered once per attempt.",
      );
    }

    if (selectedIndex === block.correctIndex) {
      correctAnswers += 1;
    }
  }

  const score = Math.round((correctAnswers / blocks.length) * 100);
  progress.attemptsUsed += 1;
  progress.latestLearningCheckScore = score;

  if (score >= context.criterion.learningPassRate) {
    progress.learningStatus = "passed";
    progress.criterionState = "essay_builder_unlocked";
    progress.essayBuilderUnlockedAt = new Date();
    progress.submissionUnlocked = false;
  } else if (progress.attemptsUsed >= 3) {
    // WHY: Three capped attempts reduce guessing, support ADHD learners with a
    // clear review boundary, and preserve academic integrity for progression.
    progress.learningStatus = "locked_review_required";
    progress.criterionState = "learning_check_active";

    const teacherRecipientIds = await resolveTeacherRecipients({
      studentId,
      subjectId: context.criterion.subjectId,
      subjectName: context.subject?.name,
    });

    await Promise.all(
      teacherRecipientIds.map((recipientId) =>
        Notification.create({
          recipientId,
          studentId,
          criterionId,
          type: "learning_review_required",
          title: `${student.name} needs learning review`,
          message: `${student.name} used all 3 learning-check attempts for "${context.criterion.title}".`,
          createdBy: studentId,
        }),
      ),
    );
  } else {
    progress.learningStatus = "active";
    progress.criterionState = "learning_check_active";
  }

  await progress.save();

  return {
    progress: serializeProgress(progress),
    flags: buildProgressFlags(progress, context.learningContent),
    attemptResult: {
      score,
      passRate: context.criterion.learningPassRate,
      passed: score >= context.criterion.learningPassRate,
      correctAnswers,
      totalQuestions: blocks.length,
    },
  };
}

async function resetLearningCheck({
  requesterId,
  requesterRole,
  studentId,
  criterionId,
}) {
  if (requesterRole !== "teacher") {
    throw createError(403, "Only teachers can reset a learning check.");
  }

  const student = await assertUserCanAccessStudent({
    requesterId,
    requesterRole,
    studentId,
  });
  const context = await loadCriterionContext(criterionId);
  const teacher = await assertTeacherCanReviewCriterion({
    teacherId: requesterId,
    studentId,
    context,
  });
  const progress = await ensureProgressRecord({ studentId, context });

  if (progress.learningStatus !== "locked_review_required") {
    throw createError(
      409,
      "Only a locked learning check can be reset.",
    );
  }

  const blocks = await getLearningCheckBlocksForCriterion(criterionId);
  const previousBlockOrder = (progress.learningCheckBlockOrder || []).map((blockId) =>
    String(blockId),
  );
  let reshuffledOrder = shuffleArray(blocks.map((block) => block._id));
  const reshuffledOrderStrings = reshuffledOrder.map((blockId) => String(blockId));

  if (
    reshuffledOrder.length > 1 &&
    previousBlockOrder.length === reshuffledOrderStrings.length &&
    previousBlockOrder.every(
      (blockId, index) => blockId === reshuffledOrderStrings[index],
    )
  ) {
    // WHY: Reset must visibly reshuffle the learning-check sequence so the
    // student cannot rely on memorized block order after exhausting attempts.
    reshuffledOrder = [
      ...reshuffledOrder.slice(1),
      reshuffledOrder[0],
    ];
  }

  const attemptsUsedBeforeReset = progress.attemptsUsed;

  progress.attemptsUsed = 0;
  progress.latestLearningCheckScore = 0;
  progress.learningStatus = "active";
  progress.criterionState = "learning_check_active";
  progress.learningCheckBlockOrder = reshuffledOrder;

  // WHY: Reset reshuffles the block order so the student cannot rely on memorized
  // answer positions after multiple failed attempts.
  await Promise.all([
    progress.save(),
    AuditLog.create({
      actorId: requesterId,
      studentId,
      criterionId,
      type: "learning_check_reset",
      message: `${teacher.name} reset the learning check for "${context.criterion.title}" for ${student.name}.`,
      metadata: {
        attemptsUsedBeforeReset,
        reshuffledBlockOrder: reshuffledOrder.map((blockId) => String(blockId)),
      },
    }),
  ]);

  return {
    progress: serializeProgress(progress),
    flags: buildProgressFlags(progress, context.learningContent),
    blocks: getOrderedLearningCheckBlocks(progress, blocks).map(serializeBlock),
  };
}

async function submitCriterion({
  requesterId,
  requesterRole,
  studentId,
  criterionId,
}) {
  if (requesterRole !== "student" || String(requesterId) !== String(studentId)) {
    throw createError(
      403,
      "Only the student can submit the final criterion response.",
    );
  }

  const student = await assertUserCanAccessStudent({
    requesterId,
    requesterRole,
    studentId,
  });
  const context = await loadCriterionContext(criterionId);
  const progress = await ensureProgressRecord({ studentId, context });

  if (progress.criterionState === "submitted") {
    throw createError(409, "This criterion has already been submitted.");
  }

  const { allRequiredBlocksCompleted, currentWordCount, wordCountMet } =
    await getEssayBuilderCompletion(criterionId, progress, context.criterion);

  progress.wordCount = currentWordCount;

  if (!allRequiredBlocksCompleted || !wordCountMet || !progress.submissionUnlocked) {
    throw createError(
      403,
      "The criterion is not ready for submission yet.",
    );
  }

  const xpToAward =
    progress.xpAwarded > 0 ? 0 : calculateCriterionXp(context.criterion);

  progress.criterionState = "submitted";
  progress.submissionUnlocked = false;
  progress.submittedAt = new Date();
  progress.completed = true;

  if (xpToAward > 0) {
    progress.xpAwarded = xpToAward;
  }

  // WHY: Explicit submission creates ownership, so the system must wait for the
  // student to press submit instead of auto-completing the criterion.
  await progress.save();

  if (xpToAward > 0) {
    await User.findByIdAndUpdate(studentId, {
      $inc: { xp: xpToAward },
    });
  }

  const teacherRecipientIds = await resolveTeacherRecipients({
    studentId,
    subjectId: context.criterion.subjectId,
    subjectName: context.subject?.name,
  });

  await Promise.all([
    ...teacherRecipientIds.map((recipientId) =>
      Notification.create({
        recipientId,
        studentId,
        criterionId,
        type: "criterion_submitted",
        title: `${student.name} submitted a criterion`,
        message: `${student.name} submitted "${context.criterion.title}" for teacher review.`,
        createdBy: studentId,
      }),
    ),
    AuditLog.create({
      actorId: studentId,
      studentId,
      criterionId,
      type: "criterion_submitted",
      message: `${student.name} submitted "${context.criterion.title}".`,
      metadata: {
        wordCount: progress.wordCount,
        xpAwarded: xpToAward,
        requiredWordCount: context.criterion.requiredWordCount,
      },
    }),
  ]);

  return {
    progress: serializeProgress(progress),
    flags: buildProgressFlags(progress, context.learningContent),
    xpAwardedNow: xpToAward,
    notificationsCreated: teacherRecipientIds.length,
  };
}

async function reviewCriterion({
  requesterId,
  requesterRole,
  studentId,
  criterionId,
  action,
}) {
  if (requesterRole !== "teacher") {
    throw createError(403, "Only teachers can review submitted criteria.");
  }

  const student = await assertUserCanAccessStudent({
    requesterId,
    requesterRole,
    studentId,
  });
  const context = await loadCriterionContext(criterionId);
  const teacher = await assertTeacherCanReviewCriterion({
    teacherId: requesterId,
    studentId,
    context,
  });
  const progress = await ensureProgressRecord({ studentId, context });

  if (!["approve", "request_revision"].includes(action)) {
    throw createError(400, "Review action must be approve or request_revision.");
  }

  if (progress.criterionState !== "submitted") {
    throw createError(
      409,
      "Only submitted criteria can be reviewed.",
    );
  }

  if (action === "approve") {
    progress.criterionState = "approved";
    progress.approvedAt = new Date();
    progress.revisionRequestedAt = null;
    progress.submissionUnlocked = false;

    await Promise.all([
      progress.save(),
      AuditLog.create({
        actorId: requesterId,
        studentId,
        criterionId,
        type: "criterion_approved",
        message: `${teacher.name} approved "${context.criterion.title}" for ${student.name}.`,
        metadata: {
          approvedAt: new Date().toISOString(),
        },
      }),
    ]);

    return {
      progress: serializeProgress(progress),
      flags: buildProgressFlags(progress, context.learningContent),
      reviewAction: "approved",
    };
  }

  progress.criterionState = "revision_requested";
  progress.revisionRequestedAt = new Date();
  progress.approvedAt = null;
  progress.submissionUnlocked = false;
  progress.completed = false;

  // WHY: For MVP, requesting revision should reopen only Essay Builder while
  // keeping LearningCheck passed, so the student refines writing without being
  // pushed back through the earlier learning stages.
  await Promise.all([
    progress.save(),
    AuditLog.create({
      actorId: requesterId,
      studentId,
      criterionId,
      type: "revision_requested",
      message: `${teacher.name} requested revision for "${context.criterion.title}" from ${student.name}.`,
      metadata: {
        revisionRequestedAt: new Date().toISOString(),
      },
    }),
  ]);

  return {
    progress: serializeProgress(progress),
    flags: buildProgressFlags(progress, context.learningContent),
    reviewAction: "revision_requested",
  };
}

module.exports = {
  listCriteriaForStudent,
  getCriterionDetail,
  completeLearning,
  getLearningCheckBlocks,
  submitLearningCheckAttempt,
  resetLearningCheck,
  getEssayBuilderBlocks,
  appendEssayBuilderBlock,
  submitCriterion,
  reviewCriterion,
};
