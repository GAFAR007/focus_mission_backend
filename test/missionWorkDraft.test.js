/**
 * WHAT:
 * Tests unfinished Theory and Essay Builder work normalization and ownership.
 * WHY:
 * Autosave must preserve exact text and guided progress without accepting
 * another learner's mission or weakening final submission validation.
 * HOW:
 * Exercise service helpers and mock the mission lookup boundary used by GET.
 */
const assert = require("node:assert/strict");
const test = require("node:test");

const Mission = require("../src/models/Mission");
const MissionWorkDraft = require("../src/models/MissionWorkDraft");
const missionWorkDraftService = require("../src/services/missionWorkDraft.service");
const resultService = require("../src/services/result.service");
const studentService = require("../src/services/student.service");

function queryReturning(value) {
  return { async lean() { return value; } };
}

test("Theory draft normalizes one question without requiring the full mission", () => {
  const [saved] = missionWorkDraftService.normalizeTheoryResponses(
    [{ questionIndex: 1, answerText: "  My exact answer stays here.  " }],
    3,
  );
  assert.equal(saved.questionIndex, 1);
  assert.equal(saved.answerText, "  My exact answer stays here.  ");
  assert.equal(saved.wordCount, 5);
});

test("Theory draft rejects response indexes outside the stored mission", () => {
  assert.throws(
    () => missionWorkDraftService.normalizeTheoryResponses(
      [{ questionIndex: 3, answerText: "No" }],
      3,
    ),
    /invalid questionIndex/,
  );
});

test("Theory answer saves independently and survives a later read", async () => {
  const originalMissionFindOne = Mission.findOne;
  const originalDraftFindOne = MissionWorkDraft.findOne;
  const originalSave = MissionWorkDraft.prototype.save;
  let persisted = null;
  const mission = {
    _id: "64b000000000000000000011",
    studentId: "64b000000000000000000012",
    subjectId: "64b000000000000000000013",
    draftFormat: "THEORY",
    questions: [{ prompt: "One" }, { prompt: "Two" }],
  };
  Mission.findOne = () => queryReturning(mission);
  MissionWorkDraft.findOne = () => persisted
    ? queryReturning(persisted)
    : Promise.resolve(null);
  MissionWorkDraft.prototype.save = async function saveDraftFixture() {
    persisted = this.toObject();
    persisted.updatedAt = new Date("2026-09-20T10:00:00.000Z");
    return this;
  };

  try {
    const saved = await missionWorkDraftService.saveMissionWorkDraft({
      studentId: mission.studentId,
      missionId: mission._id,
      payload: {
        theoryResponses: [{
          questionIndex: 1,
          answerText: "Exact  second answer.\nStill here.",
        }],
      },
    });
    const reloaded = await missionWorkDraftService.getMissionWorkDraft({
      studentId: mission.studentId,
      missionId: mission._id,
    });
    assert.equal(saved.theoryResponses.length, 1);
    assert.deepEqual(reloaded.theoryResponses, saved.theoryResponses);
    assert.equal(
      reloaded.theoryResponses[0].answerText,
      "Exact  second answer.\nStill here.",
    );
  } finally {
    Mission.findOne = originalMissionFindOne;
    MissionWorkDraft.findOne = originalDraftFindOne;
    MissionWorkDraft.prototype.save = originalSave;
  }
});

test("Essay draft saves guided selections, resume index, and exact final text", () => {
  const mission = {
    draftJson: {
      sentences: [
        {
          id: "s1",
          parts: [
            { type: "blank", blankId: "b1", options: { A: "one", B: "two", C: "three", D: "four" } },
          ],
        },
      ],
    },
  };
  const saved = missionWorkDraftService.normalizeEssayBuilder(
    {
      selectedAnswers: [{ sentenceId: "s1", blankId: "b1", selectedOption: "a" }],
      currentSentenceIndex: 1,
      finalEssayText: "Exact student wording.",
    },
    mission,
  );
  assert.deepEqual(saved.selectedAnswers, [
    { sentenceId: "s1", blankId: "b1", selectedOption: "A" },
  ]);
  assert.equal(saved.currentSentenceIndex, 1);
  assert.equal(saved.finalEssayText, "Exact student wording.");
  assert.equal(saved.finalEssayWordCount, 3);
});

test("Essay draft rejects a client-created blank or option", () => {
  const mission = {
    draftJson: {
      sentences: [{ id: "s1", parts: [{ type: "blank", blankId: "b1", options: { A: "one" } }] }],
    },
  };
  assert.throws(
    () => missionWorkDraftService.normalizeEssayBuilder(
      {
        selectedAnswers: [{ sentenceId: "s1", blankId: "fake", selectedOption: "A" }],
        currentSentenceIndex: 0,
        finalEssayText: "",
      },
      mission,
    ),
    /does not match this mission/,
  );
});

test("Essay guided progress and final text survive a later read", async () => {
  const originalMissionFindOne = Mission.findOne;
  const originalDraftFindOne = MissionWorkDraft.findOne;
  const originalSave = MissionWorkDraft.prototype.save;
  let persisted = null;
  const mission = {
    _id: "64b000000000000000000021",
    studentId: "64b000000000000000000022",
    subjectId: "64b000000000000000000023",
    draftFormat: "ESSAY_BUILDER",
    draftJson: {
      builder: {
        sentences: [{
          id: "s1",
          parts: [{
            type: "blank",
            blankId: "b1",
            options: { A: "one", B: "two" },
          }],
        }],
      },
    },
  };
  Mission.findOne = () => queryReturning(mission);
  MissionWorkDraft.findOne = () => persisted
    ? queryReturning(persisted)
    : Promise.resolve(null);
  MissionWorkDraft.prototype.save = async function saveDraftFixture() {
    persisted = this.toObject();
    persisted.updatedAt = new Date("2026-09-20T10:00:00.000Z");
    return this;
  };

  try {
    const saved = await missionWorkDraftService.saveMissionWorkDraft({
      studentId: mission.studentId,
      missionId: mission._id,
      payload: {
        essayBuilder: {
          selectedAnswers: [{
            sentenceId: "s1",
            blankId: "b1",
            selectedOption: "B",
          }],
          currentSentenceIndex: 1,
          finalEssayText: "Exact Essay draft.\nSecond line.",
        },
      },
    });
    const reloaded = await missionWorkDraftService.getMissionWorkDraft({
      studentId: mission.studentId,
      missionId: mission._id,
    });
    assert.deepEqual(reloaded.essayBuilder, saved.essayBuilder);
    assert.equal(reloaded.essayBuilder.currentSentenceIndex, 1);
    assert.equal(
      reloaded.essayBuilder.finalEssayText,
      "Exact Essay draft.\nSecond line.",
    );
  } finally {
    Mission.findOne = originalMissionFindOne;
    MissionWorkDraft.findOne = originalDraftFindOne;
    MissionWorkDraft.prototype.save = originalSave;
  }
});

test("final Theory submission still enforces each question minimum", () => {
  assert.throws(
    () => studentService.validateTheorySubmission(
      [{ minWordCount: 3 }],
      [{ questionIndex: 0, answerText: "only two" }],
    ),
    /at least 3 words/,
  );
  assert.doesNotThrow(() => studentService.validateTheorySubmission(
    [{ minWordCount: 3 }],
    [{ questionIndex: 0, answerText: "exactly three words" }],
  ));
});

test("final Essay submission keeps its existing 100-word minimum", () => {
  assert.throws(
    () => studentService.validateEssayBuilderSubmission({
      missionQuestionCount: 1,
      correctAnswers: 1,
      finalEssayText: Array.from({ length: 99 }, () => "word").join(" "),
    }),
    /at least 100 words/,
  );
  assert.doesNotThrow(() => studentService.validateEssayBuilderSubmission({
    missionQuestionCount: 1,
    correctAnswers: 1,
    finalEssayText: Array.from({ length: 100 }, () => "word").join(" "),
  }));
});

test("GET draft mission lookup is scoped to authenticated student ownership", async () => {
  const originalMissionFindOne = Mission.findOne;
  const originalDraftFindOne = MissionWorkDraft.findOne;
  let capturedFilter;
  Mission.findOne = (filter) => {
    capturedFilter = filter;
    return queryReturning({
      _id: "64b000000000000000000001",
      studentId: "64b000000000000000000002",
      subjectId: "64b000000000000000000003",
      draftFormat: "THEORY",
      questions: [{ prompt: "One" }, { prompt: "Two" }],
    });
  };
  MissionWorkDraft.findOne = () => queryReturning(null);

  try {
    const result = await missionWorkDraftService.getMissionWorkDraft({
      studentId: "64b000000000000000000002",
      missionId: "64b000000000000000000001",
    });
    assert.equal(capturedFilter.studentId, "64b000000000000000000002");
    assert.equal(result.status, "in_progress");
    assert.deepEqual(result.theoryResponses, []);
  } finally {
    Mission.findOne = originalMissionFindOne;
    MissionWorkDraft.findOne = originalDraftFindOne;
  }
});

test("GET draft does not fall back when the authenticated student does not own the mission", async () => {
  const originalMissionFindOne = Mission.findOne;
  Mission.findOne = () => queryReturning(null);
  try {
    await assert.rejects(
      missionWorkDraftService.getMissionWorkDraft({
        studentId: "64b000000000000000000099",
        missionId: "64b000000000000000000001",
      }),
      /Mission not found for this student/,
    );
  } finally {
    Mission.findOne = originalMissionFindOne;
  }
});

test("ResultPackage Theory evidence preserves every exact prompt and student answer", () => {
  const evidence = resultService.buildTheoryEvidence({
    missionQuestions: [
      { prompt: "Exact question one?", minWordCount: 2 },
      { prompt: "Exact question two?", minWordCount: 2 },
    ],
    theoryResponses: [
      {
        questionIndex: 0,
        answerText: "First  answer\nwith original spacing.",
        wordCount: 999,
      },
      {
        questionIndex: 1,
        answerText: "second Answer keeps Capitalisation",
      },
    ],
  });
  assert.deepEqual(
    evidence.questions.map((item) => item.questionText),
    ["Exact question one?", "Exact question two?"],
  );
  assert.equal(
    evidence.questions[0].studentAnswer,
    "First  answer\nwith original spacing.",
  );
  assert.equal(evidence.questions[0].studentWordCount, 5);
  assert.equal(
    evidence.questions[1].studentAnswer,
    "second Answer keeps Capitalisation",
  );
});

test("ResultPackage Essay evidence preserves exact final Essay text", () => {
  const exactEssay = "My Essay\n\nkeeps  spacing and Capitalisation.";
  const evidence = resultService.buildEssayEvidence({
    draftJson: {
      sentences: [
        {
          id: "s1",
          role: "topic",
          parts: [
            { type: "text", value: "Guided " },
            {
              type: "blank",
              blankId: "b1",
              options: { A: "fallback" },
              correctOption: "A",
            },
          ],
        },
      ],
    },
    essayBuilderEvidence: {
      finalEssayText: exactEssay,
      finalWordCount: 999,
      sentenceResponses: [
        {
          sentenceId: "s1",
          blankSelections: [{ blankId: "b1", selectedOption: "A" }],
        },
      ],
    },
  });
  assert.equal(evidence.finalEssayText, exactEssay);
  assert.equal(evidence.finalWordCount, 6);
});
