/**
 * WHAT:
 * groq.service centralizes all Groq-backed draft generation for missions and
 * criterion learning content.
 * WHY:
 * Stage 7 requires server-side AI that returns drafts only, so the teacher can
 * review and approve content before anything affects qualification progress.
 * HOW:
 * Send constrained prompts to Groq, parse JSON-only responses, validate the
 * returned structure, and reject any draft that is not safe to review.
 */
function createError(
  statusCode,
  message,
) {
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

function countWords(value) {
  return String(value || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

function clamp(value, min, max) {
  return Math.min(
    Math.max(value, min),
    max,
  );
}

function trimSourceTextForAi(
  value,
  maxCharacters = 12000,
) {
  const trimmed = String(
    value || "",
  ).trim();

  if (trimmed.length <= maxCharacters) {
    return trimmed;
  }

  return `${trimmed.slice(0, maxCharacters)}\n\n[Source text trimmed for AI draft length.]`;
}

function isAnswerExplicitlyTaught(
  learningText,
  answerText,
) {
  const normalizedLearningText =
    normalizeForMatch(learningText);
  const normalizedAnswerText =
    normalizeForMatch(answerText);

  if (
    !normalizedLearningText ||
    !normalizedAnswerText
  ) {
    return false;
  }

  return normalizedLearningText.includes(
    normalizedAnswerText,
  );
}

function ensureLearningTextTeachesAnswer(
  learningText,
  answerText,
) {
  if (
    isAnswerExplicitlyTaught(
      learningText,
      answerText,
    )
  ) {
    return learningText;
  }

  const trimmedLearningText = String(
    learningText || "",
  ).trim();
  const trimmedAnswerText = String(
    answerText || "",
  ).trim();
  const suffix =
    /[.!?]$/.test(trimmedLearningText) ?
      ""
    : ".";

  return `${trimmedLearningText}${suffix} Key fact to remember: ${trimmedAnswerText}.`;
}

function ensurePromptReferencesLearningContext(
  prompt,
) {
  const trimmedPrompt = String(
    prompt || "",
  ).trim();

  if (!trimmedPrompt) {
    return "";
  }

  if (
    /based on what you just learned|from what you just learned|using the learning note|based on the learning/i.test(
      trimmedPrompt,
    )
  ) {
    return trimmedPrompt;
  }

  const firstCharacter =
    trimmedPrompt[0] || "";
  const rest = trimmedPrompt.slice(1);

  return `Based on what you just learned, ${firstCharacter.toLowerCase()}${rest}`;
}

function isPlaceholderOption(value) {
  return ["a", "b", "c", "d"].includes(
    normalizeForMatch(value),
  );
}

function extractFirstJsonObject(value) {
  const text = String(value || "");
  const start = text.indexOf("{");

  if (start === -1) {
    return text;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (
    let index = start;
    index < text.length;
    index += 1
  ) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === "\\") {
        escaped = true;
        continue;
      }

      if (char === '"') {
        inString = false;
      }

      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;

      if (depth === 0) {
        return text.slice(
          start,
          index + 1,
        );
      }
    }
  }

  return text;
}

function parseGroqJson(
  content,
  emptyMessage,
  parseMessage,
) {
  const trimmed = String(
    content || "",
  ).trim();

  if (!trimmed) {
    throw createError(
      502,
      emptyMessage,
    );
  }

  const fenceMatch = trimmed.match(
    /```(?:json)?\s*([\s\S]*?)```/i,
  );
  const candidate =
    fenceMatch ?
      fenceMatch[1].trim()
    : trimmed;
  const objectCandidate =
    extractFirstJsonObject(candidate);

  try {
    return JSON.parse(objectCandidate);
  } catch (primaryError) {
    try {
      return JSON.parse(candidate);
    } catch (_secondaryError) {
      throw createError(
        502,
        `${parseMessage} ${primaryError.message}`,
      );
    }
  }
}

function getGroqApiKey() {
  const apiKey = (
    process.env.GROQ_API_KEY ||
    process.env.XAI_API_KEY ||
    ""
  ).trim();

  if (!apiKey) {
    throw createError(
      503,
      "Set GROQ_API_KEY in the backend .env before generating AI drafts.",
    );
  }

  return apiKey;
}

function getGroqModel() {
  return (
    process.env.GROQ_MODEL ||
    process.env.AI_MODEL_DEFAULT ||
    "llama-3.1-8b-instant"
  ).trim();
}

async function requestGroqDraft({
  systemPrompt,
  userPrompt,
  emptyMessage,
  parseMessage,
}) {
  const apiKey = getGroqApiKey();
  const model = getGroqModel();
  let lastError;

  for (
    let attempt = 0;
    attempt < 3;
    attempt += 1
  ) {
    try {
      // WHY: Stage 7 keeps AI server-side only so the raw provider key never
      // reaches Flutter and teachers remain the approval boundary.
      const response = await fetch(
        "https://api.groq.com/openai/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type":
              "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            response_format: {
              type: "json_object",
            },
            messages: [
              {
                role: "system",
                content: systemPrompt,
              },
              {
                role: "user",
                content: userPrompt,
              },
            ],
          }),
        },
      );

      const json =
        await response.json();

      if (!response.ok) {
        throw createError(
          response.status,
          json?.error?.message ||
            "Groq draft generation failed.",
        );
      }

      return {
        model,
        parsed: parseGroqJson(
          json?.choices?.[0]?.message
            ?.content,
          emptyMessage,
          parseMessage,
        ),
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw (
    lastError ||
    createError(
      502,
      "Groq draft generation failed.",
    )
  );
}

function cleanMissionQuestion(
  question,
  index,
) {
  const learningText = String(
    question.learningText ||
      question.lessonText ||
      question.teachFirst ||
      question.explanation ||
      "",
  ).trim();
  const prompt = String(
    question.prompt || "",
  ).trim();
  const options =
    Array.isArray(question.options) ?
      question.options
        .map((option) =>
          String(option || "").trim(),
        )
        .filter(Boolean)
    : [];

  if (options.length !== 4) {
    throw createError(
      502,
      `Groq returned an invalid option set for question ${index + 1}.`,
    );
  }

  if (
    options.some((option) =>
      isPlaceholderOption(option),
    )
  ) {
    throw createError(
      502,
      `Groq returned placeholder answer letters for question ${index + 1}.`,
    );
  }

  if (
    new Set(
      options.map(normalizeForMatch),
    ).size !== 4
  ) {
    throw createError(
      502,
      `Groq returned repeated answer options for question ${index + 1}.`,
    );
  }

  const correctIndex = Number(
    question.correctIndex,
  );

  if (
    !Number.isInteger(correctIndex) ||
    correctIndex < 0 ||
    correctIndex > 3
  ) {
    throw createError(
      502,
      `Groq returned an invalid correctIndex for question ${index + 1}.`,
    );
  }

  const correctAnswer =
    options[correctIndex];

  if (!learningText) {
    throw createError(
      502,
      `Groq did not include Learn First text for question ${index + 1}.`,
    );
  }

  if (!prompt) {
    throw createError(
      502,
      `Groq did not include a usable question prompt for question ${index + 1}.`,
    );
  }

  const alignedLearningText =
    ensureLearningTextTeachesAnswer(
      learningText,
      correctAnswer,
    );
  const alignedPrompt =
    ensurePromptReferencesLearningContext(
      prompt,
    );

  return {
    learningText: alignedLearningText,
    prompt: alignedPrompt,
    options,
    correctIndex,
    explanation: String(
      question.explanation || "",
    ).trim(),
  };
}

function cleanLearningSection(
  section,
  index,
) {
  const body = String(
    section?.body || "",
  ).trim();

  if (!body) {
    throw createError(
      502,
      `Groq returned an empty learning section at position ${index + 1}.`,
    );
  }

  return {
    heading: String(
      section?.heading ||
        `Section ${index + 1}`,
    ).trim(),
    body,
    baseOrder: index,
  };
}

function ensureLearningSectionsTeachAnswer(
  sections,
  answerText,
  preferredSectionIndex,
) {
  const taughtText = sections
    .map((section) => section.body)
    .join(" ");

  if (
    isAnswerExplicitlyTaught(
      taughtText,
      answerText,
    )
  ) {
    return sections;
  }

  const safeIndex = Math.max(
    0,
    Math.min(
      preferredSectionIndex,
      sections.length - 1,
    ),
  );
  const reinforcement = `Key fact: ${answerText}.`;

  return sections.map(
    (section, sectionIndex) => {
      if (sectionIndex !== safeIndex) {
        return section;
      }

      // WHY: The student must only be tested on information already taught, so
      // the draft generator reinforces the exact correct answer phrase before the
      // teacher reviews and approves the content.
      return {
        ...section,
        body: `${section.body} ${reinforcement}`.trim(),
      };
    },
  );
}

function cleanLearningCheckBlock(
  question,
  index,
  sections,
) {
  const prompt = String(
    question?.prompt || "",
  ).trim();
  const options =
    Array.isArray(question?.options) ?
      question.options
        .map((option) =>
          String(option || "").trim(),
        )
        .filter(Boolean)
    : [];
  const correctIndex = Number(
    question?.correctIndex,
  );

  if (!prompt) {
    throw createError(
      502,
      `Groq returned an empty learningCheck prompt at position ${index + 1}.`,
    );
  }

  if (options.length !== 4) {
    throw createError(
      502,
      `Groq returned an invalid learningCheck option set at position ${index + 1}.`,
    );
  }

  if (
    options.some((option) =>
      isPlaceholderOption(option),
    )
  ) {
    throw createError(
      502,
      `Groq returned placeholder learningCheck answers at position ${index + 1}.`,
    );
  }

  if (
    new Set(
      options.map(normalizeForMatch),
    ).size !== 4
  ) {
    throw createError(
      502,
      `Groq repeated learningCheck answer options at position ${index + 1}.`,
    );
  }

  if (
    !Number.isInteger(correctIndex) ||
    correctIndex < 0 ||
    correctIndex > 3
  ) {
    throw createError(
      502,
      `Groq returned an invalid learningCheck correctIndex at position ${index + 1}.`,
    );
  }

  const alignedSections =
    ensureLearningSectionsTeachAnswer(
      sections,
      options[correctIndex],
      index,
    );

  return {
    sections: alignedSections,
    block: {
      type: "multipleChoice",
      phase: "learningCheck",
      prompt,
      options,
      correctIndex,
      generatedSentence: "",
      baseOrder: index,
    },
  };
}

function essayBuilderTypeForIndex(
  index,
  total,
) {
  if (index === 0) {
    return "sentenceBuilder";
  }

  if (index === total - 1) {
    return "summaryBuilder";
  }

  const cycle = [
    "evidenceBuilder",
    "explanationBuilder",
    "analysisBuilder",
    "reflectionBuilder",
  ];

  return cycle[
    (index - 1) % cycle.length
  ];
}

function cleanEssayBuilderBlock(
  block,
  index,
  total,
) {
  const prompt = String(
    block?.prompt || "",
  ).trim();
  const generatedSentence = String(
    block?.generatedSentence || "",
  ).trim();

  if (!prompt) {
    throw createError(
      502,
      `Groq returned an empty essayBuilder prompt at position ${index + 1}.`,
    );
  }

  if (!generatedSentence) {
    throw createError(
      502,
      `Groq returned an empty essayBuilder sentence at position ${index + 1}.`,
    );
  }

  return {
    type: essayBuilderTypeForIndex(
      index,
      total,
    ),
    phase: "essayBuilder",
    prompt,
    options: [],
    correctIndex: -1,
    generatedSentence,
    baseOrder: index,
  };
}

function cleanCriterionDraft(
  parsed,
  requiredWordCount,
) {
  const learningContent =
    parsed?.learningContent || {};
  const baseSections =
    (
      Array.isArray(
        learningContent.sections,
      )
    ) ?
      learningContent.sections.map(
        cleanLearningSection,
      )
    : [];

  if (baseSections.length < 2) {
    throw createError(
      502,
      "Groq must return at least two structured learning sections.",
    );
  }

  const title = String(
    learningContent.title || "",
  ).trim();

  if (!title) {
    throw createError(
      502,
      "Groq did not return a learning content title.",
    );
  }

  const summary = String(
    learningContent.summary || "",
  ).trim();
  const learningCheckDrafts =
    (
      Array.isArray(
        parsed?.learningCheckBlocks,
      )
    ) ?
      parsed.learningCheckBlocks
    : [];
  const essayBuilderDrafts =
    (
      Array.isArray(
        parsed?.essayBuilderBlocks,
      )
    ) ?
      parsed.essayBuilderBlocks
    : [];

  if (learningCheckDrafts.length < 3) {
    throw createError(
      502,
      "Groq must return at least three learningCheck blocks.",
    );
  }

  if (essayBuilderDrafts.length < 3) {
    throw createError(
      502,
      "Groq must return at least three essayBuilder blocks.",
    );
  }

  let sections = baseSections;
  const learningCheckBlocks =
    learningCheckDrafts.map(
      (block, index) => {
        const cleanedBlock =
          cleanLearningCheckBlock(
            block,
            index,
            sections,
          );
        sections =
          cleanedBlock.sections;
        return cleanedBlock.block;
      },
    );
  const essayBuilderBlocks =
    essayBuilderDrafts.map(
      (block, index, items) =>
        cleanEssayBuilderBlock(
          block,
          index,
          items.length,
        ),
    );

  const generatedWordCount =
    essayBuilderBlocks.reduce(
      (sum, block) =>
        sum +
        countWords(
          block.generatedSentence,
        ),
      0,
    );

  if (
    generatedWordCount <
    requiredWordCount
  ) {
    throw createError(
      502,
      `Groq returned ${generatedWordCount} essay-builder words, below the required ${requiredWordCount}.`,
    );
  }

  return {
    learningContent: {
      title,
      summary,
      sections,
    },
    learningCheckBlocks,
    essayBuilderBlocks,
  };
}

function normalizeSuggestedQuestionCount(
  value,
) {
  const parsed = Number(value);

  if (parsed <= 6) {
    return 5;
  }

  if (parsed <= 9) {
    return 8;
  }

  return 10;
}

function normalizeSuggestedXpReward(
  value,
) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return 20;
  }

  const roundedToFive =
    Math.round(parsed / 5) * 5;
  return clamp(roundedToFive, 10, 50);
}

function cleanKeyPoints(items) {
  const unique = [];

  for (const item of (
    Array.isArray(items)
  ) ?
    items
  : []) {
    const value = String(
      item || "",
    ).trim();

    if (
      !value ||
      unique.includes(value)
    ) {
      continue;
    }

    unique.push(value);
  }

  if (unique.length >= 3) {
    return unique.slice(0, 6);
  }

  return [
    "Use the uploaded source as the lesson anchor.",
    "Teach the concept first before checking recall.",
    "Keep questions calm, direct, and qualification-safe.",
  ];
}

function cleanUnitPlanDraft(
  parsed,
  { subjectName, sessionType },
) {
  const slotLabel =
    sessionType === "unit" ? "Unit"
    : sessionType === "criterion" ?
      "Criterion"
    : sessionType === "afternoon" ?
      "Afternoon"
    : "Morning";
  const unitTitle =
    String(
      parsed?.unitTitle || "",
    ).trim() || `${subjectName} Unit`;
  const unitSummary = String(
    parsed?.unitSummary || "",
  ).trim();
  const suggestedMissionTitle =
    String(
      parsed?.suggestedMissionTitle ||
        "",
    ).trim() ||
    `${subjectName} ${slotLabel} Mission`;
  const suggestedTeacherNote = String(
    parsed?.suggestedTeacherNote || "",
  ).trim();

  if (!unitSummary) {
    throw createError(
      502,
      "Groq did not return a unit summary.",
    );
  }

  return {
    unitTitle,
    unitSummary,
    keyPoints: cleanKeyPoints(
      parsed?.keyPoints,
    ),
    suggestedMissionTitle,
    suggestedTeacherNote,
    suggestedQuestionCount:
      normalizeSuggestedQuestionCount(
        parsed?.suggestedQuestionCount,
      ),
    suggestedXpReward:
      normalizeSuggestedXpReward(
        parsed?.suggestedXpReward,
      ),
  };
}

async function generateMissionWithGroq({
  title,
  subjectName,
  sessionType,
  studentName,
  difficulty,
  questionCount,
  taskCodes = [],
  unitText,
}) {
  const aiSourceText =
    trimSourceTextForAi(unitText);
  const { model, parsed } =
    await requestGroqDraft({
      systemPrompt:
        "You create calm, SEN-friendly classroom missions. Use only the supplied unit text. Teach first, then ask. Each question must begin with a short learning block that explains the idea in simple language so the student can answer from that information. The question must be answerable from the learning block and supplied lesson text, not outside knowledge. The exact correct answer phrase must appear inside learningText for every question. Keep wording concrete, short, and supportive. Avoid trick questions. Return valid JSON only with no markdown, no preamble, and no extra keys.",
      userPrompt: [
        `Mission title: ${title}`,
        `Subject: ${subjectName}`,
        `Session: ${sessionType}`,
        `Student name: ${studentName}`,
        `Difficulty: ${difficulty}`,
        `Question count: ${questionCount}`,
        taskCodes.length ?
          `Task focus: ${taskCodes.join(", ")}`
        : "Task focus: none specified",
        "Return this JSON shape exactly:",
        '{"title":"string","teacherNote":"string","questions":[{"learningText":"string","prompt":"string","options":["full answer option one","full answer option two","full answer option three","full answer option four"],"correctIndex":0,"explanation":"string"}]}',
        `Return exactly ${questionCount} questions.`,
        "For every question:",
        taskCodes.length ?
          `- align prompts to these task codes: ${taskCodes.join(", ")}`
        : "- align prompts to the key skills in the unit text",
        "- learningText must teach the answer first",
        "- prompt must clearly reference the learning note first (for example: Based on what you just learned, ...)",
        "- the exact correct option words must appear in learningText",
        "- the student must be able to answer using only learningText and the provided unit text",
        "- do not ask about facts that are not taught",
        "- options must be full answer text, not labels like A, B, C, or D",
        "- include a real question prompt for every item",
        "- use four distinct answer options and only one should be correct",
        "Example: if the correct option is 'Direct and Indirect', learningText must explicitly mention 'Direct and Indirect' before the question asks about it.",
        "Unit text:",
        aiSourceText,
      ].join("\n"),
      emptyMessage:
        "Groq returned an empty mission payload.",
      parseMessage:
        "Could not parse the Groq mission payload.",
    });

  const questions =
    Array.isArray(parsed.questions) ?
      parsed.questions.map(
        cleanMissionQuestion,
      )
    : [];

  if (questions.length < 1) {
    throw createError(
      502,
      "Groq did not return any usable mission questions.",
    );
  }

  if (
    questions.length < questionCount
  ) {
    throw createError(
      502,
      `Groq returned ${questions.length} questions instead of the requested ${questionCount}.`,
    );
  }

  return {
    title:
      String(
        parsed.title || title,
      ).trim() || title,
    teacherNote: String(
      parsed.teacherNote || "",
    ).trim(),
    questions: questions.slice(
      0,
      questionCount,
    ),
    aiModel: model,
  };
}

async function generateLearningAndBlocksWithGroq({
  subjectName,
  unitTitle,
  criterionTitle,
  criterionDescription,
  requiredWordCount,
  learningPassRate,
  unitText,
}) {
  const aiSourceText =
    trimSourceTextForAi(unitText);
  const essayBuilderBlockCount =
    Math.max(
      3,
      Math.min(
        6,
        Math.ceil(
          requiredWordCount / 18,
        ),
      ),
    );
  const { model, parsed } =
    await requestGroqDraft({
      systemPrompt:
        "You generate structured ADHD-friendly GCSE learning drafts. Use only the supplied unit text and criterion. Return JSON only. You are creating teacher-review drafts, not final published content. The output must include learning content first, then learningCheck recall blocks, then essayBuilder support blocks. Every learningCheck answer must be explicitly taught inside the learning content. EssayBuilder generatedSentence text must be calm, qualification-safe, and sufficient to help the student reach the required word count.",
      userPrompt: [
        `Subject: ${subjectName}`,
        `Unit: ${unitTitle}`,
        `Criterion: ${criterionTitle}`,
        `Criterion description: ${criterionDescription}`,
        `Required word count: ${requiredWordCount}`,
        `Learning pass rate: ${learningPassRate}`,
        `EssayBuilder block count: ${essayBuilderBlockCount}`,
        "Return this JSON shape exactly:",
        '{"learningContent":{"title":"string","summary":"string","sections":[{"heading":"string","body":"string"}]},"learningCheckBlocks":[{"prompt":"string","options":["full answer option one","full answer option two","full answer option three","full answer option four"],"correctIndex":0}],"essayBuilderBlocks":[{"prompt":"string","generatedSentence":"string"}]}',
        "Rules:",
        "- learningContent.sections must have at least 2 sections",
        "- return at least 3 learningCheck blocks",
        `- return exactly ${essayBuilderBlockCount} essayBuilder blocks`,
        "- each learningCheck block must be answerable from the learning content only",
        "- the exact correct answer phrase must appear somewhere in the learning content",
        "- use no more than 4 options per learningCheck block",
        "- essayBuilder generatedSentence text should help build an answer step by step",
        `- the combined essayBuilder generatedSentence text must be enough to reach at least ${requiredWordCount} words`,
        "Unit text:",
        aiSourceText,
      ].join("\n"),
      emptyMessage:
        "Groq returned an empty criterion draft payload.",
      parseMessage:
        "Could not parse the Groq criterion draft payload.",
    });

  return {
    aiModel: model,
    ...cleanCriterionDraft(
      parsed,
      requiredWordCount,
    ),
  };
}

async function planUnitFromSourceWithGroq({
  subjectName,
  sessionType,
  sourceText,
  fileName,
}) {
  const aiSourceText =
    trimSourceTextForAi(sourceText);
  const { model, parsed } =
    await requestGroqDraft({
      systemPrompt:
        "You help teachers plan calm, SEN-friendly lesson units from uploaded source material. Use only the supplied source text. Return JSON only. Produce a concise unit plan, a suggested mission title, a short student-facing teacher note, one mission question count using only 5, 8, or 10, and a fair XP reward between 10 and 50 in steps of 5.",
      userPrompt: [
        `Subject: ${subjectName}`,
        `Lesson slot: ${sessionType}`,
        `Uploaded file name: ${fileName}`,
        "Return this JSON shape exactly:",
        '{"unitTitle":"string","unitSummary":"string","keyPoints":["string","string","string"],"suggestedMissionTitle":"string","suggestedTeacherNote":"string","suggestedQuestionCount":5,"suggestedXpReward":20}',
        "Rules:",
        "- Use only facts clearly supported by the uploaded source text",
        "- keyPoints should contain 3 to 6 short teaching anchors",
        "- suggestedQuestionCount must be 5, 8, or 10",
        "- suggestedXpReward must be between 10 and 50",
        "- suggestedTeacherNote should be short, warm, and student-facing",
        "Uploaded source text:",
        aiSourceText,
      ].join("\n"),
      emptyMessage:
        "Groq returned an empty unit plan payload.",
      parseMessage:
        "Could not parse the Groq unit plan payload.",
    });

  return {
    ...cleanUnitPlanDraft(parsed, {
      subjectName,
      sessionType,
    }),
    aiModel: model,
  };
}

module.exports = {
  generateMissionWithGroq,
  generateLearningAndBlocksWithGroq,
  planUnitFromSourceWithGroq,
};
