/**
 * WHAT:
 * standalonePaper.service owns teacher-authored standalone Test and Exam draft
 * workflows that sit outside daily missions and assessment mode.
 * WHY:
 * The mission schema only supports one draft format at a time, so mixed-format
 * standalone papers need a separate service boundary, persistence model, and
 * import parser.
 * HOW:
 * Validate teacher ownership, parse uploaded source files into mixed paper
 * items, save/update/delete standalone drafts, and serialize a stable response
 * shape for the teacher frontend.
 */
const Subject = require("../models/Subject");
const StandalonePaper = require("../models/StandalonePaper");
const User = require("../models/User");
const {
  extractTextFromUploadedSource,
} = require("./sourceExtraction.service");
const {
  teacherCanTeachSubjectName,
} = require("../utils/teacherSubjectSpecialties");

function createError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizeForMatch(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function dedupeTextList(items) {
  const unique = [];

  for (const item of Array.isArray(items) ? items : []) {
    const value = String(item || "").trim();

    if (!value || unique.includes(value)) {
      continue;
    }

    unique.push(value);
  }

  return unique;
}

function countWords(value) {
  return String(value || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

function normalizeImportedTextBlock(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function normalizeStandalonePaperKind(value, { required = true } = {}) {
  const normalized = String(value || "")
    .trim()
    .toUpperCase();

  if (!normalized) {
    if (required) {
      throw createError(400, "paperKind is required.");
    }
    return "";
  }

  if (!["TEST", "EXAM"].includes(normalized)) {
    throw createError(400, "paperKind must be TEST or EXAM.");
  }

  return normalized;
}

function normalizeStandalonePaperSessionType(value, { required = true } = {}) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();

  if (!normalized) {
    if (required) {
      throw createError(400, "sessionType is required.");
    }
    return "";
  }

  if (!["morning", "afternoon"].includes(normalized)) {
    throw createError(400, "sessionType must be morning or afternoon.");
  }

  return normalized;
}

function normalizeStandaloneItemType(value, { required = true } = {}) {
  const normalized = String(value || "")
    .trim()
    .toUpperCase();

  if (!normalized) {
    if (required) {
      throw createError(400, "itemType is required.");
    }
    return "";
  }

  if (["OBJECTIVE", "MULTIPLE_CHOICE", "MULTIPLE CHOICE"].includes(normalized)) {
    return "OBJECTIVE";
  }

  if (
    [
      "FILL_GAP",
      "FILL GAP",
      "FILL-IN-THE-GAP",
      "FILL IN THE GAP",
      "GAP",
    ].includes(normalized)
  ) {
    return "FILL_GAP";
  }

  if (
    ["THEORY", "SHORT_ANSWER", "SHORT ANSWER", "WRITTEN"].includes(normalized)
  ) {
    return "THEORY";
  }

  throw createError(
    400,
    "itemType must be OBJECTIVE, FILL_GAP, or THEORY.",
  );
}

function normalizeStandaloneImportKind(value, { required = false } = {}) {
  const normalized = String(value || "")
    .trim()
    .toUpperCase();

  if (!normalized) {
    if (required) {
      throw createError(400, "importKind is required.");
    }
    return "";
  }

  if (["ESSAY", "FILL_GAP", "FILL GAP", "FILL-GAP"].includes(normalized)) {
    return "FILL_GAP";
  }

  if (["OBJECTIVE", "THEORY"].includes(normalized)) {
    return normalized;
  }

  throw createError(
    400,
    "importKind must be OBJECTIVE, THEORY, or ESSAY.",
  );
}

function standaloneImportKindLabel(value) {
  const normalized = normalizeStandaloneImportKind(value, { required: false });

  if (normalized === "FILL_GAP") {
    return "essay/fill-gap";
  }

  if (normalized === "THEORY") {
    return "theory";
  }

  if (normalized === "OBJECTIVE") {
    return "objective";
  }

  return "standalone paper";
}

function normalizeDateKey(value) {
  const normalized = String(value || "").trim();

  if (!normalized) {
    return "";
  }

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(normalized);

  if (!match) {
    throw createError(400, "targetDate must use YYYY-MM-DD format.");
  }

  const parsed = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
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

function normalizeDurationMinutes(value) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return 0;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 600) {
    throw createError(400, "durationMinutes must be between 0 and 600.");
  }

  return parsed;
}

function parseStandaloneAcceptedAnswers(value) {
  if (Array.isArray(value)) {
    return dedupeTextList(value.map((item) => String(item || "").trim()));
  }

  return dedupeTextList(
    String(value || "")
      .split(/[,;\n]/)
      .map((item) => item.trim()),
  );
}

function parseImportedOptionList(rawOptions) {
  const optionsByLetter = new Map();
  const optionLines = String(rawOptions || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of optionLines) {
    const lineMatch = /^([A-D])[\).:\-]\s*(.+)$/i.exec(line);

    if (!lineMatch) {
      continue;
    }

    optionsByLetter.set(
      lineMatch[1].trim().toUpperCase(),
      normalizeImportedTextBlock(lineMatch[2]),
    );
  }

  if (optionsByLetter.size < 4) {
    const compactOptionsText = String(rawOptions || "")
      .replace(/\n+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const inlinePattern = /([A-D])[\).:\-]\s*([\s\S]*?)(?=(?:\s+[A-D][\).:\-]\s)|$)/gi;
    let inlineMatch;

    while ((inlineMatch = inlinePattern.exec(compactOptionsText)) !== null) {
      const optionLetter = inlineMatch[1].trim().toUpperCase();

      if (optionsByLetter.has(optionLetter)) {
        continue;
      }

      optionsByLetter.set(
        optionLetter,
        normalizeImportedTextBlock(inlineMatch[2]),
      );
    }
  }

  return ["A", "B", "C", "D"].map((letter) => optionsByLetter.get(letter) || "");
}

function resolveImportedCorrectIndex(correctAnswer, options) {
  const normalizedAnswer = normalizeImportedTextBlock(correctAnswer);

  if (!normalizedAnswer) {
    return -1;
  }

  const leadingLetterMatch =
    /^(?:option\s+)?\(?([A-D])\)?(?:[\).:\-]|\s|$)/i.exec(normalizedAnswer);

  if (leadingLetterMatch) {
    return ["A", "B", "C", "D"].indexOf(leadingLetterMatch[1].toUpperCase());
  }

  const normalizedCorrect = normalizeForMatch(normalizedAnswer);

  return options.findIndex(
    (option) => normalizeForMatch(option) === normalizedCorrect,
  );
}

function extractImportedPaperTitle(sourceText) {
  const firstMarkerMatch =
    /(?:^|\n)\s*(?:UNIT TEXT|Question\s+\d+|Objective\s+\d+|Fill\s*Gap\s+\d+|Gap\s+\d+|Theory\s+\d+)/im.exec(
      String(sourceText || ""),
    );
  const titleRegion = firstMarkerMatch
    ? String(sourceText || "").slice(0, firstMarkerMatch.index)
    : String(sourceText || "");

  const titleLines = titleRegion
    .split(/\n+/)
    .map((line) => String(line || "").trim())
    .filter(Boolean)
    .filter(
      (line) =>
        !/^student copy$/i.test(line) &&
        !/^teacher copy$/i.test(line) &&
        !/^questions?$/i.test(line),
    );

  return titleLines.length > 0 ? titleLines[titleLines.length - 1] : "";
}

function extractImportedUnitText(sourceText) {
  const normalizedSourceText = String(sourceText || "");
  const unitTextMatch =
    /(?:^|\n)\s*UNIT TEXT\s*:?\s*([\s\S]*?)(?=\n\s*(?:Question|Objective|Fill\s*Gap|Gap|Theory)\s+\d+\s*:?\s*|\s*$)/i.exec(
      normalizedSourceText,
    );

  if (unitTextMatch) {
    return normalizeImportedTextBlock(unitTextMatch[1]);
  }

  const firstQuestionMatch =
    /(?:^|\n)\s*(?:Question|Objective|Fill\s*Gap|Gap|Theory)\s+\d+\s*:?\s*/im.exec(
      normalizedSourceText,
    );

  if (!firstQuestionMatch) {
    return "";
  }

  const preQuestionLines = normalizedSourceText
    .slice(0, firstQuestionMatch.index)
    .split(/\n+/)
    .map((line) => String(line || "").trim())
    .filter(Boolean);

  if (preQuestionLines.length <= 1) {
    return "";
  }

  return normalizeImportedTextBlock(preQuestionLines.slice(1).join("\n"));
}

function splitImportedPaperBlocks(sourceText) {
  const normalizedSourceText = String(sourceText || "");
  const blockPattern =
    /(?:^|\n)\s*(Question|Objective|Fill\s*Gap|Gap|Theory)\s+(\d+)\s*:?\s*/gim;
  const matches = [];
  let match;

  while ((match = blockPattern.exec(normalizedSourceText)) !== null) {
    matches.push({
      heading: String(match[1] || "").trim(),
      number: Number(match[2]),
      index: match.index,
      contentStart: blockPattern.lastIndex,
    });
  }

  return matches.map((item, index) => {
    const nextIndex =
      index + 1 < matches.length ? matches[index + 1].index : normalizedSourceText.length;

    return {
      heading: item.heading,
      number: item.number,
      body: normalizeImportedTextBlock(
        normalizedSourceText.slice(item.contentStart, nextIndex),
      ),
    };
  });
}

function extractImportedQuestionSections(questionBody) {
  const normalizedBody = String(questionBody || "");
  const labelPattern =
    /(?:^|\n)\s*(Type|Learn First|Prompt|Options|Correct Answer|Explanation|Expected Answer|Accepted Answers|Minimum Word Count)\s*:?\s*/gim;
  const matches = [];
  let match;

  while ((match = labelPattern.exec(normalizedBody)) !== null) {
    matches.push({
      label: String(match[1] || "").trim().toLowerCase(),
      start: match.index,
      contentStart: labelPattern.lastIndex,
    });
  }

  if (matches.length === 0) {
    return {};
  }

  const sections = {};

  for (let index = 0; index < matches.length; index += 1) {
    const current = matches[index];
    const nextStart = index + 1 < matches.length ? matches[index + 1].start : normalizedBody.length;
    sections[current.label] = normalizeImportedTextBlock(
      normalizedBody.slice(current.contentStart, nextStart),
    );
  }

  return sections;
}

function inferImportedItemType({ heading, sections, prompt }) {
  const explicitType = String(sections.type || "").trim();

  if (explicitType) {
    try {
      return normalizeStandaloneItemType(explicitType);
    } catch (_error) {
      // WHY: Imported files are often inconsistent with labels, so item type
      // detection should fall back to structure-based heuristics.
    }
  }

  const normalizedHeading = normalizeForMatch(heading);

  if (normalizedHeading.includes("fill gap") || normalizedHeading === "gap") {
    return "FILL_GAP";
  }

  if (normalizedHeading.includes("theory")) {
    return "THEORY";
  }

  if (normalizeImportedTextBlock(sections.options)) {
    return "OBJECTIVE";
  }

  const normalizedPrompt = String(prompt || "");

  if (/{blank}/i.test(normalizedPrompt) || /_{3,}/.test(normalizedPrompt)) {
    return "FILL_GAP";
  }

  if (/\bfill\s+in\s+the\s+gap\b/i.test(normalizedPrompt)) {
    return "FILL_GAP";
  }

  if (normalizeImportedTextBlock(sections["minimum word count"])) {
    return "THEORY";
  }

  if (normalizeImportedTextBlock(sections["accepted answers"])) {
    return "FILL_GAP";
  }

  if (normalizeImportedTextBlock(sections["expected answer"])) {
    return "THEORY";
  }

  return "OBJECTIVE";
}

function buildImportedUnitTextFallbackFromItems(items) {
  const uniqueLearningBlocks = [];

  for (const item of Array.isArray(items) ? items : []) {
    const learningText = normalizeImportedTextBlock(item?.learningText);

    if (!learningText || uniqueLearningBlocks.includes(learningText)) {
      continue;
    }

    uniqueLearningBlocks.push(learningText);
  }

  return uniqueLearningBlocks.join("\n\n").trim();
}

function parseImportedMinimumWordCount(value) {
  const match = String(value || "").match(/\d+/);

  if (!match) {
    return 0;
  }

  return Number(match[0]);
}

function normalizeStandalonePaperItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw createError(400, "Standalone papers must include at least one item.");
  }

  if (items.length > 60) {
    throw createError(400, "Standalone papers can include up to 60 items.");
  }

  return items.map((item, index) => {
    const itemLabel = `Item ${index + 1}`;
    const itemType = normalizeStandaloneItemType(item?.itemType);
    const learningText = String(item?.learningText || "").trim();
    const prompt = String(item?.prompt || "").trim();
    const explanation = String(item?.explanation || "").trim();

    if (!prompt) {
      throw createError(400, `${itemLabel} prompt is required.`);
    }

    if (itemType === "OBJECTIVE") {
      const options = Array.isArray(item?.options)
        ? item.options.map((value) => String(value || "").trim())
        : [];
      const correctIndex = Number(item?.correctIndex);

      if (options.length !== 4 || options.some((option) => !option)) {
        throw createError(
          400,
          `${itemLabel} objective items need exactly four options.`,
        );
      }

      if (!Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex > 3) {
        throw createError(
          400,
          `${itemLabel} objective items need a correct answer between A and D.`,
        );
      }

      return {
        itemType,
        learningText,
        prompt,
        options,
        correctIndex,
        expectedAnswer: "",
        acceptedAnswers: [],
        explanation,
        minWordCount: 0,
      };
    }

    if (itemType === "FILL_GAP") {
      const expectedAnswer = String(item?.expectedAnswer || "").trim();
      const acceptedAnswers = parseStandaloneAcceptedAnswers(
        item?.acceptedAnswers,
      );
      const resolvedAcceptedAnswers = acceptedAnswers.length > 0
        ? acceptedAnswers
        : expectedAnswer
        ? [expectedAnswer]
        : [];

      if (!expectedAnswer) {
        throw createError(400, `${itemLabel} fill-gap items need an answer key.`);
      }

      if (resolvedAcceptedAnswers.length === 0) {
        throw createError(
          400,
          `${itemLabel} fill-gap items need at least one accepted answer.`,
        );
      }

      return {
        itemType,
        learningText,
        prompt,
        options: [],
        correctIndex: -1,
        expectedAnswer,
        acceptedAnswers: resolvedAcceptedAnswers,
        explanation,
        minWordCount: 0,
      };
    }

    const expectedAnswer = String(item?.expectedAnswer || "").trim();
    const minWordCount = Number(item?.minWordCount || 0);

    if (!expectedAnswer) {
      throw createError(400, `${itemLabel} theory items need an expected answer.`);
    }

    if (
      !Number.isInteger(minWordCount) ||
      minWordCount < 0 ||
      minWordCount > 1000
    ) {
      throw createError(
        400,
        `${itemLabel} theory min word count must be between 0 and 1000.`,
      );
    }

    return {
      itemType,
      learningText,
      prompt,
      options: [],
      correctIndex: -1,
      expectedAnswer,
      acceptedAnswers: [],
      explanation,
      minWordCount,
    };
  });
}

function parseImportedStandalonePaperFromText(sourceText, { importKind = "" } = {}) {
  const title = extractImportedPaperTitle(sourceText);
  let unitText = extractImportedUnitText(sourceText);
  const blocks = splitImportedPaperBlocks(sourceText);
  const parsedItems = [];
  const errors = [];
  let usedLearningFallbackForUnitText = false;
  const normalizedImportKind = normalizeStandaloneImportKind(importKind, {
    required: false,
  });
  let matchingBlockCount = 0;

  if (blocks.length === 0) {
    errors.push("No structured Test or Exam items were found in the uploaded file.");
  }

  for (const block of blocks) {
    const itemLabel = `${block.heading} ${block.number || parsedItems.length + 1}`;
    const sections = extractImportedQuestionSections(block.body);
    const learningText = normalizeImportedTextBlock(sections["learn first"]);
    const prompt = normalizeImportedTextBlock(sections.prompt);
    const explanation = normalizeImportedTextBlock(sections.explanation);
    const itemType = inferImportedItemType({
      heading: block.heading,
      sections,
      prompt,
    });

    if (normalizedImportKind && itemType !== normalizedImportKind) {
      continue;
    }

    matchingBlockCount += 1;

    if (!prompt) {
      errors.push(`${itemLabel} is missing Prompt.`);
      continue;
    }

    if (itemType === "OBJECTIVE") {
      const options = parseImportedOptionList(sections.options);
      const correctIndex = resolveImportedCorrectIndex(
        sections["correct answer"],
        options,
      );

      if (options.length !== 4 || options.some((option) => !option)) {
        errors.push(`${itemLabel} needs exactly four imported answer options.`);
        continue;
      }

      if (!Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex > 3) {
        errors.push(`${itemLabel} is missing a usable Correct Answer.`);
        continue;
      }

      parsedItems.push({
        itemType,
        learningText,
        prompt,
        options,
        correctIndex,
        expectedAnswer: "",
        acceptedAnswers: [],
        explanation,
        minWordCount: 0,
      });
      continue;
    }

    if (itemType === "FILL_GAP") {
      const expectedAnswer = normalizeImportedTextBlock(
        sections["expected answer"] || sections["correct answer"],
      );
      const acceptedAnswers = parseStandaloneAcceptedAnswers(
        sections["accepted answers"] || expectedAnswer,
      );

      if (!expectedAnswer) {
        errors.push(`${itemLabel} is missing Expected Answer.`);
        continue;
      }

      parsedItems.push({
        itemType,
        learningText,
        prompt,
        options: [],
        correctIndex: -1,
        expectedAnswer,
        acceptedAnswers: acceptedAnswers.length > 0
          ? acceptedAnswers
          : [expectedAnswer],
        explanation,
        minWordCount: 0,
      });
      continue;
    }

    const expectedAnswer = normalizeImportedTextBlock(
      sections["expected answer"] || sections["correct answer"],
    );

    if (!expectedAnswer) {
      errors.push(`${itemLabel} is missing Expected Answer.`);
      continue;
    }

    parsedItems.push({
      itemType,
      learningText,
      prompt,
      options: [],
      correctIndex: -1,
      expectedAnswer,
      acceptedAnswers: [],
      explanation,
      minWordCount: parseImportedMinimumWordCount(sections["minimum word count"]),
    });
  }

  if (!unitText && parsedItems.length > 0) {
    // WHY: Imported classroom files often omit a dedicated UNIT TEXT block, so
    // the saved paper should still keep the readable teaching guidance that was
    // actually supplied in the item-level Learn First sections.
    unitText = buildImportedUnitTextFallbackFromItems(parsedItems);
    usedLearningFallbackForUnitText = unitText.length > 0;
  }

  if (!unitText) {
    errors.push("No UNIT TEXT section was found before the imported items.");
  }

  if (blocks.length > 0 && matchingBlockCount === 0 && normalizedImportKind) {
    errors.push(
      `No structured ${standaloneImportKindLabel(normalizedImportKind)} items were found in the uploaded file.`,
    );
  }

  let normalizedItems = [];

  if (errors.length === 0 && parsedItems.length > 0) {
    try {
      normalizedItems = normalizeStandalonePaperItems(parsedItems);
    } catch (error) {
      errors.push(
        String(
          error?.message || "The imported standalone paper could not be validated.",
        ),
      );
    }
  }

  return {
    title,
    unitText,
    items: normalizedItems,
    blockCount: matchingBlockCount,
    importKind: normalizedImportKind,
    usedLearningFallbackForUnitText,
    errors: dedupeTextList(errors),
  };
}

function buildImportedStandalonePaperReadiness(parsedPaper) {
  const detectedSignals = [];
  const warningNotes = [];
  const missingRequirements = dedupeTextList(parsedPaper.errors);
  const importedItemCount = parsedPaper.items.length;
  const hasMissingRequirements = missingRequirements.length > 0;
  const importLabel = standaloneImportKindLabel(parsedPaper.importKind);

  if (parsedPaper.unitText) {
    detectedSignals.push(
      `Unit text section detected (${countWords(parsedPaper.unitText)} words).`,
    );
  }

  if (parsedPaper.blockCount > 0) {
    detectedSignals.push(
      `${parsedPaper.blockCount} structured item block${
        parsedPaper.blockCount === 1 ? "" : "s"
      } detected.`,
    );
  }

  if (parsedPaper.usedLearningFallbackForUnitText) {
    warningNotes.push(
      "No separate UNIT TEXT section was found, so Unit text was rebuilt from the imported Learn First content.",
    );
  }

  if (importedItemCount > 0 && !hasMissingRequirements) {
    detectedSignals.push(
      `${importedItemCount} standalone paper item${
        importedItemCount === 1 ? "" : "s"
      } imported without AI.`,
    );
  }

  if (importedItemCount > 0 && hasMissingRequirements) {
    warningNotes.push(
      "Some item sections were readable, but no standalone paper draft was populated because the import file is incomplete.",
    );
  }

  const status = hasMissingRequirements ? "needs_attention" : "ready";
  const summary =
    status === "ready"
      ? `The uploaded file was parsed directly into a standalone ${importLabel} draft without AI.`
      : parsedPaper.blockCount === 0
      ? parsedPaper.importKind
        ? `Populate draft could not find a structured ${importLabel} set in this file, so no draft was imported.`
        : "Populate draft could not find a structured Test or Exam item set in this file, so no draft was imported."
      : importedItemCount > 0
      ? "Populate draft stopped because at least one imported item section was incomplete, so no standalone paper draft was populated."
      : "Populate draft could not import this file cleanly, so no standalone paper draft was populated.";

  return {
    status,
    summary,
    detectedSignals: dedupeTextList(detectedSignals),
    missingRequirements,
    warningNotes: dedupeTextList(warningNotes),
  };
}

async function assertTeacherOwnsStandalonePaperContext({
  teacherId,
  studentId,
  subjectId,
}) {
  const [teacher, student, subject] = await Promise.all([
    User.findOne({ _id: teacherId, role: "teacher" })
      .select("assignedStudents subjectSpecialty subjectSpecialties")
      .lean(),
    User.findOne({
      _id: studentId,
      role: "student",
      isArchived: { $ne: true },
    })
      .select("name")
      .lean(),
    Subject.findById(subjectId)
      .select("name icon color")
      .lean(),
  ]);

  if (!teacher) {
    throw createError(404, "Teacher not found.");
  }

  const assignedStudentIds = Array.isArray(teacher.assignedStudents)
    ? teacher.assignedStudents.map((value) => String(value || "").trim())
    : [];

  if (!assignedStudentIds.includes(String(studentId || "").trim())) {
    throw createError(
      403,
      "Teachers can only create standalone papers for assigned students.",
    );
  }

  if (!student) {
    throw createError(404, "Student not found.");
  }

  if (!subject) {
    throw createError(404, "Subject not found.");
  }

  if (!teacherCanTeachSubjectName({ teacher, subjectName: subject.name })) {
    throw createError(
      403,
      "Teachers can only create standalone papers for their own subject.",
    );
  }

  return { student, subject };
}

async function assertTeacherOwnsAssignedStudent({
  teacherId,
  studentId,
}) {
  const [teacher, student] = await Promise.all([
    User.findOne({ _id: teacherId, role: "teacher" })
      .select("assignedStudents")
      .lean(),
    User.findOne({
      _id: studentId,
      role: "student",
      isArchived: { $ne: true },
    })
      .select("name")
      .lean(),
  ]);

  if (!teacher) {
    throw createError(404, "Teacher not found.");
  }

  const assignedStudentIds = Array.isArray(teacher.assignedStudents)
    ? teacher.assignedStudents.map((value) => String(value || "").trim())
    : [];

  if (!assignedStudentIds.includes(String(studentId || "").trim())) {
    throw createError(
      403,
      "Teachers can only view standalone papers for assigned students.",
    );
  }

  if (!student) {
    throw createError(404, "Student not found.");
  }

  return student;
}

async function loadStandalonePaperForTeacher({
  teacherId,
  paperId,
}) {
  const paper = await StandalonePaper.findById(paperId)
    .populate("subjectId", "name icon color")
    .lean();

  if (!paper) {
    throw createError(404, "Standalone paper not found.");
  }

  if (String(paper.teacherId || "") !== String(teacherId || "")) {
    throw createError(403, "You do not have access to this standalone paper.");
  }

  return paper;
}

function serializeStandalonePaper(paper) {
  const subject = paper?.subjectId &&
    typeof paper.subjectId === "object" &&
    paper.subjectId !== null
    ? {
        id: String(paper.subjectId._id || paper.subjectId.id || ""),
        name: String(paper.subjectId.name || "").trim(),
        icon: String(paper.subjectId.icon || "").trim(),
        color: String(paper.subjectId.color || "").trim(),
      }
    : null;
  const items = Array.isArray(paper?.items)
    ? paper.items.map((item) => ({
        itemType: String(item?.itemType || "").trim(),
        learningText: String(item?.learningText || "").trim(),
        prompt: String(item?.prompt || "").trim(),
        options: Array.isArray(item?.options)
          ? item.options.map((value) => String(value || "").trim())
          : [],
        correctIndex: Number(item?.correctIndex ?? -1),
        expectedAnswer: String(item?.expectedAnswer || "").trim(),
        acceptedAnswers: Array.isArray(item?.acceptedAnswers)
          ? item.acceptedAnswers.map((value) => String(value || "").trim())
          : [],
        explanation: String(item?.explanation || "").trim(),
        minWordCount: Number(item?.minWordCount || 0),
      }))
    : [];

  return {
    id: String(paper?._id || paper?.id || "").trim(),
    teacherId: String(paper?.teacherId || "").trim(),
    studentId: String(paper?.studentId || "").trim(),
    paperKind: normalizeStandalonePaperKind(paper?.paperKind, { required: false }),
    sessionType: normalizeStandalonePaperSessionType(paper?.sessionType, {
      required: false,
    }),
    title: String(paper?.title || "").trim(),
    teacherNote: String(paper?.teacherNote || "").trim(),
    sourceUnitText: String(paper?.sourceUnitText || "").trim(),
    sourceRawText: String(paper?.sourceRawText || "").trim(),
    sourceFileName: String(paper?.sourceFileName || "").trim(),
    sourceFileType: String(paper?.sourceFileType || "").trim(),
    status: String(paper?.status || "draft").trim(),
    targetDate: String(paper?.targetDate || "").trim(),
    durationMinutes: Number(paper?.durationMinutes || 0),
    createdAt: paper?.createdAt || null,
    updatedAt: paper?.updatedAt || null,
    publishedAt: paper?.publishedAt || null,
    itemCount: items.length,
    items,
    subject,
  };
}

async function listStandalonePapers({
  teacherId,
  studentId,
  paperKind,
}) {
  await assertTeacherOwnsAssignedStudent({
    teacherId,
    studentId,
  });

  const filter = {
    teacherId,
    studentId,
  };

  if (String(paperKind || "").trim()) {
    filter.paperKind = normalizeStandalonePaperKind(paperKind);
  }

  const papers = await StandalonePaper.find(filter)
    .populate("subjectId", "name icon color")
    .sort({ updatedAt: -1, createdAt: -1 })
    .lean();

  return papers.map((paper) => serializeStandalonePaper(paper));
}

async function createStandalonePaper({
  teacherId,
  payload,
}) {
  const studentId = String(payload.studentId || "").trim();
  const subjectId = String(payload.subjectId || "").trim();
  const paperKind = normalizeStandalonePaperKind(payload.paperKind);
  const sessionType = normalizeStandalonePaperSessionType(payload.sessionType);
  const title = String(payload.title || "").trim();
  const teacherNote = String(payload.teacherNote || "").trim();
  const sourceUnitText = String(payload.sourceUnitText || "").trim();
  const sourceRawText = String(payload.sourceRawText || "").trim();
  const sourceFileName = String(payload.sourceFileName || "").trim();
  const sourceFileType = String(payload.sourceFileType || "").trim();
  const targetDate = normalizeDateKey(payload.targetDate);
  const durationMinutes = normalizeDurationMinutes(payload.durationMinutes);
  const items = normalizeStandalonePaperItems(payload.items);

  if (!title) {
    throw createError(400, "Standalone paper title is required.");
  }

  const { subject } = await assertTeacherOwnsStandalonePaperContext({
    teacherId,
    studentId,
    subjectId,
  });

  const created = await StandalonePaper.create({
    teacherId,
    studentId,
    subjectId,
    paperKind,
    sessionType,
    title,
    teacherNote,
    sourceUnitText,
    sourceRawText,
    sourceFileName,
    sourceFileType,
    targetDate,
    durationMinutes,
    status: "draft",
    items,
  });

  const saved = await StandalonePaper.findById(created._id)
    .populate("subjectId", "name icon color")
    .lean();

  console.info("[standalone-paper] created", {
    paperId: String(created._id || ""),
    teacherId: String(teacherId || ""),
    studentId,
    subjectId,
    paperKind,
    itemCount: items.length,
  });

  return serializeStandalonePaper(saved || { ...created.toObject(), subjectId: subject });
}

async function updateStandalonePaper({
  teacherId,
  paperId,
  payload,
}) {
  const existing = await loadStandalonePaperForTeacher({
    teacherId,
    paperId,
  });

  const studentId = String(existing.studentId || "").trim();
  const subjectId = String(existing.subjectId?._id || existing.subjectId || "").trim();

  await assertTeacherOwnsStandalonePaperContext({
    teacherId,
    studentId,
    subjectId,
  });

  const nextPaperKind = String(payload.paperKind || existing.paperKind || "").trim()
    ? normalizeStandalonePaperKind(payload.paperKind || existing.paperKind)
    : normalizeStandalonePaperKind(existing.paperKind);
  const nextSessionType = String(
    payload.sessionType !== undefined ? payload.sessionType : existing.sessionType,
  ).trim()
    ? normalizeStandalonePaperSessionType(
        payload.sessionType !== undefined ? payload.sessionType : existing.sessionType,
      )
    : normalizeStandalonePaperSessionType(existing.sessionType);

  if (nextPaperKind !== normalizeStandalonePaperKind(existing.paperKind)) {
    throw createError(400, "paperKind cannot be changed after the draft is created.");
  }

  if (String(existing.status || "").trim() === "published") {
    throw createError(
      409,
      "Published standalone papers must be unpublished before they can be edited.",
    );
  }

  const nextTitle = String(
    payload.title !== undefined ? payload.title : existing.title,
  ).trim();

  if (!nextTitle) {
    throw createError(400, "Standalone paper title is required.");
  }

  const items = normalizeStandalonePaperItems(
    payload.items !== undefined ? payload.items : existing.items,
  );

  const update = {
    sessionType: nextSessionType,
    title: nextTitle,
    teacherNote: String(
      payload.teacherNote !== undefined ? payload.teacherNote : existing.teacherNote,
    ).trim(),
    sourceUnitText: String(
      payload.sourceUnitText !== undefined
        ? payload.sourceUnitText
        : existing.sourceUnitText,
    ).trim(),
    sourceRawText: String(
      payload.sourceRawText !== undefined
        ? payload.sourceRawText
        : existing.sourceRawText,
    ).trim(),
    sourceFileName: String(
      payload.sourceFileName !== undefined
        ? payload.sourceFileName
        : existing.sourceFileName,
    ).trim(),
    sourceFileType: String(
      payload.sourceFileType !== undefined
        ? payload.sourceFileType
        : existing.sourceFileType,
    ).trim(),
    targetDate: normalizeDateKey(
      payload.targetDate !== undefined ? payload.targetDate : existing.targetDate,
    ),
    durationMinutes: normalizeDurationMinutes(
      payload.durationMinutes !== undefined
        ? payload.durationMinutes
        : existing.durationMinutes,
    ),
    items,
  };

  await StandalonePaper.findByIdAndUpdate(paperId, update);

  const saved = await StandalonePaper.findById(paperId)
    .populate("subjectId", "name icon color")
    .lean();

  console.info("[standalone-paper] updated", {
    paperId: String(paperId || ""),
    teacherId: String(teacherId || ""),
    itemCount: items.length,
  });

  return serializeStandalonePaper(saved);
}

async function deleteStandalonePaper({
  teacherId,
  paperId,
}) {
  const existing = await loadStandalonePaperForTeacher({
    teacherId,
    paperId,
  });

  if (String(existing.status || "").trim() !== "draft") {
    throw createError(400, "Only draft standalone papers can be deleted.");
  }

  await StandalonePaper.findByIdAndDelete(paperId);

  console.info("[standalone-paper] deleted", {
    paperId: String(paperId || ""),
    teacherId: String(teacherId || ""),
  });

  return { success: true, paperId: String(paperId || "") };
}

async function uploadStandalonePaperSourceDraft({
  teacherId,
  payload,
  file,
}) {
  const studentId = String(payload.studentId || "").trim();
  const subjectId = String(payload.subjectId || "").trim();
  const paperKind = normalizeStandalonePaperKind(payload.paperKind);
  const sessionType = normalizeStandalonePaperSessionType(payload.sessionType);
  const title = String(payload.title || "").trim();
  const targetDate = normalizeDateKey(payload.targetDate);
  const { subject } = await assertTeacherOwnsStandalonePaperContext({
    teacherId,
    studentId,
    subjectId,
  });
  const extractedSource = await extractTextFromUploadedSource(file, {
    minCharacters: 20,
  });
  const parsedPaper = parseImportedStandalonePaperFromText(
    extractedSource.extractedText,
    {
      importKind: payload.importKind,
    },
  );
  const draftReadiness = buildImportedStandalonePaperReadiness(parsedPaper);

  const prefilledPaper =
    draftReadiness.status === "ready"
      ? serializeStandalonePaper({
          id: "",
          teacherId,
          studentId,
          subjectId: subject,
          paperKind,
          sessionType,
          title:
            title ||
            parsedPaper.title ||
            `${subject.name} ${paperKind === "EXAM" ? "Exam" : "Test"}`,
          teacherNote: "",
          sourceUnitText: parsedPaper.unitText,
          sourceRawText: extractedSource.extractedText,
          sourceFileName: extractedSource.fileName,
          sourceFileType: extractedSource.mimeType,
          status: "draft",
          targetDate,
          durationMinutes: 0,
          createdAt: null,
          updatedAt: null,
          publishedAt: null,
          items: parsedPaper.items,
        })
      : null;

  return {
    fileName: extractedSource.fileName,
    mimeType: extractedSource.mimeType,
    sourceKind: extractedSource.sourceKind,
    extractedText: extractedSource.extractedText,
    extractedCharacterCount: extractedSource.extractedCharacterCount,
    draftReadiness,
    prefilledPaper,
  };
}

module.exports = {
  listStandalonePapers,
  createStandalonePaper,
  updateStandalonePaper,
  deleteStandalonePaper,
  uploadStandalonePaperSourceDraft,
  serializeStandalonePaper,
};
