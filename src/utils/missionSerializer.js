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
function serializeMissionQuestion(question, index = 0) {
  return {
    id: String(question._id || question.id || `question-${index + 1}`),
    learningText: question.learningText || question.lessonText || question.explanation || "",
    prompt: question.prompt || question.question || "",
    options: Array.isArray(question.options) ? question.options : [],
    correctIndex: Number(question.correctIndex || 0),
    explanation: question.explanation || "",
  };
}

function serializeMission(mission) {
  const subject = mission.subjectId && typeof mission.subjectId === "object"
    ? mission.subjectId
    : null;
  const questionCount = (mission.questions || []).length;
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
    questions: (mission.questions || []).map(serializeMissionQuestion),
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
        },
        index,
      )),
  };
}

module.exports = {
  buildQuestionBankMission,
  serializeMission,
};
