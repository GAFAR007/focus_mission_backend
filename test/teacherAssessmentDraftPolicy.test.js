/**
 * WHAT:
 * Tests the optional two-slot assessment-draft policy per task focus.
 * WHY:
 * One assessment must remain valid, Assessment B must stay optional, and only
 * a third draft for the same code may be rejected.
 * HOW:
 * Exercise pure count grouping and the server-side A/B creation resolver with
 * controlled Mission query results, including legacy overflow data.
 */

const assert = require("node:assert/strict");
const test = require("node:test");

const Mission = require("../src/models/Mission");
const teacherService = require("../src/services/teacher.service");
const { serializeMission } = require("../src/utils/missionSerializer");

function missionQueryReturning(drafts) {
  return {
    select() {
      return this;
    },
    async lean() {
      return drafts;
    },
  };
}

async function withAssessmentDrafts(drafts, callback) {
  const originalFind = Mission.find;
  Mission.find = () => missionQueryReturning(drafts);

  try {
    return await callback();
  } finally {
    Mission.find = originalFind;
  }
}

function creationInput(taskCodes = ["P1"]) {
  return {
    teacherId: "teacher-1",
    studentId: "student-1",
    subjectId: "subject-1",
    draftFormat: "QUESTIONS",
    questionCount: 10,
    taskCodes,
  };
}

test("assessment counts keep task codes independent", () => {
  assert.deepEqual(teacherService.countAssessmentDraftsByTaskCode([]), {});
  assert.deepEqual(
    teacherService.countAssessmentDraftsByTaskCode([{ taskCodes: ["P1"] }]),
    { P1: 1 },
  );
  assert.deepEqual(
    teacherService.countAssessmentDraftsByTaskCode([
      { taskCodes: ["P1"] },
      { taskCodes: ["P1"] },
    ]),
    { P1: 2 },
  );
  assert.deepEqual(
    teacherService.countAssessmentDraftsByTaskCode([
      { taskCodes: ["P1"] },
      { taskCodes: ["P1"] },
      { taskCodes: ["P1"] },
    ]),
    { P1: 3 },
  );
  assert.deepEqual(
    teacherService.countAssessmentDraftsByTaskCode([{ taskCodes: ["P1"] }]),
    { P1: 1 },
  );
  assert.equal(
    teacherService.countAssessmentDraftsByTaskCode([{ taskCodes: ["P1"] }])
      .P2,
    undefined,
  );
  assert.deepEqual(
    teacherService.countAssessmentDraftsByTaskCode([
      { taskCodes: ["P1"] },
      { taskCodes: ["P1"] },
    ]),
    { P1: 2 },
  );
});

test("first assessment receives sequence A automatically", async () => {
  await withAssessmentDrafts([], async () => {
    const metadata =
      await teacherService.resolveAssessmentDraftCreationMetadata(
        creationInput(),
      );

    assert.equal(metadata.title, "P1 Assessment A");
    assert.deepEqual(metadata.assessmentSequenceByTaskCode, { P1: "A" });
  });
});

test("one assessment remains valid and exposes optional sequence B", async () => {
  await withAssessmentDrafts([{ taskCodes: ["P1"] }], async () => {
    const metadata =
      await teacherService.resolveAssessmentDraftCreationMetadata(
        creationInput(),
      );

    assert.equal(metadata.title, "P1 Assessment B");
    assert.deepEqual(metadata.assessmentSequenceByTaskCode, { P1: "B" });
    assert.doesNotMatch(metadata.title, /required/i);
  });
});

test("a third assessment draft for one task code is rejected", async () => {
  await withAssessmentDrafts(
    [{ taskCodes: ["P1"] }, { taskCodes: ["P1"] }],
    async () => {
      await assert.rejects(
        teacherService.resolveAssessmentDraftCreationMetadata(creationInput()),
        (error) =>
          error.statusCode === 409 &&
          /P1 already has 2 assessment drafts/.test(error.message),
      );
    },
  );
});

test("legacy assessment overflow stays intact and rejects another draft", async () => {
  await withAssessmentDrafts(
    [
      { taskCodes: ["P1"] },
      { taskCodes: ["P1"] },
      { taskCodes: ["P1"] },
    ],
    async () => {
      await assert.rejects(
        teacherService.resolveAssessmentDraftCreationMetadata(creationInput()),
        (error) =>
          error.statusCode === 409 &&
          /P1 already has 3 assessment drafts/.test(error.message),
      );
    },
  );
});

test("a full P1 allocation does not block an empty P2 allocation", async () => {
  await withAssessmentDrafts(
    [{ taskCodes: ["P1"] }, { taskCodes: ["P1"] }],
    async () => {
      const metadata =
        await teacherService.resolveAssessmentDraftCreationMetadata(
          creationInput(["P2"]),
        );

      assert.equal(metadata.title, "P2 Assessment A");
      assert.deepEqual(metadata.assessmentSequenceByTaskCode, { P2: "A" });
    },
  );
});

test("assessment sequence identity survives mission serialization", () => {
  const payload = serializeMission({
    _id: "mission-1",
    title: "Teacher-edited title",
    sessionType: "morning",
    difficulty: "hard",
    draftFormat: "QUESTIONS",
    status: "draft",
    taskCodes: ["P1"],
    assessmentSequenceByTaskCode: new Map([["P1", "B"]]),
    questions: Array.from({ length: 10 }, (_, index) => ({
      _id: `question-${index + 1}`,
      prompt: `Question ${index + 1}`,
      options: ["A", "B", "C", "D"],
      correctIndex: 0,
    })),
  });

  assert.equal(payload.title, "Teacher-edited title");
  assert.deepEqual(payload.assessmentSequenceByTaskCode, { P1: "B" });
});
