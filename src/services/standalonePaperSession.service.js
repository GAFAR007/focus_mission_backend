/**
 * WHAT:
 * standalonePaperSession.service runs the live standalone Test and Exam
 * delivery flow for students and teacher review.
 * WHY:
 * Timers, leave-page locking, one-question navigation, autosave, and mixed
 * question review need a dedicated runtime service that stays separate from the
 * mission session engine.
 * HOW:
 * Validate timetable access, create or resume standalone paper sittings, save
 * responses and integrity events, auto-submit on timer expiry, and let teachers
 * reset or score written answers after submission.
 */
const ResultPackage = require("../models/ResultPackage");
const SessionLog = require("../models/SessionLog");
const StandalonePaper = require("../models/StandalonePaper");
const StandalonePaperSession = require("../models/StandalonePaperSession");
const Subject = require("../models/Subject");
const Timetable = require("../models/Timetable");
const User = require("../models/User");
const { getDateKey, getNow } = require("../utils/xpPolicy");

function createError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

const WEEKDAY_LOOKUP = {
  mon: "Monday",
  monday: "Monday",
  tue: "Tuesday",
  tues: "Tuesday",
  tuesday: "Tuesday",
  wed: "Wednesday",
  weds: "Wednesday",
  wednesday: "Wednesday",
  thu: "Thursday",
  thur: "Thursday",
  thurs: "Thursday",
  thursday: "Thursday",
  fri: "Friday",
  friday: "Friday",
  sat: "Saturday",
  saturday: "Saturday",
  sun: "Sunday",
  sunday: "Sunday",
};

function normalizeWeekday(day) {
  const normalized = String(day || "")
    .trim()
    .toLowerCase()
    .replace(/\./g, "");
  return WEEKDAY_LOOKUP[normalized] || "";
}

function getWeekdayCandidates(day) {
  const canonical = normalizeWeekday(day);
  if (!canonical) {
    return [String(day || "").trim()].filter(Boolean);
  }

  const lower = canonical.toLowerCase();
  const short = canonical.slice(0, 3);
  return Array.from(
    new Set([
      canonical,
      lower,
      short,
      short.toLowerCase(),
      `${short}.`,
      `${short.toLowerCase()}.`,
    ]),
  );
}

function normalizeStandalonePaperKind(value) {
  const normalized = String(value || "")
    .trim()
    .toUpperCase();
  if (!["TEST", "EXAM"].includes(normalized)) {
    throw createError(400, "paperKind must be TEST or EXAM.");
  }
  return normalized;
}

function normalizeSessionType(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (!["morning", "afternoon"].includes(normalized)) {
    throw createError(400, "sessionType must be morning or afternoon.");
  }
  return normalized;
}

function normalizeDateKey(value) {
  const normalized = String(value || "").trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(normalized);
  if (!match) {
    throw createError(400, "targetDate must use YYYY-MM-DD format.");
  }

  const parsed = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    12,
    0,
    0,
    0,
  );

  if (
    parsed.getFullYear() !== Number(match[1]) ||
    parsed.getMonth() !== Number(match[2]) - 1 ||
    parsed.getDate() !== Number(match[3])
  ) {
    throw createError(400, "targetDate is not a valid calendar date.");
  }

  return normalized;
}

function normalizeForMatch(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ");
}

function countWords(value) {
  return String(value || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

function toOptionLetter(index) {
  return index >= 0 && index <= 3 ? String.fromCharCode(65 + index) : "";
}

function getWeekdayFromDateKey(dateKey) {
  const normalized = normalizeDateKey(dateKey);
  const [year, month, day] = normalized.split("-").map((value) => Number(value));
  const parsed = new Date(year, month - 1, day, 12, 0, 0, 0);
  return new Intl.DateTimeFormat("en-US", { weekday: "long" }).format(parsed);
}

async function findTimetableForDate({ studentId, dateKey, populate = false }) {
  const targetDay = getWeekdayFromDateKey(dateKey);
  const dayCandidates = getWeekdayCandidates(targetDay);
  let query = Timetable.find({
    studentId,
    day: { $in: dayCandidates },
  });

  if (populate) {
    query = query
      .populate("morningSubject", "name icon color")
      .populate("afternoonSubject", "name icon color");
  }

  const matches = await query.lean();
  if (matches.length > 0) {
    return matches[0];
  }

  let fallbackQuery = Timetable.find({ studentId });
  if (populate) {
    fallbackQuery = fallbackQuery
      .populate("morningSubject", "name icon color")
      .populate("afternoonSubject", "name icon color");
  }
  const allEntries = await fallbackQuery.lean();
  const normalizedTarget = normalizeWeekday(targetDay);
  return (
    allEntries.find(
      (entry) => normalizeWeekday(entry.day) === normalizedTarget,
    ) || null
  );
}

function buildDefaultResponses(items) {
  return (Array.isArray(items) ? items : []).map((item, index) => ({
    itemIndex: index,
    itemType: String(item?.itemType || "").trim(),
    selectedOptionIndex: -1,
    textAnswer: "",
    flagged: false,
    answeredAt: null,
    teacherScorePercent: null,
    teacherFeedback: "",
  }));
}

function calculateSecondsRemaining(session) {
  if (!session?.endsAt) {
    return null;
  }
  return Math.max(
    0,
    Math.round(
      (new Date(session.endsAt).getTime() - getNow().getTime()) / 1000,
    ),
  );
}

function isResponseAnswered(response) {
  const itemType = String(response?.itemType || "")
    .trim()
    .toUpperCase();
  if (itemType === "OBJECTIVE") {
    return Number(response?.selectedOptionIndex) >= 0;
  }
  return String(response?.textAnswer || "").trim().length > 0;
}

function serializeIntegrityEvents(events) {
  return (Array.isArray(events) ? events : []).map((event) => ({
    eventType: String(event?.eventType || "").trim(),
    detail: String(event?.detail || "").trim(),
    actionTaken: String(event?.actionTaken || "").trim(),
    occurredAt: event?.occurredAt ? new Date(event.occurredAt).toISOString() : null,
    warningCountAfter: Number(event?.warningCountAfter || 0),
    leaveCountAfter: Number(event?.leaveCountAfter || 0),
  }));
}

function serializeSessionSummary(session) {
  if (!session) {
    return null;
  }

  const responses = Array.isArray(session.responses) ? session.responses : [];
  const answeredCount = responses.filter(isResponseAnswered).length;
  return {
    id: String(session._id || session.id || "").trim(),
    paperId: String(session.paperId || "").trim(),
    status: String(session.status || "").trim(),
    attemptNumber: Number(session.attemptNumber || 1),
    startedAt: session.startedAt ? new Date(session.startedAt).toISOString() : null,
    endsAt: session.endsAt ? new Date(session.endsAt).toISOString() : null,
    submittedAt: session.submittedAt
      ? new Date(session.submittedAt).toISOString()
      : null,
    lockedAt: session.lockedAt ? new Date(session.lockedAt).toISOString() : null,
    resetAt: session.resetAt ? new Date(session.resetAt).toISOString() : null,
    lastHeartbeatAt: session.lastHeartbeatAt
      ? new Date(session.lastHeartbeatAt).toISOString()
      : null,
    currentItemIndex: Number(session.currentItemIndex || 0),
    warningCount: Number(session.warningCount || 0),
    leaveCount: Number(session.leaveCount || 0),
    totalItems: Number(session.totalItems || 0),
    answeredCount,
    autoScorePercent: Number(session.autoScorePercent || 0),
    reviewStatus: String(session.reviewStatus || "not_needed").trim(),
    submittedReason: String(session.submittedReason || "").trim(),
    resultPackageId: String(session.resultPackageId || "").trim(),
    sessionLogId: String(session.sessionLogId || "").trim(),
    secondsRemaining: calculateSecondsRemaining(session),
    integrityEvents: serializeIntegrityEvents(session.integrityEvents),
    responses: responses.map((response) => ({
      itemIndex: Number(response?.itemIndex || 0),
      itemType: String(response?.itemType || "").trim(),
      selectedOptionIndex: Number(response?.selectedOptionIndex ?? -1),
      textAnswer: String(response?.textAnswer || "").trim(),
      flagged: response?.flagged == true,
      answeredAt: response?.answeredAt
        ? new Date(response.answeredAt).toISOString()
        : null,
      teacherScorePercent:
        response?.teacherScorePercent === null ||
        response?.teacherScorePercent === undefined
          ? null
          : Number(response.teacherScorePercent),
      teacherFeedback: String(response?.teacherFeedback || "").trim(),
    })),
  };
}

function serializeStudentPaper(paper) {
  const subject =
    paper?.subjectId && typeof paper.subjectId === "object"
      ? {
          id: String(paper.subjectId._id || paper.subjectId.id || "").trim(),
          name: String(paper.subjectId.name || "").trim(),
          icon: String(paper.subjectId.icon || "").trim(),
          color: String(paper.subjectId.color || "").trim(),
        }
      : null;

  return {
    id: String(paper?._id || paper?.id || "").trim(),
    paperKind: String(paper?.paperKind || "").trim(),
    sessionType: String(paper?.sessionType || "").trim(),
    title: String(paper?.title || "").trim(),
    teacherNote: String(paper?.teacherNote || "").trim(),
    sourceUnitText: String(paper?.sourceUnitText || "").trim(),
    targetDate: String(paper?.targetDate || "").trim(),
    durationMinutes: Number(paper?.durationMinutes || 0),
    subject,
    items: (Array.isArray(paper?.items) ? paper.items : []).map((item, index) => ({
      itemIndex: index,
      itemType: String(item?.itemType || "").trim(),
      learningText: String(item?.learningText || "").trim(),
      prompt: String(item?.prompt || "").trim(),
      options: Array.isArray(item?.options)
        ? item.options.map((option) => String(option || "").trim())
        : [],
      minWordCount: Number(item?.minWordCount || 0),
    })),
  };
}

function serializeAvailablePaper({ paper, latestSession }) {
  const subject =
    paper?.subjectId && typeof paper.subjectId === "object"
      ? {
          id: String(paper.subjectId._id || paper.subjectId.id || "").trim(),
          name: String(paper.subjectId.name || "").trim(),
          icon: String(paper.subjectId.icon || "").trim(),
          color: String(paper.subjectId.color || "").trim(),
        }
      : null;

  return {
    id: String(paper?._id || paper?.id || "").trim(),
    paperKind: String(paper?.paperKind || "").trim(),
    sessionType: String(paper?.sessionType || "").trim(),
    title: String(paper?.title || "").trim(),
    teacherNote: String(paper?.teacherNote || "").trim(),
    targetDate: String(paper?.targetDate || "").trim(),
    durationMinutes: Number(paper?.durationMinutes || 0),
    status: String(paper?.status || "draft").trim(),
    subject,
    latestSession: serializeSessionSummary(latestSession),
  };
}

async function loadLatestSessionsForPaperIds(paperIds) {
  const normalizedIds = Array.isArray(paperIds)
    ? paperIds.map((id) => String(id || "").trim()).filter(Boolean)
    : [];
  if (normalizedIds.length === 0) {
    return new Map();
  }

  const sessions = await StandalonePaperSession.find({
    paperId: { $in: normalizedIds },
  })
    .sort({ createdAt: -1 })
    .lean();

  const latestByPaperId = new Map();
  for (const session of sessions) {
    const paperId = String(session?.paperId || "").trim();
    if (!paperId || latestByPaperId.has(paperId)) {
      continue;
    }
    latestByPaperId.set(paperId, session);
  }
  return latestByPaperId;
}

async function assertTeacherOwnsPaper({
  teacherId,
  paperId,
  includeSubject = false,
}) {
  let query = StandalonePaper.findById(paperId);
  if (includeSubject) {
    query = query.populate("subjectId", "name icon color");
  }
  const paper = await query;
  if (!paper) {
    throw createError(404, "Standalone paper not found.");
  }
  if (String(paper.teacherId || "") !== String(teacherId || "")) {
    throw createError(403, "You do not have access to this standalone paper.");
  }
  return paper;
}

async function assertStudentOwnsPaper({
  studentId,
  paperId,
}) {
  const paper = await StandalonePaper.findById(paperId)
    .populate("subjectId", "name icon color")
    .lean();
  if (!paper) {
    throw createError(404, "Standalone paper not found.");
  }
  if (String(paper.studentId || "") !== String(studentId || "")) {
    throw createError(403, "You can only access your own standalone papers.");
  }
  return paper;
}

async function assertStudentCanOpenPublishedPaper({
  studentId,
  paper,
}) {
  const currentDateKey = getDateKey(getNow());
  if (String(paper.status || "").trim() !== "published") {
    throw createError(403, "This standalone paper is not published yet.");
  }

  if (String(paper.targetDate || "").trim() !== currentDateKey) {
    throw createError(
      403,
      "This standalone paper can only be started on its scheduled date.",
    );
  }

  const timetable = await findTimetableForDate({
    studentId,
    dateKey: currentDateKey,
    populate: false,
  });
  if (!timetable) {
    throw createError(403, "No lesson is scheduled for this student today.");
  }

  const sessionType = normalizeSessionType(paper.sessionType);
  const scheduledSubjectId =
    sessionType === "afternoon"
      ? timetable.afternoonSubject
      : timetable.morningSubject;

  if (
    !scheduledSubjectId ||
    String(scheduledSubjectId || "") !== String(paper.subjectId?._id || paper.subjectId || "")
  ) {
    throw createError(
      403,
      "This standalone paper is not available for the student's current lesson slot.",
    );
  }
}

async function loadSessionForStudent({
  studentId,
  sessionId,
}) {
  const session = await StandalonePaperSession.findById(sessionId);
  if (!session) {
    throw createError(404, "Standalone paper session not found.");
  }
  if (String(session.studentId || "") !== String(studentId || "")) {
    throw createError(
      403,
      "You can only access your own standalone paper session.",
    );
  }
  const paper = await StandalonePaper.findById(session.paperId)
    .populate("subjectId", "name icon color");
  if (!paper) {
    throw createError(404, "Standalone paper not found for this session.");
  }
  return { session, paper };
}

async function loadSessionForTeacher({
  teacherId,
  sessionId,
}) {
  const session = await StandalonePaperSession.findById(sessionId);
  if (!session) {
    throw createError(404, "Standalone paper session not found.");
  }
  if (String(session.teacherId || "") !== String(teacherId || "")) {
    throw createError(
      403,
      "You do not have access to this standalone paper session.",
    );
  }
  const paper = await StandalonePaper.findById(session.paperId)
    .populate("subjectId", "name icon color");
  if (!paper) {
    throw createError(404, "Standalone paper not found for this session.");
  }
  return { session, paper };
}

function buildQuestionEvidenceRows({
  paper,
  session,
}) {
  const items = Array.isArray(paper?.items) ? paper.items : [];
  const responseByIndex = new Map();
  for (const response of Array.isArray(session?.responses) ? session.responses : []) {
    responseByIndex.set(Number(response?.itemIndex || 0), response);
  }

  const questions = [];
  let answeredCount = 0;
  let autoScorableCount = 0;
  let autoScorePercentSum = 0;
  let theoryCount = 0;
  let scoredTheoryCount = 0;
  let theoryScorePercentSum = 0;
  let finalScorePercentSum = 0;

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const response = responseByIndex.get(index) || {};
    const itemType = String(item?.itemType || "").trim().toUpperCase();
    const attempted = isResponseAnswered({
      itemType,
      selectedOptionIndex: response?.selectedOptionIndex,
      textAnswer: response?.textAnswer,
    });
    if (attempted) {
      answeredCount += 1;
    }

    if (itemType === "OBJECTIVE") {
      const selectedIndex = Number(response?.selectedOptionIndex ?? -1);
      const correctIndex = Number(item?.correctIndex ?? -1);
      const correctness = attempted && selectedIndex === correctIndex;
      const itemScorePercent = correctness ? 100 : 0;
      autoScorableCount += 1;
      autoScorePercentSum += itemScorePercent;
      finalScorePercentSum += itemScorePercent;
      questions.push({
        itemType,
        questionText: String(item?.prompt || "").trim(),
        learnFirst: String(item?.learningText || "").trim(),
        explanation: String(item?.explanation || "").trim(),
        attempted,
        correctness,
        selectedOptionLetter: toOptionLetter(selectedIndex),
        selectedAnswer:
          selectedIndex >= 0 && selectedIndex < item.options.length
            ? String(item.options[selectedIndex] || "").trim()
            : "",
        correctOptionLetter: toOptionLetter(correctIndex),
        correctAnswer:
          correctIndex >= 0 && correctIndex < item.options.length
            ? String(item.options[correctIndex] || "").trim()
            : "",
        options: {
          A: String(item?.options?.[0] || "").trim(),
          B: String(item?.options?.[1] || "").trim(),
          C: String(item?.options?.[2] || "").trim(),
          D: String(item?.options?.[3] || "").trim(),
        },
        pointsEarned: correctness ? 1 : 0,
        maxPoints: 1,
        flagged: response?.flagged == true,
      });
      continue;
    }

    if (itemType === "FILL_GAP") {
      const studentAnswer = String(response?.textAnswer || "").trim();
      const acceptedAnswers = Array.isArray(item?.acceptedAnswers)
        ? item.acceptedAnswers.map((value) => String(value || "").trim())
        : [];
      const correctness =
        attempted &&
        acceptedAnswers.some(
          (answer) => normalizeForMatch(answer) === normalizeForMatch(studentAnswer),
        );
      const itemScorePercent = correctness ? 100 : 0;
      autoScorableCount += 1;
      autoScorePercentSum += itemScorePercent;
      finalScorePercentSum += itemScorePercent;
      questions.push({
        itemType,
        questionText: String(item?.prompt || "").trim(),
        learnFirst: String(item?.learningText || "").trim(),
        explanation: String(item?.explanation || "").trim(),
        attempted,
        correctness,
        studentAnswer,
        expectedAnswer: String(item?.expectedAnswer || "").trim(),
        acceptedAnswers,
        pointsEarned: correctness ? 1 : 0,
        maxPoints: 1,
        flagged: response?.flagged == true,
      });
      continue;
    }

    theoryCount += 1;
    const studentAnswer = String(response?.textAnswer || "").trim();
    const teacherScorePercent =
      response?.teacherScorePercent === null ||
      response?.teacherScorePercent === undefined
        ? null
        : Number(response.teacherScorePercent);
    const itemScorePercent =
      teacherScorePercent === null ? 0 : Math.max(0, Math.min(100, teacherScorePercent));
    if (teacherScorePercent !== null) {
      scoredTheoryCount += 1;
      theoryScorePercentSum += itemScorePercent;
    }
    finalScorePercentSum += itemScorePercent;
    questions.push({
      itemType,
      questionText: String(item?.prompt || "").trim(),
      learnFirst: String(item?.learningText || "").trim(),
      explanation: String(item?.explanation || "").trim(),
      attempted,
      studentAnswer,
      expectedAnswer: String(item?.expectedAnswer || "").trim(),
      minimumWordCount: Number(item?.minWordCount || 0),
      studentWordCount: countWords(studentAnswer),
      metMinimumWordCount:
        countWords(studentAnswer) >= Number(item?.minWordCount || 0),
      teacherScorePercent,
      teacherFeedback: String(response?.teacherFeedback || "").trim(),
      flagged: response?.flagged == true,
    });
  }

  const totalItems = items.length;
  const autoScorePercent =
    autoScorableCount > 0
      ? Math.round(autoScorePercentSum / autoScorableCount)
      : 0;
  const allTheoryScored = theoryCount === 0 || scoredTheoryCount === theoryCount;
  const overallScorePercent =
    totalItems > 0
      ? Math.round(finalScorePercentSum / totalItems)
      : 0;

  return {
    questions,
    totalItems,
    answeredCount,
    autoScorePercent,
    theoryCount,
    scoredTheoryCount,
    theoryAveragePercent:
      scoredTheoryCount > 0
        ? Number((theoryScorePercentSum / scoredTheoryCount).toFixed(1))
        : 0,
    overallScorePercent,
    equivalentCorrectCount:
      totalItems > 0 ? Math.round((overallScorePercent / 100) * totalItems) : 0,
    reviewStatus:
      theoryCount === 0 ? "scored" : allTheoryScored ? "scored" : "pending_review",
  };
}

async function storeResultPackageForSession({
  paper,
  session,
  student,
  subject,
  scoring,
}) {
  const submitTime = session.submittedAt || new Date();
  const durationSeconds = Math.max(
    0,
    Math.round((submitTime.getTime() - new Date(session.startedAt).getTime()) / 1000),
  );
  const evidence = {
    format: "STANDALONE_PAPER",
    paperId: String(paper._id || ""),
    paperKind: String(paper.paperKind || "").trim(),
    sessionType: String(paper.sessionType || "").trim(),
    targetDate: String(paper.targetDate || "").trim(),
    durationMinutes: Number(paper.durationMinutes || 0),
    leaveCount: Number(session.leaveCount || 0),
    warningCount: Number(session.warningCount || 0),
    submittedReason: String(session.submittedReason || "").trim(),
    reviewStatus: scoring.reviewStatus,
    averageTeacherScorePercent: scoring.theoryAveragePercent,
    overallScorePercent: scoring.overallScorePercent,
    questionsAnsweredCount: scoring.answeredCount,
    totalQuestions: scoring.totalItems,
    autoScorePercent: scoring.autoScorePercent,
    integrityEvents: serializeIntegrityEvents(session.integrityEvents),
    questions: scoring.questions,
  };

  const meta = {
    studentName: String(student?.name || "").trim(),
    studentId: String(student?._id || student?.id || "").trim(),
    teacherId: String(paper.teacherId || "").trim(),
    missionId: "",
    missionTitle: String(paper.title || "").trim(),
    subject: String(subject?.name || "").trim(),
    taskCodes: [String(paper.paperKind || "").trim()],
    assignedDate: String(paper.targetDate || "").trim(),
    startTime: session.startedAt,
    submitTime,
    durationSeconds,
    score: {
      correct: scoring.equivalentCorrectCount,
      total: scoring.totalItems,
      percent: scoring.overallScorePercent,
    },
    xpAwarded: 0,
  };

  if (String(session.resultPackageId || "").trim()) {
    await ResultPackage.findByIdAndUpdate(session.resultPackageId, {
      meta,
      evidence,
    });
    return ResultPackage.findById(session.resultPackageId).lean();
  }

  const resultPackage = await ResultPackage.create({
    studentId: paper.studentId,
    teacherId: paper.teacherId,
    missionId: null,
    sessionLogId: session.sessionLogId || null,
    subjectId: paper.subjectId?._id || paper.subjectId,
    resultKind: "paper_assessment",
    missionType: "QUESTIONS",
    meta,
    evidence,
    latestSendStatus: "not_sent",
  });
  session.resultPackageId = resultPackage._id;
  return resultPackage.toObject();
}

async function ensureSessionLogForSession({
  session,
  paper,
  scorePercent,
  equivalentCorrectCount,
}) {
  if (String(session.sessionLogId || "").trim()) {
    return session.sessionLogId;
  }

  const sessionLog = await SessionLog.create({
    studentId: paper.studentId,
    subjectId: paper.subjectId?._id || paper.subjectId,
    missionId: null,
    sessionType: paper.sessionType,
    focusScore: 0,
    dateKey: paper.targetDate,
    completedQuestions: Number(session.answeredCount || 0),
    correctAnswers: equivalentCorrectCount,
    scorePercent,
    missionQuestionCount: Number(session.totalItems || 0),
    attendanceXpAwarded: 0,
    challengeXpAwarded: 0,
    assessmentXpAwarded: 0,
    performanceXpBeforeStreak: 0,
    performanceXpAwarded: 0,
    performanceXpCumulative: 0,
    streakMultiplierApplied: 1,
    performanceQualifiedForStreak: false,
    targetXpAwarded: 0,
    subjectCompletionBonusXp: 0,
    totalXpAwarded: 0,
    behaviourStatus: "steady",
    notes: `Standalone ${String(paper.paperKind || "").trim().toLowerCase()} submission.`,
    xpAwarded: 0,
    createdBy: paper.studentId,
  });
  session.sessionLogId = sessionLog._id;
  return sessionLog._id;
}

async function submitStandalonePaperSessionInternal({
  session,
  paper,
  submitReason,
}) {
  if (!["active", "locked"].includes(String(session.status || "").trim())) {
    if (
      ["submitted", "time_expired"].includes(String(session.status || "").trim())
    ) {
      return {
        session,
        paper,
        alreadyFinalized: true,
      };
    }
    throw createError(
      400,
      "This standalone paper session cannot be submitted in its current state.",
    );
  }

  const now = getNow();
  const scoring = buildQuestionEvidenceRows({ paper, session });
  session.status =
    submitReason === "time_expired" ? "time_expired" : "submitted";
  session.submittedAt = now;
  session.submittedReason = submitReason;
  session.totalItems = scoring.totalItems;
  session.answeredCount = scoring.answeredCount;
  session.autoScorePercent = scoring.autoScorePercent;
  session.reviewStatus =
    scoring.reviewStatus === "pending_review" ? "pending_review" : "scored";
  await ensureSessionLogForSession({
    session,
    paper,
    scorePercent: scoring.overallScorePercent,
    equivalentCorrectCount: scoring.equivalentCorrectCount,
  });
  const [student, subject] = await Promise.all([
    User.findById(paper.studentId).select("name").lean(),
    Subject.findById(paper.subjectId).select("name").lean(),
  ]);
  const resultPackage = await storeResultPackageForSession({
    paper,
    session,
    student,
    subject,
    scoring,
  });
  await session.save();

  console.info("[standalone-paper-session] submitted", {
    sessionId: String(session._id || ""),
    paperId: String(paper._id || ""),
    submitReason,
    reviewStatus: scoring.reviewStatus,
    scorePercent: scoring.overallScorePercent,
  });

  return {
    session,
    paper,
    resultPackageId: String(resultPackage?._id || resultPackage?.id || "").trim(),
  };
}

async function resolveFreshSessionState({
  session,
  paper,
}) {
  if (
    String(session.status || "").trim() === "active" &&
    session.endsAt &&
    new Date(session.endsAt).getTime() <= getNow().getTime()
  ) {
    await submitStandalonePaperSessionInternal({
      session,
      paper,
      submitReason: "time_expired",
    });
  }
  return { session, paper };
}

async function listAvailableStandalonePapersForStudent({
  studentId,
  requesterId,
}) {
  if (String(studentId || "") !== String(requesterId || "")) {
    throw createError(
      403,
      "You can only view your own standalone papers.",
    );
  }

  const currentDateKey = getDateKey(getNow());
  const timetable = await findTimetableForDate({
    studentId,
    dateKey: currentDateKey,
    populate: true,
  });

  if (!timetable) {
    return [];
  }

  const papers = await StandalonePaper.find({
    studentId,
    status: "published",
    targetDate: currentDateKey,
  })
    .populate("subjectId", "name icon color")
    .sort({ publishedAt: -1, createdAt: -1 })
    .lean();

  const filtered = papers.filter((paper) => {
    const sessionType = String(paper?.sessionType || "").trim().toLowerCase();
    const scheduledSubjectId =
      sessionType === "afternoon"
        ? timetable.afternoonSubject?._id || timetable.afternoonSubject
        : timetable.morningSubject?._id || timetable.morningSubject;
    return String(scheduledSubjectId || "") === String(paper?.subjectId?._id || paper?.subjectId || "");
  });

  const latestSessionByPaperId = await loadLatestSessionsForPaperIds(
    filtered.map((paper) => String(paper._id || "")),
  );

  return filtered.map((paper) =>
    serializeAvailablePaper({
      paper,
      latestSession: latestSessionByPaperId.get(String(paper._id || "")) || null,
    }),
  );
}

async function startStandalonePaperSession({
  studentId,
  requesterId,
  paperId,
}) {
  if (String(studentId || "") !== String(requesterId || "")) {
    throw createError(
      403,
      "You can only start your own standalone papers.",
    );
  }

  const paper = await assertStudentOwnsPaper({
    studentId,
    paperId,
  });
  await assertStudentCanOpenPublishedPaper({
    studentId,
    paper,
  });

  const latestSession = await StandalonePaperSession.findOne({
    paperId,
  }).sort({ createdAt: -1 });

  if (
    latestSession &&
    ["active", "locked", "submitted", "time_expired"].includes(
      String(latestSession.status || "").trim(),
    )
  ) {
    const fresh = await resolveFreshSessionState({
      session: latestSession,
      paper,
    });
    return {
      paper: serializeStudentPaper(paper),
      session: serializeSessionSummary(fresh.session),
    };
  }

  const attemptNumber = latestSession ? Number(latestSession.attemptNumber || 1) + 1 : 1;
  const now = getNow();
  const durationMinutes = Number(paper.durationMinutes || 0);
  const endsAt =
    durationMinutes > 0
      ? new Date(now.getTime() + durationMinutes * 60 * 1000)
      : null;
  const session = await StandalonePaperSession.create({
    paperId: paper._id,
    teacherId: paper.teacherId,
    studentId: paper.studentId,
    subjectId: paper.subjectId?._id || paper.subjectId,
    paperKind: paper.paperKind,
    sessionType: paper.sessionType,
    targetDate: paper.targetDate,
    attemptNumber,
    status: "active",
    startedAt: now,
    endsAt,
    currentItemIndex: 0,
    warningCount: 0,
    leaveCount: 0,
    totalItems: Array.isArray(paper.items) ? paper.items.length : 0,
    answeredCount: 0,
    autoScorePercent: 0,
    reviewStatus:
      Array.isArray(paper.items) &&
      paper.items.some((item) => String(item?.itemType || "").trim() === "THEORY")
        ? "pending_review"
        : "not_needed",
    responses: buildDefaultResponses(paper.items),
  });

  console.info("[standalone-paper-session] started", {
    sessionId: String(session._id || ""),
    paperId: String(paper._id || ""),
    paperKind: String(paper.paperKind || ""),
    sessionType: String(paper.sessionType || ""),
  });

  return {
    paper: serializeStudentPaper(paper),
    session: serializeSessionSummary(session),
  };
}

async function getStandalonePaperSessionForStudent({
  studentId,
  requesterId,
  sessionId,
}) {
  if (String(studentId || "") !== String(requesterId || "")) {
    throw createError(
      403,
      "You can only view your own standalone paper session.",
    );
  }

  const { session, paper } = await loadSessionForStudent({
    studentId,
    sessionId,
  });
  await resolveFreshSessionState({ session, paper });
  return {
    paper: serializeStudentPaper(paper),
    session: serializeSessionSummary(session),
  };
}

async function saveStandalonePaperSessionProgress({
  studentId,
  requesterId,
  sessionId,
  payload,
}) {
  if (String(studentId || "") !== String(requesterId || "")) {
    throw createError(
      403,
      "You can only update your own standalone paper session.",
    );
  }

  const { session, paper } = await loadSessionForStudent({
    studentId,
    sessionId,
  });
  await resolveFreshSessionState({ session, paper });

  if (String(session.status || "").trim() !== "active") {
    return {
      paper: serializeStudentPaper(paper),
      session: serializeSessionSummary(session),
    };
  }

  const itemIndex = Number(payload?.itemIndex);
  if (
    !Number.isInteger(itemIndex) ||
    itemIndex < 0 ||
    itemIndex >= (Array.isArray(paper.items) ? paper.items.length : 0)
  ) {
    throw createError(400, "itemIndex is out of range for this paper.");
  }

  const response = Array.isArray(session.responses)
    ? session.responses.find((entry) => Number(entry?.itemIndex) === itemIndex)
    : null;
  if (!response) {
    throw createError(404, "Response entry not found for this paper item.");
  }

  const item = paper.items[itemIndex];
  const itemType = String(item?.itemType || "").trim().toUpperCase();
  if (itemType === "OBJECTIVE") {
    const selectedOptionIndex =
      payload?.selectedOptionIndex === null || payload?.selectedOptionIndex === undefined
        ? -1
        : Number(payload.selectedOptionIndex);
    if (
      !Number.isInteger(selectedOptionIndex) ||
      selectedOptionIndex < -1 ||
      selectedOptionIndex > 3
    ) {
      throw createError(
        400,
        "selectedOptionIndex must be between 0 and 3.",
      );
    }
    response.selectedOptionIndex = selectedOptionIndex;
    response.textAnswer = "";
  } else {
    response.textAnswer = String(payload?.textAnswer || "").trim();
    response.selectedOptionIndex = -1;
  }

  response.flagged = payload?.flagged == true;
  response.answeredAt = isResponseAnswered({
    itemType,
    selectedOptionIndex: response.selectedOptionIndex,
    textAnswer: response.textAnswer,
  })
    ? getNow()
    : null;

  if (
    payload?.currentItemIndex !== undefined &&
    payload?.currentItemIndex !== null
  ) {
    const currentItemIndex = Number(payload.currentItemIndex);
    if (
      Number.isInteger(currentItemIndex) &&
      currentItemIndex >= 0 &&
      currentItemIndex < paper.items.length
    ) {
      session.currentItemIndex = currentItemIndex;
    }
  }

  session.answeredCount = session.responses.filter(isResponseAnswered).length;
  session.lastHeartbeatAt = getNow();
  await session.save();

  return {
    paper: serializeStudentPaper(paper),
    session: serializeSessionSummary(session),
  };
}

async function recordStandalonePaperHeartbeat({
  studentId,
  requesterId,
  sessionId,
}) {
  if (String(studentId || "") !== String(requesterId || "")) {
    throw createError(
      403,
      "You can only update your own standalone paper session.",
    );
  }
  const { session, paper } = await loadSessionForStudent({
    studentId,
    sessionId,
  });
  await resolveFreshSessionState({ session, paper });
  if (String(session.status || "").trim() === "active") {
    session.lastHeartbeatAt = getNow();
    await session.save();
  }
  return {
    paper: serializeStudentPaper(paper),
    session: serializeSessionSummary(session),
  };
}

async function recordStandalonePaperIntegrityEvent({
  studentId,
  requesterId,
  sessionId,
  payload,
}) {
  if (String(studentId || "") !== String(requesterId || "")) {
    throw createError(
      403,
      "You can only update your own standalone paper session.",
    );
  }

  const { session, paper } = await loadSessionForStudent({
    studentId,
    sessionId,
  });
  await resolveFreshSessionState({ session, paper });

  if (String(session.status || "").trim() !== "active") {
    return {
      paper: serializeStudentPaper(paper),
      session: serializeSessionSummary(session),
      message: "This paper is no longer active.",
    };
  }

  const eventType = String(payload?.eventType || "").trim();
  const detail = String(payload?.detail || "").trim();
  const paperKind = normalizeStandalonePaperKind(paper.paperKind);
  session.leaveCount = Number(session.leaveCount || 0) + 1;

  let actionTaken = "logged";
  let message = "Integrity event logged.";

  if (paperKind === "EXAM") {
    actionTaken = "locked";
    message = "This exam was locked because the page was left.";
  } else if (Number(session.warningCount || 0) === 0) {
    session.warningCount = 1;
    actionTaken = "warned";
    message =
      "This test recorded one leave-page warning. Leaving again will lock it.";
  } else {
    actionTaken = "locked";
    message = "This test was locked because the page was left again.";
  }

  session.integrityEvents.push({
    eventType,
    detail,
    actionTaken,
    occurredAt: getNow(),
    warningCountAfter: Number(session.warningCount || 0),
    leaveCountAfter: Number(session.leaveCount || 0),
  });

  if (actionTaken === "locked") {
    session.status = "locked";
    session.lockedAt = getNow();
    session.submittedReason = "integrity_lock";
  }

  await session.save();

  return {
    paper: serializeStudentPaper(paper),
    session: serializeSessionSummary(session),
    message,
  };
}

async function submitStandalonePaperSession({
  studentId,
  requesterId,
  sessionId,
}) {
  if (String(studentId || "") !== String(requesterId || "")) {
    throw createError(
      403,
      "You can only submit your own standalone paper session.",
    );
  }
  const { session, paper } = await loadSessionForStudent({
    studentId,
    sessionId,
  });
  const submitted = await submitStandalonePaperSessionInternal({
    session,
    paper,
    submitReason: "manual_submit",
  });
  return {
    paper: serializeStudentPaper(submitted.paper),
    session: serializeSessionSummary(submitted.session),
    resultPackageId: String(submitted.resultPackageId || "").trim(),
  };
}

async function publishStandalonePaper({
  teacherId,
  paperId,
}) {
  const paper = await assertTeacherOwnsPaper({
    teacherId,
    paperId,
    includeSubject: true,
  });
  if (String(paper.status || "").trim() === "published") {
    return {
      paper,
    };
  }

  if (
    normalizeStandalonePaperKind(paper.paperKind) === "EXAM" &&
    Number(paper.durationMinutes || 0) <= 0
  ) {
    throw createError(400, "Exam papers must have a timer before publishing.");
  }

  paper.status = "published";
  paper.publishedAt = getNow();
  await paper.save();

  return {
    paper,
  };
}

async function unpublishStandalonePaper({
  teacherId,
  paperId,
}) {
  const paper = await assertTeacherOwnsPaper({
    teacherId,
    paperId,
    includeSubject: true,
  });
  const activeSession = await StandalonePaperSession.findOne({
    paperId,
    status: "active",
  })
    .sort({ createdAt: -1 })
    .lean();

  if (activeSession) {
    throw createError(
      409,
      "This standalone paper has an active student session and cannot be unpublished yet.",
    );
  }

  paper.status = "draft";
  paper.publishedAt = null;
  await paper.save();

  return {
    paper,
  };
}

async function getLatestStandalonePaperSessionForTeacher({
  teacherId,
  paperId,
}) {
  await assertTeacherOwnsPaper({
    teacherId,
    paperId,
  });
  const latestSession = await StandalonePaperSession.findOne({
    paperId,
  }).sort({ createdAt: -1 });

  if (!latestSession) {
    return null;
  }

  const { session, paper } = await loadSessionForTeacher({
    teacherId,
    sessionId: latestSession._id,
  });
  await resolveFreshSessionState({ session, paper });
  return serializeSessionSummary(session);
}

async function resetStandalonePaperSession({
  teacherId,
  sessionId,
}) {
  const { session } = await loadSessionForTeacher({
    teacherId,
    sessionId,
  });

  if (String(session.status || "").trim() === "active") {
    throw createError(
      409,
      "Active standalone paper sessions cannot be reset while the student is still inside.",
    );
  }

  if (String(session.status || "").trim() === "reset_by_teacher") {
    return {
      session: serializeSessionSummary(session),
    };
  }

  session.status = "reset_by_teacher";
  session.resetAt = getNow();
  await session.save();

  return {
    session: serializeSessionSummary(session),
  };
}

async function scoreStandalonePaperSession({
  teacherId,
  sessionId,
  payload,
}) {
  const { session, paper } = await loadSessionForTeacher({
    teacherId,
    sessionId,
  });

  if (!["submitted", "time_expired"].includes(String(session.status || "").trim())) {
    throw createError(
      409,
      "Only submitted standalone paper sessions can be reviewed.",
    );
  }

  const theoryItems = Array.isArray(paper.items)
    ? paper.items
        .map((item, index) => ({ item, index }))
        .filter(
          (entry) => String(entry.item?.itemType || "").trim().toUpperCase() === "THEORY",
        )
    : [];

  if (theoryItems.length === 0) {
    throw createError(
      400,
      "This standalone paper does not include any theory answers to review.",
    );
  }

  const reviews = Array.isArray(payload?.reviews) ? payload.reviews : [];
  const reviewByIndex = new Map();
  for (const review of reviews) {
    const itemIndex = Number(review?.itemIndex);
    const scorePercent = Number(review?.scorePercent);
    const feedback = String(review?.feedback || "").trim();
    if (!Number.isInteger(itemIndex) || itemIndex < 0) {
      throw createError(400, "Every reviewed theory answer needs a valid itemIndex.");
    }
    if (!Number.isFinite(scorePercent) || scorePercent < 0 || scorePercent > 100) {
      throw createError(
        400,
        "Every reviewed theory answer needs a scorePercent between 0 and 100.",
      );
    }
    reviewByIndex.set(itemIndex, {
      scorePercent: Math.round(scorePercent),
      feedback,
    });
  }

  for (const { index } of theoryItems) {
    if (!reviewByIndex.has(index)) {
      throw createError(
        400,
        `Theory item ${index + 1} needs a teacher score before review can be saved.`,
      );
    }
  }

  for (const response of Array.isArray(session.responses) ? session.responses : []) {
    const review = reviewByIndex.get(Number(response?.itemIndex || -1));
    if (!review) {
      continue;
    }
    response.teacherScorePercent = review.scorePercent;
    response.teacherFeedback = review.feedback;
  }

  const scoring = buildQuestionEvidenceRows({ paper, session });
  if (scoring.reviewStatus !== "scored") {
    throw createError(
      400,
      "All theory answers must be scored before this review can be finalized.",
    );
  }

  const [student, subject] = await Promise.all([
    User.findById(paper.studentId).select("name").lean(),
    Subject.findById(paper.subjectId).select("name").lean(),
  ]);
  await ensureSessionLogForSession({
    session,
    paper,
    scorePercent: scoring.overallScorePercent,
    equivalentCorrectCount: scoring.equivalentCorrectCount,
  });
  await storeResultPackageForSession({
    paper,
    session,
    student,
    subject,
    scoring,
  });
  session.reviewStatus = "scored";
  await session.save();

  return {
    session: serializeSessionSummary(session),
    resultPackageId: String(session.resultPackageId || "").trim(),
  };
}

module.exports = {
  listAvailableStandalonePapersForStudent,
  startStandalonePaperSession,
  getStandalonePaperSessionForStudent,
  saveStandalonePaperSessionProgress,
  recordStandalonePaperHeartbeat,
  recordStandalonePaperIntegrityEvent,
  submitStandalonePaperSession,
  publishStandalonePaper,
  unpublishStandalonePaper,
  getLatestStandalonePaperSessionForTeacher,
  resetStandalonePaperSession,
  scoreStandalonePaperSession,
};
