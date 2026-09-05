/**
 * WHAT:
 * Tests the new Business Task Focus boundary and teacher pathway query scope.
 * WHY:
 * New Business work must be explicitly teacher-tagged, while old missions stay
 * readable and pathway viewing must never infer achievement or leak subjects.
 * HOW:
 * Exercise the validation/marker helpers and mock the service's read-only
 * persistence calls to inspect student, subject, and workflow filters.
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
const { serializeMission } = require("../src/utils/missionSerializer");

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

test("all five Business formats accept an explicit P1 Task Focus", () => {
  for (const draftFormat of [
    "Q5",
    "Q8",
    "ESSAY_BUILDER",
    "THEORY",
    "Q10_ASSESSMENT",
  ]) {
    assert.doesNotThrow(() =>
      teacherService.assertNewBusinessTaskFocus({
        subjectName: "Business",
        taskCodes: ["P1"],
        draftFormat,
      }),
    );
  }
});

test("new Business work rejects missing focus without making it global", () => {
  assert.throws(
    () =>
      teacherService.assertNewBusinessTaskFocus({
        subjectName: "Business",
        taskCodes: [],
      }),
    (error) => error.statusCode === 400 && /Task Focus/.test(error.message),
  );

  assert.doesNotThrow(() =>
    teacherService.assertNewBusinessTaskFocus({
      subjectName: "English",
      taskCodes: [],
    }),
  );
});

test("workflow marker is new-only and preserves an existing assignment", () => {
  assert.equal(
    teacherService.resolveTaskFocusAssignedAt({ taskCodes: [] }),
    null,
  );
  assert.ok(
    teacherService.resolveTaskFocusAssignedAt({ taskCodes: ["P1"] })
      instanceof Date,
  );

  const existing = new Date("2026-09-05T12:00:00.000Z");
  assert.equal(
    teacherService.resolveTaskFocusAssignedAt({
      taskCodes: ["P2"],
      existingAssignedAt: existing,
    }),
    existing,
  );
});

test("legacy null Task Focus mission still serializes safely", () => {
  const payload = serializeMission({
    _id: "legacy-mission",
    title: "Old mission",
    draftFormat: "QUESTIONS",
    questions: [],
  });

  assert.deepEqual(payload.taskCodes, []);
  assert.equal(Object.hasOwn(payload, "taskFocusAssignedAt"), false);
});

test("pathway query is read-only and scoped to learner, subject, and marker", async () => {
  const originals = {
    missionFind: Mission.find,
    timetableFind: Timetable.find,
    userFindOne: User.findOne,
    certification:
      subjectCertificationService.getStudentCertificationSummaries,
  };
  let missionFilter;
  let certificationInput;

  User.findOne = (filter) => queryReturning(
    filter.role === "teacher"
      ? {
          _id: "teacher-1",
          role: "teacher",
          assignedStudents: ["ahmed-id"],
        }
      : {
          _id: "ahmed-id",
          name: "Ahmed Stockwin",
          role: "student",
        },
  );
  Timetable.find = () => queryReturning([
    {
      morningSubject: "business-id",
      morningTeacherId: "teacher-1",
      afternoonSubject: "english-id",
      afternoonTeacherId: "other-teacher",
    },
  ]);
  Mission.find = (filter) => {
    missionFilter = filter;
    return queryReturning([
      {
        _id: "p1-q5",
        title: "P1 Q5",
        studentId: "ahmed-id",
        subjectId: {
          _id: "business-id",
          name: "Business",
        },
        draftFormat: "QUESTIONS",
        status: "draft",
        taskCodes: ["P1"],
        questions: Array.from({ length: 5 }, (_, index) => ({
          prompt: `Question ${index + 1}`,
          options: ["A", "B", "C", "D"],
          correctIndex: 0,
        })),
      },
    ]);
  };
  subjectCertificationService.getStudentCertificationSummaries =
    async (input) => {
      certificationInput = input;
      return [];
    };

  try {
    const result = await teacherService.getStudentMissionPathway({
      teacherId: "teacher-1",
      studentId: "ahmed-id",
      subjectId: "business-id",
    });

    assert.equal(result.student.name, "Ahmed Stockwin");
    assert.equal(result.missions.length, 1);
    assert.equal(missionFilter.studentId, "ahmed-id");
    assert.deepEqual(missionFilter.subjectId, { $in: ["business-id"] });
    assert.deepEqual(missionFilter.taskFocusAssignedAt, {
      $exists: true,
      $ne: null,
    });
    assert.deepEqual(missionFilter["taskCodes.0"], { $exists: true });
    assert.deepEqual(certificationInput, {
      studentId: "ahmed-id",
      subjectId: "business-id",
      applyAwards: false,
    });
  } finally {
    Mission.find = originals.missionFind;
    Timetable.find = originals.timetableFind;
    User.findOne = originals.userFindOne;
    subjectCertificationService.getStudentCertificationSummaries =
      originals.certification;
  }
});

test("pathway rejects a subject outside the teacher timetable", async () => {
  const originals = {
    timetableFind: Timetable.find,
    userFindOne: User.findOne,
  };

  User.findOne = () => queryReturning({
    _id: "teacher-1",
    role: "teacher",
    assignedStudents: ["ahmed-id"],
  });
  Timetable.find = () => queryReturning([
    {
      morningSubject: "business-id",
      morningTeacherId: "teacher-1",
    },
  ]);

  try {
    await assert.rejects(
      teacherService.getStudentMissionPathway({
        teacherId: "teacher-1",
        studentId: "ahmed-id",
        subjectId: "english-id",
      }),
      (error) => error.statusCode === 403 && /assigned subjects/.test(error.message),
    );
  } finally {
    Timetable.find = originals.timetableFind;
    User.findOne = originals.userFindOne;
  }
});
