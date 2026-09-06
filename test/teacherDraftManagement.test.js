/**
 * WHAT:
 * Covers teacher-owned active draft listing, archival, and deletion guards.
 * WHY:
 * Daily and Assessment bulk controls share the same Mission records, so their
 * server boundary must never cross student ownership or remove result evidence.
 * HOW:
 * Stub focused Mongoose calls and assert the exact filters and writes used by
 * teacher.service without changing assessment task-code or A/B metadata.
 */

const assert = require("node:assert/strict");
const test = require("node:test");

const Mission = require("../src/models/Mission");
const teacherService = require("../src/services/teacher.service");

function activeDraft(overrides = {}) {
  return {
    _id: "mission-1",
    createdBy: "teacher-1",
    studentId: "student-1",
    status: "draft",
    publishedAt: null,
    latestResultPackageId: null,
    latestScoreTotal: 0,
    latestXpEarned: 0,
    taskCodes: ["P1"],
    assessmentSequenceByTaskCode: { P1: "A" },
    ...overrides,
  };
}

test("active draft listing is student scoped, excludes archives, and is not capped", async () => {
  const originalFind = Mission.find;
  let capturedFilter;
  let limitCalled = false;
  Mission.find = (filter) => {
    capturedFilter = filter;
    return {
      sort() {
        return this;
      },
      limit() {
        limitCalled = true;
        return this;
      },
      populate() {
        return this;
      },
      async lean() {
        return [];
      },
    };
  };

  try {
    await teacherService.listDraftMissions("teacher-1", "student-1");
    assert.equal(capturedFilter.createdBy, "teacher-1");
    assert.equal(capturedFilter.studentId, "student-1");
    assert.equal(capturedFilter.status, "draft");
    assert.deepEqual(capturedFilter.isArchived, { $ne: true });
    assert.equal(limitCalled, false);
  } finally {
    Mission.find = originalFind;
  }
});

test("assessment draft archive preserves task focus and A/B metadata", async () => {
  const originalFindOne = Mission.findOne;
  const originalUpdateOne = Mission.updateOne;
  const mission = activeDraft({
    taskCodes: ["P1", "P2"],
    assessmentSequenceByTaskCode: { P1: "A", P2: "B" },
  });
  let capturedFindFilter;
  let capturedUpdate;

  Mission.findOne = (filter) => {
    capturedFindFilter = filter;
    return { lean: async () => mission };
  };
  Mission.updateOne = async (filter, update) => {
    capturedUpdate = { filter, update };
    return { modifiedCount: 1 };
  };

  try {
    const archived = await teacherService.archiveMission(
      "teacher-1",
      "student-1",
      "mission-1",
    );
    assert.equal(archived.missionId, "mission-1");
    assert.equal(capturedFindFilter.createdBy, "teacher-1");
    assert.equal(capturedFindFilter.studentId, "student-1");
    assert.equal(capturedUpdate.update.$set.isArchived, true);
    assert.equal(capturedUpdate.update.$set.archivedBy, "teacher-1");
    assert.ok(capturedUpdate.update.$set.archivedAt instanceof Date);
    assert.deepEqual(mission.taskCodes, ["P1", "P2"]);
    assert.deepEqual(mission.assessmentSequenceByTaskCode, {
      P1: "A",
      P2: "B",
    });
    assert.equal(capturedUpdate.update.$set.taskCodes, undefined);
    assert.equal(
      capturedUpdate.update.$set.assessmentSequenceByTaskCode,
      undefined,
    );
  } finally {
    Mission.findOne = originalFindOne;
    Mission.updateOne = originalUpdateOne;
  }
});

test("draft deletion is scoped to the selected teacher and student", async () => {
  const originalFindOne = Mission.findOne;
  const originalDeleteOne = Mission.deleteOne;
  let capturedFindFilter;
  let capturedDeleteFilter;

  Mission.findOne = (filter) => {
    capturedFindFilter = filter;
    return { lean: async () => activeDraft() };
  };
  Mission.deleteOne = async (filter) => {
    capturedDeleteFilter = filter;
    return { deletedCount: 1 };
  };

  try {
    await teacherService.deleteMission(
      "teacher-1",
      "student-1",
      "mission-1",
    );
    assert.equal(capturedFindFilter.createdBy, "teacher-1");
    assert.equal(capturedFindFilter.studentId, "student-1");
    assert.equal(capturedDeleteFilter.createdBy, "teacher-1");
    assert.equal(capturedDeleteFilter.studentId, "student-1");
    assert.equal(capturedDeleteFilter.status, "draft");
  } finally {
    Mission.findOne = originalFindOne;
    Mission.deleteOne = originalDeleteOne;
  }
});

test("a teacher cannot delete another teacher's assessment draft", async () => {
  const originalFindOne = Mission.findOne;
  const originalDeleteOne = Mission.deleteOne;
  let deleteCalled = false;

  Mission.findOne = () => ({ lean: async () => null });
  Mission.deleteOne = async () => {
    deleteCalled = true;
    return { deletedCount: 1 };
  };

  try {
    await assert.rejects(
      teacherService.deleteMission(
        "teacher-2",
        "student-1",
        "mission-1",
      ),
      (error) => error.statusCode === 404,
    );
    assert.equal(deleteCalled, false);
  } finally {
    Mission.findOne = originalFindOne;
    Mission.deleteOne = originalDeleteOne;
  }
});

test("published or completed assessments cannot use draft deletion", async () => {
  const originalFindOne = Mission.findOne;
  const originalDeleteOne = Mission.deleteOne;
  let currentMission = activeDraft({ status: "published" });
  let deleteCalled = false;

  Mission.findOne = () => ({ lean: async () => currentMission });
  Mission.deleteOne = async () => {
    deleteCalled = true;
    return { deletedCount: 1 };
  };

  try {
    await assert.rejects(
      teacherService.deleteMission(
        "teacher-1",
        "student-1",
        "mission-1",
      ),
      /Only uncompleted draft missions can be deleted/,
    );

    currentMission = activeDraft({
      latestResultPackageId: "result-package-1",
      latestScoreTotal: 10,
    });
    await assert.rejects(
      teacherService.deleteMission(
        "teacher-1",
        "student-1",
        "mission-1",
      ),
      /Only uncompleted draft missions can be deleted/,
    );
    assert.equal(deleteCalled, false);
  } finally {
    Mission.findOne = originalFindOne;
    Mission.deleteOne = originalDeleteOne;
  }
});

test("archived assessment records continue to reserve their A/B sequence", () => {
  const counts = teacherService.countAssessmentDraftsByTaskCode([
    activeDraft({ isArchived: true }),
    activeDraft({ _id: "mission-2", assessmentSequenceByTaskCode: { P1: "B" } }),
  ]);

  // WHY: Archive is an audit-preserving hide action, not permission to
  // silently regenerate a new Assessment A or B identity.
  assert.deepEqual(counts, { P1: 2 });
});
