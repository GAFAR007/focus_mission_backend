/**
 * WHAT:
 * Tests direct Populate importing for structured Essay Builder sentence blanks.
 * WHY:
 * Uploaded sentence previews must retain underscore placeholders so valid blank
 * sections import without a false preview-blank mismatch.
 * HOW:
 * Run a text upload through the public teacher source-plan service with mocked
 * ownership records, then inspect the resulting review-only mission draft.
 */

const assert = require("node:assert/strict");
const test = require("node:test");

const Subject = require("../src/models/Subject");
const Timetable = require("../src/models/Timetable");
const User = require("../src/models/User");
const teacherService = require("../src/services/teacher.service");

function queryReturning(value) {
  return {
    select() {
      return this;
    },
    async lean() {
      return value;
    },
  };
}

test("Populate imports one Essay Builder preview blank successfully", async () => {
  const teacherId = "teacher-1";
  const studentId = "student-1";
  const subjectId = "subject-1";
  const originalUserFindOne = User.findOne;
  const originalSubjectFindById = Subject.findById;
  const originalTimetableFindOne = Timetable.findOne;

  User.findOne = () => queryReturning({
    _id: teacherId,
    name: "Teacher One",
    role: "teacher",
  });
  Subject.findById = () => queryReturning({
    _id: subjectId,
    name: "Business",
    icon: "business",
    color: "blue",
  });
  Timetable.findOne = () => queryReturning({
    morningSubject: subjectId,
    morningTeacherId: teacherId,
  });

  const sourceText = `Business Online Essay
UNIT TEXT:
Businesses can use websites and digital tools to reach customers online.

Sentence 1: topic
Learn First Title: LEARN FIRST
Learn First Bullet 1: Online businesses can reach customers in different places.
Learn First Bullet 2: Websites let customers view products and services.
Learn First Bullet 3: Digital tools support communication and sales.
Sentence Preview: Businesses can operate online in ______ ways.
Blank 1:
Hint: Choose a word that describes more than one possible approach.
A) different
B) closed
C) paper
D) silent
Correct Answer: A) different`;

  try {
    const result = await teacherService.extractSourcePlan(teacherId, {
      subjectId,
      studentId,
      targetDate: "2099-01-05",
      sessionType: "morning",
      uploadMode: "populate_draft",
      draftFormat: "ESSAY_BUILDER",
      essayMode: "NORMAL",
      taskCodes: '["P1"]',
      missionDraftId: "existing-draft",
      file: {
        originalname: "business-online-essay.txt",
        mimetype: "text/plain",
        buffer: Buffer.from(sourceText, "utf8"),
      },
    });

    assert.equal(result.draftReadiness.status, "ready");
    assert.deepEqual(result.draftReadiness.missingRequirements, []);
    assert.ok(result.prefilledMission);
    assert.deepEqual(result.prefilledMission.taskCodes, ["P1"]);
    assert.equal(result.prefilledMission.draftJson.sentences.length, 1);

    const [sentence] = result.prefilledMission.draftJson.sentences;
    const previewBlanks = sentence.parts.filter((part) => part.type === "blank");

    assert.equal(previewBlanks.length, 1);
    assert.match(
      previewBlanks[0].hint,
      /^Choose a word that describes more than one possible approach\./,
    );
    assert.equal(previewBlanks[0].correctOption, "A");
    assert.equal(previewBlanks[0].options.A, "different");
  } finally {
    User.findOne = originalUserFindOne;
    Subject.findById = originalSubjectFindById;
    Timetable.findOne = originalTimetableFindOne;
  }
});
