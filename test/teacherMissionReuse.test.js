/**
 * WHAT:
 * Tests safe teacher mission-draft reuse, objective-order variation, and full
 * authorised-student discovery.
 * WHY:
 * Reusing reviewed work must create an independent target-student draft while
 * preserving correct answers, question media, timetable ownership, and source
 * immutability.
 * HOW:
 * Exercise deterministic shuffle helpers and the service boundary with mocked
 * persistence so scheduling, copying, duplicate, Theory, and Essay rules are
 * verified without modifying live data.
 */

const assert = require("node:assert/strict");
const test = require("node:test");

const Mission = require("../src/models/Mission");
const Timetable = require("../src/models/Timetable");
const User = require("../src/models/User");
const subjectCertificationService = require(
  "../src/services/subjectCertification.service",
);
const teacherService = require("../src/services/teacher.service");

function queryReturning(value) {
  return {
    select() {
      return this;
    },
    sort() {
      return this;
    },
    populate() {
      return this;
    },
    async lean() {
      return value;
    },
  };
}

function objectiveQuestion({
  prompt,
  correctIndex = 0,
  video = "",
  marker = prompt,
}) {
  return {
    answerMode: "multiple_choice",
    learningText: `Learn ${marker}`,
    learningVideoUrl: video,
    learningVideoPlacement: "afterLearnFirst",
    prompt,
    options: [
      `${marker} correct`,
      `${marker} fruit`,
      `${marker} building`,
      `${marker} book`,
    ],
    correctIndex,
    explanation: `Explain ${marker}`,
    expectedAnswer: "",
    minWordCount: 0,
  };
}

function buildSourceMission(overrides = {}) {
  return {
    _id: "source-mission",
    studentId: "source-student",
    subjectId: "business-subject",
    sessionType: "morning",
    title: "Business Q8 Revision",
    teacherNote: "Review business ownership.",
    sourceUnitText: "Business teaching content.",
    sourceRawText: "Full uploaded business teaching content.",
    sourceFileName: "business.txt",
    sourceFileType: "text/plain",
    draftFormat: "QUESTIONS",
    essayMode: null,
    draftJson: null,
    source: "groq",
    status: "draft",
    aiModel: "reviewed-model",
    availableOnDate: "2098-12-01",
    availableOnDay: "Monday",
    difficulty: "hard",
    taskCodes: ["P1", "P2"],
    xpReward: 35,
    questions: [
      objectiveQuestion({
        prompt: "What is a car?",
        marker: "car",
        video: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      }),
      objectiveQuestion({ prompt: "What is revenue?", marker: "revenue" }),
    ],
    createdBy: "teacher-1",
    ...overrides,
  };
}

async function withReusePersistence(
  sourceMission,
  callback,
  {
    duplicateMission = null,
    teacherAssignedStudents = ["target-student"],
    assessmentDrafts = [],
  } = {},
) {
  const originals = {
    missionFindOne: Mission.findOne,
    missionFind: Mission.find,
    missionCreate: Mission.create,
    missionFindById: Mission.findById,
    timetableFindOne: Timetable.findOne,
    userFindOne: User.findOne,
    getCertification:
      subjectCertificationService.getStudentSubjectCertificationContext,
    buildCertification:
      subjectCertificationService.buildMissionCertificationSnapshot,
  };
  let createdPayload;
  let timetableFilter;

  Mission.findOne = (filter) => queryReturning(
    filter.reusedFromMissionId ? duplicateMission : sourceMission,
  );
  Mission.find = () => queryReturning(assessmentDrafts);
  Mission.create = async (payload) => {
    createdPayload = payload;
    return { _id: "target-mission" };
  };
  Mission.findById = () => queryReturning({
    ...createdPayload,
    _id: "target-mission",
    subjectId: {
      _id: "business-subject",
      name: "Business",
      icon: "business",
      color: "blue",
    },
    createdAt: new Date("2098-01-01T00:00:00.000Z"),
  });
  User.findOne = (filter) => queryReturning(
    filter.role === "teacher"
      ? {
          _id: "teacher-1",
          role: "teacher",
          assignedStudents: teacherAssignedStudents,
        }
      : {
          _id: "target-student",
          name: "Ahmed Stockwin",
          role: "student",
        },
  );
  Timetable.findOne = (filter) => {
    timetableFilter = filter;
    return queryReturning({
      morningSubject: "business-subject",
      morningTeacherId: "teacher-1",
      afternoonSubject: "other-subject",
      afternoonTeacherId: "other-teacher",
    });
  };
  subjectCertificationService.getStudentSubjectCertificationContext =
    async ({ studentId, subjectId }) => ({ studentId, subjectId });
  subjectCertificationService.buildMissionCertificationSnapshot = (context) => ({
    certificationPlanId: "target-plan",
    certificationPlanVersion: 4,
    certificationPlanSource: "teacher_plan",
    certificationLabelSnapshot: "Target qualification",
    certificationRequiredTaskCodesSnapshot: ["P1", "P2"],
  });

  try {
    return await callback({
      get createdPayload() {
        return createdPayload;
      },
      get timetableFilter() {
        return timetableFilter;
      },
    });
  } finally {
    Mission.findOne = originals.missionFindOne;
    Mission.find = originals.missionFind;
    Mission.create = originals.missionCreate;
    Mission.findById = originals.missionFindById;
    Timetable.findOne = originals.timetableFindOne;
    User.findOne = originals.userFindOne;
    subjectCertificationService.getStudentSubjectCertificationContext =
      originals.getCertification;
    subjectCertificationService.buildMissionCertificationSnapshot =
      originals.buildCertification;
  }
}

test("question shuffle moves each complete teaching block together", () => {
  const source = buildSourceMission().questions;
  const snapshot = JSON.stringify(source);
  const shuffled = teacherService.shuffleMissionQuestions(source, {
    shuffleQuestionOrder: true,
    random: () => 0.999999,
  });

  assert.deepEqual(
    shuffled.map((question) => question.prompt),
    ["What is revenue?", "What is a car?"],
  );
  const car = shuffled.find((question) => question.prompt === "What is a car?");
  assert.equal(car.learningText, "Learn car");
  assert.equal(car.explanation, "Explain car");
  assert.equal(
    car.learningVideoUrl,
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  );
  assert.equal(car.learningVideoPlacement, "afterLearnFirst");
  assert.equal(JSON.stringify(source), snapshot);
});

test("car correct answer follows its shuffled A/B/C/D position", () => {
  const [car] = teacherService.shuffleMissionQuestions(
    [buildSourceMission().questions[0]],
    { shuffleAnswerOptions: true, random: () => 0 },
  );
  const correctText = "car correct";
  const newCorrectIndex = car.options.indexOf(correctText);
  const submitAnswer = (selectedIndex) => selectedIndex === car.correctIndex;

  assert.notDeepEqual(car.options, buildSourceMission().questions[0].options);
  assert.equal(car.correctIndex, newCorrectIndex);
  assert.notEqual(newCorrectIndex, 0);
  assert.equal(car.options[car.correctIndex], correctText);
  assert.equal(submitAnswer(newCorrectIndex), true);
  assert.equal(submitAnswer(0), false);
});

test("requested shuffles cannot remain identical and do not retry forever", () => {
  let randomCalls = 0;
  const random = () => {
    randomCalls += 1;
    return 0.999999;
  };
  const source = buildSourceMission().questions;
  const shuffled = teacherService.shuffleMissionQuestions(source, {
    shuffleQuestionOrder: true,
    shuffleAnswerOptions: true,
    random,
  });

  assert.notDeepEqual(
    shuffled.map((question) => question.prompt),
    source.map((question) => question.prompt),
  );
  for (const question of shuffled) {
    const original = source.find((item) => item.prompt === question.prompt);
    assert.notDeepEqual(question.options, original.options);
  }
  assert.equal(randomCalls, 7);
});

test("keeping objective order still returns independent question copies", () => {
  const source = buildSourceMission().questions;
  const copied = teacherService.shuffleMissionQuestions(source);

  assert.deepEqual(copied, source);
  assert.notEqual(copied, source);
  assert.notEqual(copied[0], source[0]);
  assert.notEqual(copied[0].options, source[0].options);
});

test("reuse creates a new target draft with stable persisted variation", async () => {
  const source = buildSourceMission();
  const sourceSnapshot = JSON.stringify(source);

  await withReusePersistence(source, async (state) => {
    const result = await teacherService.reuseMissionDraft(
      "teacher-1",
      "source-mission",
      {
        targetStudentId: "target-student",
        targetDate: "2099-01-05",
        sessionType: "morning",
        shuffleQuestionOrder: true,
        shuffleAnswerOptions: true,
      },
    );

    assert.equal(result.id, "target-mission");
    assert.equal(state.createdPayload.studentId, "target-student");
    assert.equal(state.createdPayload.subjectId, "business-subject");
    assert.deepEqual(state.createdPayload.taskCodes, ["P1", "P2"]);
    assert.ok(state.createdPayload.taskFocusAssignedAt instanceof Date);
    assert.equal(state.createdPayload.difficulty, "hard");
    assert.equal(state.createdPayload.sourceUnitText, source.sourceUnitText);
    assert.equal(state.createdPayload.reusedFromMissionId, source._id);
    assert.equal(state.createdPayload.status, "draft");
    assert.equal(state.createdPayload.certificationPlanId, "target-plan");
    assert.equal(state.createdPayload.availableOnDate, "2099-01-05");
    assert.equal(state.createdPayload.sessionType, "morning");
    assert.equal(state.timetableFilter.studentId, "target-student");
    assert.equal(JSON.stringify(source), sourceSnapshot);
    assert.deepEqual(
      result.questions.map((question) => ({
        prompt: question.prompt,
        options: question.options,
        correctIndex: question.correctIndex,
      })),
      state.createdPayload.questions.map((question) => ({
        prompt: question.prompt,
        options: question.options,
        correctIndex: question.correctIndex,
      })),
    );
    assert.notDeepEqual(
      result.questions.map((question) => question.prompt),
      source.questions.map((question) => question.prompt),
    );
    for (const question of result.questions) {
      const sourceQuestion = source.questions.find(
        (item) => item.prompt === question.prompt,
      );
      assert.equal(
        question.options[question.correctIndex],
        sourceQuestion.options[sourceQuestion.correctIndex],
      );
    }
  });
});

test("reuse rejects a duplicate source, target, date, and session", async () => {
  await withReusePersistence(
    buildSourceMission(),
    async () => {
      await assert.rejects(
        teacherService.reuseMissionDraft("teacher-1", "source-mission", {
          targetStudentId: "target-student",
          targetDate: "2099-01-05",
          sessionType: "morning",
        }),
        (error) =>
          error.statusCode === 409 && /already been reused/.test(error.message),
      );
    },
    { duplicateMission: { _id: "existing-copy" } },
  );
});

test("reuse rejects a target slot whose timetable subject does not match", async () => {
  const originalTimetableFindOne = Timetable.findOne;

  await withReusePersistence(buildSourceMission(), async () => {
    Timetable.findOne = () => queryReturning({
      morningSubject: "maths-subject",
      morningTeacherId: "teacher-1",
    });

    await assert.rejects(
      teacherService.reuseMissionDraft("teacher-1", "source-mission", {
        targetStudentId: "target-student",
        targetDate: "2099-01-05",
        sessionType: "morning",
      }),
      (error) =>
        error.statusCode === 403 && /subject scheduled/.test(error.message),
    );
  });

  Timetable.findOne = originalTimetableFindOne;
});

test("Q10 reuse keeps optional target-student Assessment A/B limits separate", async () => {
  const questions = Array.from({ length: 10 }, (_, index) =>
    objectiveQuestion({
      prompt: `Assessment question ${index + 1}`,
      marker: `assessment-${index + 1}`,
    }),
  );
  const source = buildSourceMission({
    title: "P1 Assessment A",
    taskCodes: ["P1"],
    questions,
  });

  await withReusePersistence(
    source,
    async (state) => {
      await teacherService.reuseMissionDraft(
        "teacher-1",
        "source-mission",
        {
          targetStudentId: "target-student",
          targetDate: "2099-01-05",
          sessionType: "morning",
        },
      );

      assert.equal(state.createdPayload.title, "P1 Assessment B");
      assert.deepEqual(state.createdPayload.assessmentSequenceByTaskCode, {
        P1: "B",
      });
    },
    { assessmentDrafts: [{ taskCodes: ["P1"] }] },
  );
});

test("Theory reuse ignores objective shuffle flags and preserves content", async () => {
  const theoryQuestions = [
    {
      answerMode: "short_answer",
      learningText: "Learn how revenue is earned.",
      learningVideoUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      learningVideoPlacement: "beforeLearnFirst",
      prompt: "Explain revenue.",
      options: [],
      correctIndex: -1,
      explanation: "Look for income from sales.",
      expectedAnswer: "Revenue is income earned from sales.",
      minWordCount: 12,
    },
    {
      answerMode: "short_answer",
      learningText: "Learn why costs matter.",
      learningVideoUrl: "",
      learningVideoPlacement: "afterLearnFirst",
      prompt: "Explain a business cost.",
      options: [],
      correctIndex: -1,
      explanation: "Look for money spent.",
      expectedAnswer: "A cost is money a business spends.",
      minWordCount: 12,
    },
  ];
  const source = buildSourceMission({
    draftFormat: "THEORY",
    questions: theoryQuestions,
  });

  await withReusePersistence(source, async (state) => {
    await teacherService.reuseMissionDraft("teacher-1", "source-mission", {
      targetStudentId: "target-student",
      targetDate: "2099-01-05",
      sessionType: "morning",
      shuffleQuestionOrder: true,
      shuffleAnswerOptions: true,
    });

    assert.deepEqual(state.createdPayload.questions, theoryQuestions);
    assert.equal(state.createdPayload.questions[0].correctIndex, -1);
    assert.deepEqual(state.createdPayload.questions[0].options, []);
  });
});

test("Essay Builder reuse deep-copies its saved structure without shuffling", async () => {
  const draftJson = {
    targets: { targetSentenceCount: 15 },
    sentences: [
      {
        learnFirst: "Learn the sentence structure.",
        parts: [{ type: "blank", options: { A: "one", B: "two" } }],
      },
    ],
  };
  const source = buildSourceMission({
    draftFormat: "ESSAY_BUILDER",
    essayMode: "STRETCH_15",
    draftJson,
    questions: [],
  });

  await withReusePersistence(source, async (state) => {
    await teacherService.reuseMissionDraft("teacher-1", "source-mission", {
      targetStudentId: "target-student",
      targetDate: "2099-01-05",
      sessionType: "morning",
      shuffleQuestionOrder: true,
      shuffleAnswerOptions: true,
    });

    assert.deepEqual(state.createdPayload.draftJson, draftJson);
    assert.notEqual(state.createdPayload.draftJson, draftJson);
    assert.deepEqual(state.createdPayload.questions, []);
    assert.equal(state.createdPayload.essayMode, "STRETCH_15");
  });
});

test("student discovery returns every authorised active assignment without pagination", async () => {
  const originalFindOne = User.findOne;
  const originalFind = User.find;
  let studentFilter;
  let limitWasCalled = false;
  const assignedStudents = ["jace-id", "ahmed-id", "sudais-id"];
  const students = [
    { _id: "ahmed-id", name: "Ahmed Stockwin", yearGroup: "Year 10" },
    { _id: "jace-id", name: "Jace Mckenzie", yearGroup: "Year 10" },
    { _id: "sudais-id", name: "Sudais Dahir", yearGroup: "Year 9" },
  ];

  User.findOne = () => queryReturning({
    _id: "teacher-1",
    role: "teacher",
    assignedStudents,
  });
  User.find = (filter) => {
    studentFilter = filter;
    const query = queryReturning(students);
    query.limit = () => {
      limitWasCalled = true;
      return query;
    };
    return query;
  };

  try {
    const result = await teacherService.listStudents("teacher-1");
    assert.deepEqual(result, students);
    assert.deepEqual(studentFilter._id.$in, assignedStudents);
    assert.deepEqual(studentFilter.isArchived, { $ne: true });
    assert.equal(limitWasCalled, false);
    assert.ok(result.some((student) => student.name === "Sudais Dahir"));
  } finally {
    User.findOne = originalFindOne;
    User.find = originalFind;
  }
});
