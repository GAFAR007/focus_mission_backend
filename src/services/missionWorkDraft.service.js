/**
 * WHAT:
 * missionWorkDraft.service reads and saves unfinished Theory and Essay Builder
 * work for the authenticated learner.
 * WHY:
 * Browser refreshes and interrupted connections must not erase written work,
 * but autosave must never award XP, score evidence, or complete a mission.
 * HOW:
 * Authorize the mission against the server-owned student id, normalize only
 * format-appropriate fields, merge partial Theory responses, and upsert one
 * isolated MissionWorkDraft record.
 */
const Mission = require("../models/Mission");
const MissionWorkDraft = require("../models/MissionWorkDraft");

const EDITABLE_MISSION_TYPES = new Set(["THEORY", "ESSAY_BUILDER"]);

function createError(statusCode, message, code = "MISSION_WORK_DRAFT_ERROR") {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function countWords(value) {
  return String(value || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

function normalizeTheoryResponses(value, questionCount) {
  if (value === undefined) {
    return null;
  }
  if (!Array.isArray(value)) {
    throw createError(400, "theoryResponses must be an array.", "INVALID_DRAFT");
  }

  const byIndex = new Map();
  for (const item of value) {
    const questionIndex = Number(item?.questionIndex);
    if (
      !Number.isInteger(questionIndex) ||
      questionIndex < 0 ||
      questionIndex >= questionCount
    ) {
      // WHY: Question indexes must be checked against the saved mission so a
      // client cannot attach arbitrary response slots to qualification work.
      throw createError(
        400,
        "A theory response contains an invalid questionIndex.",
        "INVALID_DRAFT",
      );
    }
    const answerText = String(item?.answerText || "");
    if (answerText.length > 20000) {
      throw createError(400, "A theory answer is too long.", "INVALID_DRAFT");
    }
    byIndex.set(questionIndex, {
      questionIndex,
      answerText,
      wordCount: countWords(answerText),
      updatedAt: new Date(),
    });
  }
  return [...byIndex.values()].sort(
    (left, right) => left.questionIndex - right.questionIndex,
  );
}

function essaySentenceMap(mission) {
  const sentences = Array.isArray(mission?.draftJson?.sentences)
    ? mission.draftJson.sentences
    : Array.isArray(mission?.draftJson?.builder?.sentences)
    ? mission.draftJson.builder.sentences
    : [];
  return new Map(
    sentences.map((sentence, index) => [
      String(sentence?.id || `s${index + 1}`).trim(),
      new Map(
        (Array.isArray(sentence?.parts) ? sentence.parts : [])
          .filter((part) => part?.type === "blank")
          .map((part) => [
            String(part?.blankId || "").trim(),
            part?.options && typeof part.options === "object"
              ? Object.keys(part.options).map((key) => String(key).toUpperCase())
              : [],
          ]),
      ),
    ]),
  );
}

function normalizeEssayBuilder(value, mission) {
  if (value === undefined) {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw createError(400, "essayBuilder must be an object.", "INVALID_DRAFT");
  }

  const allowedSentences = essaySentenceMap(mission);
  const selectedAnswers = [];
  const seen = new Set();
  for (const item of Array.isArray(value.selectedAnswers)
    ? value.selectedAnswers
    : []) {
    const sentenceId = String(item?.sentenceId || "").trim();
    const blankId = String(item?.blankId || "").trim();
    const selectedOption = String(item?.selectedOption || "")
      .trim()
      .toUpperCase();
    const optionKeys = allowedSentences.get(sentenceId)?.get(blankId) || [];
    if (!sentenceId || !blankId || !optionKeys.includes(selectedOption)) {
      // WHY: Guided answers are validated against the authored mission rather
      // than trusting client-created sentence, blank, or option identifiers.
      throw createError(
        400,
        "Essay Builder progress does not match this mission.",
        "INVALID_DRAFT",
      );
    }
    const key = `${sentenceId}:${blankId}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    selectedAnswers.push({ sentenceId, blankId, selectedOption });
  }

  const currentSentenceIndex = Number(value.currentSentenceIndex || 0);
  const sentenceCount = allowedSentences.size;
  if (
    !Number.isInteger(currentSentenceIndex) ||
    currentSentenceIndex < 0 ||
    currentSentenceIndex > Math.max(0, sentenceCount)
  ) {
    throw createError(
      400,
      "currentSentenceIndex is outside this mission.",
      "INVALID_DRAFT",
    );
  }

  const finalEssayText = String(value.finalEssayText || "");
  if (finalEssayText.length > 100000) {
    throw createError(400, "The final essay draft is too long.", "INVALID_DRAFT");
  }

  return {
    selectedAnswers,
    currentSentenceIndex,
    finalEssayText,
    finalEssayWordCount: countWords(finalEssayText),
    updatedAt: new Date(),
  };
}

function serializeMissionWorkDraft(draft, mission = null) {
  const source = draft?.toObject ? draft.toObject() : draft || {};
  return {
    id: String(source._id || source.id || ""),
    studentId: String(source.studentId || ""),
    missionId: String(source.missionId || mission?._id || ""),
    subjectId: String(source.subjectId || mission?.subjectId || ""),
    missionType: String(source.missionType || mission?.draftFormat || ""),
    theoryResponses: Array.isArray(source.theoryResponses)
      ? source.theoryResponses.map((item) => ({
          questionIndex: Number(item.questionIndex || 0),
          answerText: String(item.answerText || ""),
          wordCount: Number(item.wordCount || 0),
          updatedAt: item.updatedAt ? new Date(item.updatedAt).toISOString() : null,
        }))
      : [],
    essayBuilder: {
      selectedAnswers: Array.isArray(source?.essayBuilder?.selectedAnswers)
        ? source.essayBuilder.selectedAnswers.map((item) => ({
            sentenceId: String(item.sentenceId || ""),
            blankId: String(item.blankId || ""),
            selectedOption: String(item.selectedOption || ""),
          }))
        : [],
      currentSentenceIndex: Number(
        source?.essayBuilder?.currentSentenceIndex || 0,
      ),
      finalEssayText: String(source?.essayBuilder?.finalEssayText || ""),
      finalEssayWordCount: Number(
        source?.essayBuilder?.finalEssayWordCount || 0,
      ),
      updatedAt: source?.essayBuilder?.updatedAt
        ? new Date(source.essayBuilder.updatedAt).toISOString()
        : null,
    },
    status: String(source.status || "in_progress"),
    version: Number(source.version || 1),
    submittedAt: source.submittedAt
      ? new Date(source.submittedAt).toISOString()
      : null,
    updatedAt: source.updatedAt ? new Date(source.updatedAt).toISOString() : null,
  };
}

async function loadOwnedMission({ studentId, missionId }) {
  const mission = await Mission.findOne({
    _id: missionId,
    studentId,
    manualResultOnly: { $ne: true },
    $or: [{ status: "published" }, { status: { $exists: false } }],
  }).lean();
  if (!mission) {
    throw createError(
      404,
      "Mission not found for this student.",
      "MISSION_NOT_FOUND",
    );
  }

  const missionType = String(mission.draftFormat || "").trim().toUpperCase();
  if (!EDITABLE_MISSION_TYPES.has(missionType)) {
    throw createError(
      400,
      "Saved work is only available for Theory and Essay Builder missions.",
      "DRAFT_NOT_SUPPORTED",
    );
  }
  return { mission, missionType };
}

async function getMissionWorkDraft({ studentId, missionId }) {
  console.info("[mission-draft] read_start", { studentId, missionId });
  const { mission, missionType } = await loadOwnedMission({ studentId, missionId });
  const draft = await MissionWorkDraft.findOne({ studentId, missionId }).lean();
  console.info("[mission-draft] read_complete", {
    studentId,
    missionId,
    found: Boolean(draft),
  });
  return serializeMissionWorkDraft(
    draft || {
      studentId,
      missionId,
      subjectId: mission.subjectId,
      missionType,
      theoryResponses: [],
      essayBuilder: {},
      status: "in_progress",
      version: 1,
    },
    mission,
  );
}

async function saveMissionWorkDraft({ studentId, missionId, payload }) {
  console.info("[mission-draft] save_start", { studentId, missionId });
  const { mission, missionType } = await loadOwnedMission({ studentId, missionId });
  if (mission.latestResultPackageId) {
    // WHY: The immutable ResultPackage is the final submission boundary. Even
    // if a draft status update was interrupted, submitted work stays locked.
    throw createError(
      409,
      "Submitted mission work can no longer be edited.",
      "DRAFT_ALREADY_SUBMITTED",
    );
  }
  const theoryResponses = normalizeTheoryResponses(
    payload?.theoryResponses,
    Array.isArray(mission.questions) ? mission.questions.length : 0,
  );
  const essayBuilder = normalizeEssayBuilder(payload?.essayBuilder, mission);

  if (missionType === "THEORY" && theoryResponses === null) {
    throw createError(400, "theoryResponses are required.", "INVALID_DRAFT");
  }
  if (missionType === "ESSAY_BUILDER" && essayBuilder === null) {
    throw createError(400, "essayBuilder is required.", "INVALID_DRAFT");
  }

  let draft = await MissionWorkDraft.findOne({ studentId, missionId });
  if (draft?.status === "submitted") {
    throw createError(
      409,
      "Submitted mission work can no longer be edited.",
      "DRAFT_ALREADY_SUBMITTED",
    );
  }
  if (!draft) {
    draft = new MissionWorkDraft({
      studentId,
      missionId,
      subjectId: mission.subjectId,
      missionType,
    });
  }

  if (theoryResponses !== null) {
    const merged = new Map(
      (draft.theoryResponses || []).map((item) => [Number(item.questionIndex), item]),
    );
    for (const response of theoryResponses) {
      merged.set(response.questionIndex, response);
    }
    draft.theoryResponses = [...merged.values()].sort(
      (left, right) => Number(left.questionIndex) - Number(right.questionIndex),
    );
  }
  if (essayBuilder !== null) {
    draft.essayBuilder = essayBuilder;
  }
  draft.version = Number(draft.version || 0) + 1;
  await draft.save();

  console.info("[mission-draft] save_complete", {
    studentId,
    missionId,
    missionType,
    version: draft.version,
  });
  return serializeMissionWorkDraft(draft, mission);
}

async function markMissionWorkDraftSubmitted({ studentId, missionId, resultPackageId }) {
  // WHY: The draft is marked submitted only after ResultPackage creation has
  // succeeded, so a failed final submission never destroys editable work.
  await MissionWorkDraft.findOneAndUpdate(
    { studentId, missionId, status: "in_progress" },
    {
      $set: {
        status: "submitted",
        submittedAt: new Date(),
        resultPackageId,
      },
      $inc: { version: 1 },
    },
  );
}

module.exports = {
  countWords,
  getMissionWorkDraft,
  markMissionWorkDraftSubmitted,
  normalizeEssayBuilder,
  normalizeTheoryResponses,
  saveMissionWorkDraft,
  serializeMissionWorkDraft,
};
