/**
 * WHAT:
 * missionSerializer converts stored and fallback mission data into the stable
 * payload shape used by the frontend mission player.
 * WHY:
 * Students should see one consistent mission contract whether the lesson comes
 * from teacher-authored AI content or the fallback question bank.
 * HOW:
 * Normalize mission questions, map subject metadata, and build a fallback bank
 * mission when no saved teacher mission is available.
 */
function serializeMissionQuestion(question, index = 0, draftFormat = "QUESTIONS") {
  const options = Array.isArray(question.options) ? question.options : [];
  const normalizedDraftFormat = String(draftFormat || "QUESTIONS")
    .trim()
    .toUpperCase();
  const explicitAnswerMode = String(question.answerMode || "")
    .trim()
    .toLowerCase();
  const answerMode = explicitAnswerMode ||
    (
      normalizedDraftFormat === "THEORY" ? "short_answer" : "multiple_choice"
    );
  const fallbackCorrectIndex = Number(question.correctIndex);
  const expectedAnswer = String(
    question.expectedAnswer ||
      (
        Number.isInteger(fallbackCorrectIndex) &&
        fallbackCorrectIndex >= 0 &&
        fallbackCorrectIndex < options.length ?
          options[fallbackCorrectIndex]
        : question.explanation
      ) ||
      "",
  ).trim();
  const minWordCount = Math.max(
    0,
    Number(question.minWordCount || (normalizedDraftFormat === "THEORY" ? 12 : 0)) || 0,
  );
  return {
    id: String(question._id || question.id || `question-${index + 1}`),
    answerMode,
    learningText: question.learningText || question.lessonText || question.explanation || "",
    prompt: question.prompt || question.question || "",
    options: answerMode === "short_answer" ? [] : options,
    correctIndex: answerMode === "short_answer" ? -1 : Number(question.correctIndex || 0),
    explanation: question.explanation || "",
    expectedAnswer,
    minWordCount,
  };
}

function serializeMission(mission) {
  const subject = mission.subjectId && typeof mission.subjectId === "object"
    ? mission.subjectId
    : null;
  const essayTargetCount = mission.draftFormat === "ESSAY_BUILDER"
    ? Number(mission?.draftJson?.targets?.targetSentenceCount || 0)
    : 0;
  const questionCount =
    essayTargetCount > 0 ? essayTargetCount : (mission.questions || []).length;
  const scoreTotal = Number(mission.latestScoreTotal || 0) > 0
    ? Number(mission.latestScoreTotal || 0)
    : questionCount;
  const scoreCorrect = Math.max(
    0,
    Math.min(Number(mission.latestScoreCorrect || 0), scoreTotal),
  );
  const scorePercent = scoreTotal > 0
    ? Math.round((scoreCorrect / scoreTotal) * 100)
    : 0;
  const xpReward = Number(mission.xpReward || 20);
  const xpEarned = Math.max(
    0,
    Math.min(Number(mission.latestXpEarned || 0), xpReward),
  );

  return {
    id: String(mission._id || mission.id || ""),
    title: mission.title,
    teacherNote: mission.teacherNote || "",
    sourceUnitText: mission.sourceUnitText || "",
    sourceRawText: mission.sourceRawText || "",
    sourceFileName: mission.sourceFileName || "",
    sourceFileType: mission.sourceFileType || "",
    draftFormat: mission.draftFormat || "QUESTIONS",
    essayMode: mission.essayMode || "",
    draftJson: mission.draftJson || null,
    source: mission.source || "bank",
    status: mission.status || "published",
    aiModel: mission.aiModel || "",
    sessionType: mission.sessionType,
    difficulty: mission.difficulty || "medium",
    taskCodes: Array.isArray(mission.taskCodes) ? mission.taskCodes : [],
    xpReward,
    xpEarned,
    scoreCorrect,
    scoreTotal,
    scorePercent,
    latestResultPackageId: mission.latestResultPackageId
      ? String(mission.latestResultPackageId)
      : "",
    createdAt: mission.createdAt
      ? new Date(mission.createdAt).toISOString()
      : null,
    publishedAt: mission.publishedAt
      ? new Date(mission.publishedAt).toISOString()
      : null,
    availableOnDate: mission.availableOnDate || "",
    availableOnDay: mission.availableOnDay || "",
    subject: subject
      ? {
          id: String(subject._id || subject.id || ""),
          name: subject.name || "",
          icon: subject.icon || "",
          color: subject.color || "",
        }
      : null,
    questionCount,
    questions: (mission.questions || []).map((question, index) =>
      serializeMissionQuestion(question, index, mission.draftFormat || "QUESTIONS")
    ),
  };
}

function buildQuestionBankMission({
  subject,
  sessionType,
  difficulty = "medium",
  questions,
}) {
  return {
    id: `bank-${String(subject._id || subject.id || "")}-${sessionType}`,
    title: `${subject.name} Practice Mission`,
    teacherNote: "Answer the mission questions and keep your focus steady.",
    sourceUnitText: "",
    sourceRawText: "",
    sourceFileName: "",
    sourceFileType: "",
    draftFormat: "QUESTIONS",
    essayMode: "",
    draftJson: null,
    source: "bank",
    status: "published",
    aiModel: "",
    sessionType,
    difficulty,
    taskCodes: [],
    xpReward: 20,
    xpEarned: 0,
    scoreCorrect: 0,
    scoreTotal: questions.length,
    scorePercent: 0,
    latestResultPackageId: "",
    createdAt: null,
    publishedAt: null,
    availableOnDate: "",
    availableOnDay: "",
    subject: {
      id: String(subject._id || subject.id || ""),
      name: subject.name || "",
      icon: subject.icon || "",
      color: subject.color || "",
    },
    questionCount: questions.length,
    questions: questions.map((question, index) =>
      serializeMissionQuestion(
        {
          id: question._id,
          answerMode: "multiple_choice",
          learningText:
            question.learningText ||
            question.explanation ||
            // WHY: The fallback bank still needs a teach-first experience so
            // the student sees a learning cue before answering.
            `Read this first: this ${subject.name.toLowerCase()} question is based on the lesson content for today.`,
          prompt: question.question,
          options: question.options,
          correctIndex: question.correctIndex,
          explanation:
            question.explanation ||
            `The correct answer is ${question.options?.[question.correctIndex] || "the saved answer"}.`,
          expectedAnswer: "",
          minWordCount: 0,
        },
        index,
      )),
  };
}

module.exports = {
  buildQuestionBankMission,
  serializeMission,
};
