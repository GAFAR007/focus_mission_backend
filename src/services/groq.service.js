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

const ESSAY_BUILDER_RETRY_LIMIT = 3;
const ESSAY_TARGET_WORD_MIN = 100;
const ESSAY_TARGET_WORD_MAX = 350;
const ESSAY_TARGET_BLANK_MIN = 10;
const ESSAY_TARGET_BLANK_MAX = 19;
const ESSAY_MODE_OPTIONS = ["NORMAL", "STRETCH_15", "STRETCH_20"];
const ESSAY_MODE_CONFIG = {
  NORMAL: {
    targetWordMin: 100,
    targetWordMax: 220,
    targetSentenceCount: 10,
  },
  STRETCH_15: {
    targetWordMin: 180,
    targetWordMax: 280,
    targetSentenceCount: 15,
  },
  STRETCH_20: {
    targetWordMin: 220,
    targetWordMax: 350,
    // WHY: Targeting 19 keeps sentence-per-blank drafts inside the default
    // blank cap while still matching the requested "~20 sentence" stretch mode.
    targetSentenceCount: 19,
  },
};

function normalizeEssayMode(mode) {
  const normalized = String(mode || "")
    .trim()
    .toUpperCase();
  if (ESSAY_MODE_OPTIONS.includes(normalized)) {
    return normalized;
  }
  return "NORMAL";
}

function ensureEssayModeConfig(mode) {
  return ESSAY_MODE_CONFIG[
    normalizeEssayMode(mode)
  ] || ESSAY_MODE_CONFIG.NORMAL;
}

function cleanSentenceLearnFirst(
  learnFirst,
) {
  const bullets = Array.isArray(
    learnFirst?.bullets,
  ) ?
      learnFirst.bullets
        .map((bullet) => String(bullet || "").trim())
        .filter(Boolean)
    : [];

  const uniqueBullets = [];
  for (const bullet of bullets) {
    if (!uniqueBullets.includes(bullet)) {
      uniqueBullets.push(bullet);
    }
  }

  while (uniqueBullets.length < 3) {
    uniqueBullets.push(
      "Use the sentence clue and choose the best option from A/B/C/D.",
    );
  }

  return {
    title:
      String(learnFirst?.title || "").trim() ||
      "LEARN FIRST",
    bullets: uniqueBullets.slice(0, 6),
  };
}

function cleanEssayPart(
  part,
  sentenceIndex,
  partIndex,
) {
  const type = String(part?.type || "")
    .trim()
    .toLowerCase();
  if (type === "blank") {
    const options = ["A", "B", "C", "D"].reduce(
      (result, key) => {
        const value = String(
          part?.options?.[key] || "",
        ).trim();
        if (value) {
          result[key] = value;
        }
        return result;
      },
      {},
    );
    return {
      type: "blank",
      blankId:
        String(part?.blankId || "").trim() ||
        `s${sentenceIndex + 1}b${partIndex + 1}`,
      hint: String(
        part?.hint || "",
      ).trim(),
      options,
    };
  }

  return {
    type: "text",
    value: String(
      part?.value || "",
    ),
  };
}

function enforceSentenceRole(
  role,
  index,
  totalSentences,
) {
  if (index === 0) {
    return "topic";
  }
  if (index === totalSentences - 1) {
    return "conclusion";
  }
  const normalized = String(role || "")
    .trim()
    .toLowerCase();
  return normalized === "topic" ||
      normalized === "detail" ||
      normalized === "conclusion" ?
      normalized
    : "detail";
}

function countEssayBuilderBlanks(
  sentences,
) {
  return (
    Array.isArray(sentences) ?
      sentences
    : []
  ).reduce(
    (sum, sentence) =>
      sum +
      (Array.isArray(
        sentence?.parts,
      ) ?
        sentence.parts
      : []
      ).filter(
        (part) =>
          part &&
          part.type ===
            "blank",
      ).length,
    0,
  );
}

function extractEssayKeywordsFromSource(
  unitText,
) {
  const source = String(
    unitText || "",
  ).toLowerCase();
  const selected = [];

  const stopWords = new Set([
    "the",
    "and",
    "that",
    "with",
    "from",
    "this",
    "your",
    "their",
    "into",
    "about",
    "over",
    "under",
    "also",
    "more",
    "than",
    "have",
    "will",
    "such",
    "just",
    "text",
    "task",
    "write",
    "words",
    "student",
    "lesson",
    "topic",
    "question",
    "answer",
    "option",
    "choose",
    "essay",
    "builder",
  ]);
  const tokens = source
    .split(/[^a-z]+/g)
    .map((word) => word.trim())
    .filter(
      (word) =>
        word.length >= 4 &&
        !stopWords.has(word),
    );

  const counts = new Map();
  for (const token of tokens) {
    counts.set(
      token,
      Number(
        counts.get(token) || 0,
      ) + 1,
    );
  }

  const ranked = Array.from(
    counts.entries(),
  )
    .sort((left, right) => {
      if (right[1] !== left[1]) {
        return right[1] - left[1];
      }
      return left[0].localeCompare(
        right[0],
      );
    })
    .map((entry) => entry[0]);

  for (const word of ranked) {
    if (
      !selected.includes(word)
    ) {
      selected.push(word);
    }
    if (selected.length >= 6) {
      break;
    }
  }

  if (!selected.length) {
    return [
      "key concept",
      "main point",
      "lesson detail",
      "supporting idea",
    ];
  }

  return selected;
}

function buildAutoEssayBlankOptions(
  keywords,
  seedIndex,
) {
  const safeKeywords =
    Array.isArray(keywords) &&
    keywords.length > 0 ?
      keywords
    : [
        "lifestyle",
        "health",
        "wellbeing",
        "routine",
      ];
  const candidatePool = [
    safeKeywords[
      seedIndex %
        safeKeywords.length
    ],
    safeKeywords[
      (seedIndex + 1) %
        safeKeywords.length
    ],
    "daily habits",
    "support routines",
    "balanced choices",
  ]
    .map((value) =>
      String(value || "").trim(),
    )
    .filter(Boolean);

  const distinct = [];
  for (const value of candidatePool) {
    if (
      !distinct.includes(value)
    ) {
      distinct.push(value);
    }
  }

  while (distinct.length < 4) {
    distinct.push(
      `option ${distinct.length + 1}`,
    );
  }

  return {
    A: distinct[0],
    B: distinct[1],
    C: distinct[2],
    D: distinct[3],
  };
}

function buildAutoEssaySentence({
  sentenceIndex,
  blankIndex,
  keywords,
}) {
  const options =
    buildAutoEssayBlankOptions(
      keywords,
      blankIndex,
    );
  const answerHint =
    options.A || "main idea";

  return {
    id: `s${sentenceIndex + 1}`,
    role: "detail",
    learnFirst: {
      title: "LEARN FIRST",
      bullets: [
        "Read the sentence clue and focus on the key lifestyle factor.",
        "Choose the option that best matches the lesson wording.",
        `Look for ${answerHint} as the clearest fit.`,
      ],
    },
    parts: [
      {
        type: "text",
        value:
          "A key idea in this lesson is ",
      },
      {
        type: "blank",
        blankId:
          `auto_b${blankIndex + 1}`,
        hint: "Pick the best factor",
        options,
      },
      {
        type: "text",
        value:
          ", which supports the main point of this lesson.",
      },
    ],
  };
}

function ensureEssayDraftBlankMinimum(
  sentences,
  unitText,
) {
  const nextSentences = Array.isArray(
    sentences,
  ) ?
      [...sentences]
    : [];
  const keywords =
    extractEssayKeywordsFromSource(
      unitText,
    );
  let blankCount =
    countEssayBuilderBlanks(
      nextSentences,
    );

  // WHY: The draft contract requires at least 10 blanks for the guided
  // sentence-builder interaction. Auto-padding avoids wasting retries when the
  // model under-generates by one or two blanks.
  let guard = 0;
  while (
    blankCount <
      ESSAY_TARGET_BLANK_MIN &&
    guard < 20
  ) {
    nextSentences.push(
      buildAutoEssaySentence(
        {
          sentenceIndex:
            nextSentences.length,
          blankIndex:
            blankCount,
          keywords,
        },
      ),
    );
    blankCount =
      countEssayBuilderBlanks(
        nextSentences,
      );
    guard += 1;
  }

  return nextSentences;
}

function sanitizeEssayBuilderDraft(
  draftJson,
  mode,
  unitText = "",
) {
  const normalizedMode =
    normalizeEssayMode(
      draftJson?.mode || mode,
    );
  const modeConfig =
    ensureEssayModeConfig(
      normalizedMode,
    );
  const rawSentences = Array.isArray(
    draftJson?.sentences,
  ) ?
      draftJson.sentences
    : Array.isArray(
        draftJson?.builder?.sentences,
      ) ?
      draftJson.builder.sentences
    : [];

  const mappedSentences =
    rawSentences.map(
      (sentence, index, items) => {
        const parts = Array.isArray(
          sentence?.parts,
        ) ?
            sentence.parts
          : [];
        return {
          id:
            String(
              sentence?.id ||
                `s${index + 1}`,
            ).trim() ||
            `s${index + 1}`,
          role:
            enforceSentenceRole(
              sentence?.role,
              index,
              items.length,
            ),
          learnFirst:
            cleanSentenceLearnFirst(
              sentence?.learnFirst,
            ),
          parts: parts.map(
            (
              part,
              partIndex,
            ) =>
              cleanEssayPart(
                part,
                index,
                partIndex,
              ),
          ),
        };
      },
    );

  const minimumBlankSentences =
    ensureEssayDraftBlankMinimum(
      mappedSentences,
      unitText,
    );
  const sentences =
    minimumBlankSentences.map(
      (sentence, index, items) => ({
        ...sentence,
        role:
          enforceSentenceRole(
            sentence?.role,
            index,
            items.length,
          ),
      }),
    );
  const blankCount =
    countEssayBuilderBlanks(
      sentences,
    );
  const rawTargets =
    draftJson?.targets &&
    typeof draftJson.targets ===
      "object" ?
      draftJson.targets
    : {};

  return {
    type:
      String(
        draftJson?.type ||
          "ESSAY_BUILDER",
      )
        .trim()
        .toUpperCase(),
    mode: normalizedMode,
    targets: {
      targetWordMin: Number(
        rawTargets.targetWordMin ||
          modeConfig.targetWordMin,
      ),
      targetWordMax: Number(
        rawTargets.targetWordMax ||
          modeConfig.targetWordMax,
      ),
      targetSentenceCount: Number(
        sentences.length ||
          rawTargets.targetSentenceCount ||
          modeConfig.targetSentenceCount,
      ),
      targetBlankCount: Number(
        blankCount ||
          rawTargets.targetBlankCount ||
          ESSAY_TARGET_BLANK_MIN,
      ),
    },
    sentences,
  };
}

function normalizeEssayText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function pickOptionByWordLength(
  options,
  strategy,
) {
  const values = ["A", "B", "C", "D"]
    .map((key) =>
      String(
        options?.[key] || "",
      ).trim(),
    )
    .filter(Boolean);
  if (!values.length) {
    return "";
  }

  const sorted = values.sort(
    (left, right) =>
      countWords(left) -
      countWords(right),
  );
  return strategy === "max" ?
      sorted[sorted.length - 1]
    : sorted[0];
}

function assembleEssayForRange(
  sentences,
  strategy,
) {
  const rendered = [];
  for (const sentence of (
    Array.isArray(sentences)
  ) ?
    sentences
  : []) {
    const buffer = [];
    const parts = Array.isArray(
      sentence?.parts,
    ) ?
        sentence.parts
      : [];
    for (const part of parts) {
      if (!part || typeof part !== "object") {
        continue;
      }
      if (part.type === "blank") {
        buffer.push(
          pickOptionByWordLength(
            part.options,
            strategy,
          ),
        );
        continue;
      }
      buffer.push(
        String(part.value || ""),
      );
    }
    const sentenceText =
      normalizeEssayText(
        buffer.join(""),
      );
    if (sentenceText) {
      rendered.push(sentenceText);
    }
  }
  return normalizeEssayText(
    rendered.join(" "),
  );
}

function validateEssayBuilderDraft(
  draftJson,
  {
    allowOverflowBlanks = false,
  } = {},
) {
  const errors = [];
  if (!draftJson || typeof draftJson !== "object") {
    return {
      isValid: false,
      errors: [
        "JSON invalid or empty.",
      ],
    };
  }

  if (draftJson.type !== "ESSAY_BUILDER") {
    errors.push(
      "Draft type must be ESSAY_BUILDER.",
    );
  }

  if (
    !ESSAY_MODE_OPTIONS.includes(
      String(
        draftJson.mode || "",
      ).toUpperCase(),
    )
  ) {
    errors.push(
      "Mode must be NORMAL, STRETCH_15, or STRETCH_20.",
    );
  }

  const targets =
    draftJson.targets &&
    typeof draftJson.targets ===
      "object" ?
      draftJson.targets
    : null;
  if (!targets) {
    errors.push(
      "targets are required.",
    );
  }

  const sentences = Array.isArray(
    draftJson.sentences,
  ) ?
      draftJson.sentences
    : [];
  if (!sentences.length) {
    errors.push(
      "sentences are required.",
    );
  }

  let blankCount = 0;
  sentences.forEach(
    (sentence, index) => {
      const parts = Array.isArray(
        sentence?.parts,
      ) ?
          sentence.parts
        : [];
      const blankParts = parts.filter(
        (part) =>
          part &&
          part.type ===
            "blank",
      );
      blankCount += blankParts.length;

      if (blankParts.length < 1) {
        errors.push(
          `Sentence ${index + 1} has zero blanks.`,
        );
      }

      if (
        !sentence?.learnFirst ||
        !String(
          sentence.learnFirst.title ||
            "",
        ).trim()
      ) {
        errors.push(
          `Sentence ${index + 1} is missing LEARN FIRST title.`,
        );
      }

      const learnBullets = Array.isArray(
        sentence?.learnFirst?.bullets,
      ) ?
          sentence.learnFirst.bullets
            .map((bullet) =>
              String(
                bullet || "",
              ).trim(),
            )
            .filter(Boolean)
        : [];
      if (!learnBullets.length) {
        errors.push(
          `Sentence ${index + 1} is missing LEARN FIRST bullets.`,
        );
      }

      blankParts.forEach(
        (
          part,
          blankIndex,
        ) => {
          const options =
            part?.options &&
            typeof part.options ===
              "object" ?
              part.options
            : {};
          const keys = Object.keys(
            options,
          ).sort();
          if (
            keys.join(",") !==
            "A,B,C,D"
          ) {
            errors.push(
              `Sentence ${index + 1} blank ${blankIndex + 1} must include exactly A/B/C/D options.`,
            );
          }

          const missingOptionText = [
            "A",
            "B",
            "C",
            "D",
          ].some(
            (key) =>
              !String(
                options?.[key] || "",
              ).trim(),
          );
          if (missingOptionText) {
            errors.push(
              `Sentence ${index + 1} blank ${blankIndex + 1} has an empty option.`,
            );
          }
        },
      );

      const expectedRole =
        index === 0 ?
          "topic"
        : index ===
          sentences.length - 1 ?
          "conclusion"
        : "detail";
      if (
        String(
          sentence?.role || "",
        )
          .trim()
          .toLowerCase() !==
        expectedRole
      ) {
        errors.push(
          `Sentence ${index + 1} role must be ${expectedRole}.`,
        );
      }
    },
  );

  const sentenceCount =
    sentences.length;
  const targetSentenceCount =
    Number(
      targets?.targetSentenceCount,
    );
  const targetBlankCount = Number(
    targets?.targetBlankCount,
  );
  const targetWordMin = Number(
    targets?.targetWordMin,
  );
  const targetWordMax = Number(
    targets?.targetWordMax,
  );

  if (!targets) {
    errors.push(
      "targets are missing.",
    );
  } else {
    if (
      !Number.isInteger(
        targetSentenceCount,
      ) ||
      targetSentenceCount <= 0
    ) {
      errors.push(
        "targets.targetSentenceCount must be a positive integer.",
      );
    }
    if (
      !Number.isInteger(
        targetBlankCount,
      ) ||
      targetBlankCount <= 0
    ) {
      errors.push(
        "targets.targetBlankCount must be a positive integer.",
      );
    }
    if (
      !Number.isInteger(
        targetWordMin,
      ) ||
      targetWordMin <
        ESSAY_TARGET_WORD_MIN
    ) {
      errors.push(
        `targets.targetWordMin must be at least ${ESSAY_TARGET_WORD_MIN}.`,
      );
    }
    if (
      !Number.isInteger(
        targetWordMax,
      ) ||
      targetWordMax >
        ESSAY_TARGET_WORD_MAX
    ) {
      errors.push(
        `targets.targetWordMax must be at most ${ESSAY_TARGET_WORD_MAX}.`,
      );
    }
    if (
      Number.isInteger(
        targetWordMin,
      ) &&
      Number.isInteger(
        targetWordMax,
      ) &&
      targetWordMin >
        targetWordMax
    ) {
      errors.push(
        "targets.targetWordMin cannot exceed targets.targetWordMax.",
      );
    }
  }

  if (
    targetSentenceCount &&
    sentenceCount !==
      targetSentenceCount
  ) {
    errors.push(
      `targets.targetSentenceCount (${targetSentenceCount}) does not match sentences.length (${sentenceCount}).`,
    );
  }

  if (
    targetBlankCount &&
    blankCount !== targetBlankCount
  ) {
    errors.push(
      `targets.targetBlankCount (${targetBlankCount}) does not match actual blankCount (${blankCount}).`,
    );
  }

  if (
    blankCount <
    ESSAY_TARGET_BLANK_MIN
  ) {
    errors.push(
      `blankCount must be at least ${ESSAY_TARGET_BLANK_MIN}.`,
    );
  }

  const minEssayText =
    assembleEssayForRange(
      sentences,
      "min",
    );
  const maxEssayText =
    assembleEssayForRange(
      sentences,
      "max",
    );
  const estimatedMinWords =
    countWords(minEssayText);
  const estimatedMaxWords =
    countWords(maxEssayText);

  if (
    blankCount >
    ESSAY_TARGET_BLANK_MAX
  ) {
    if (!allowOverflowBlanks) {
      errors.push(
        `blankCount cannot exceed ${ESSAY_TARGET_BLANK_MAX} unless overflow is explicitly allowed.`,
      );
    } else if (
      Number.isInteger(
        targetWordMin,
      ) &&
      estimatedMinWords >=
        targetWordMin
    ) {
      errors.push(
        "blankCount overflow is not allowed when the draft already meets word minimum without overflow.",
      );
    }
  }

  if (
    Number.isInteger(
      targetWordMin,
    ) &&
    estimatedMinWords <
      targetWordMin
  ) {
    errors.push(
      `Estimated minimum words (${estimatedMinWords}) is below targetWordMin (${targetWordMin}).`,
    );
  }

  if (
    Number.isInteger(
      targetWordMax,
    ) &&
    estimatedMaxWords >
      targetWordMax
  ) {
    errors.push(
      `Estimated maximum words (${estimatedMaxWords}) exceeds targetWordMax (${targetWordMax}).`,
    );
  }

  return {
    isValid: errors.length === 0,
    errors,
    metrics: {
      sentenceCount,
      blankCount,
      estimatedMinWords,
      estimatedMaxWords,
    },
  };
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

function lineContainsWordCountInstruction(
  line,
) {
  const normalized = String(
    line || "",
  )
    .trim()
    .toLowerCase();
  if (!normalized) {
    return false;
  }

  // WHY: Only strip explicit "write X words" style instructions, not normal
  // curriculum content that happens to include the word "word" in another
  // context.
  const hasWordToken =
    /\bword(s)?\b/.test(
      normalized,
    );
  const hasNumericRange =
    /\b\d{2,4}\s*[-–to]{1,3}\s*\d{2,4}\b/.test(
      normalized,
    );
  const hasNumericWords =
    /\b\d{2,4}\s*word(s)?\b/.test(
      normalized,
    );
  const hasInstructionVerb =
    /\b(write|minimum|max(?:imum)?|at least|no more than|between|approx(?:\.|imately)?|around|target)\b/.test(
      normalized,
    );

  return (
    hasWordToken &&
    (hasNumericRange || hasNumericWords) &&
    hasInstructionVerb
  );
}

function sanitizeEssayBuilderSourceText(
  unitText,
) {
  const sourceText = String(
    unitText || "",
  )
    .replace(/\r/g, "")
    .trim();
  if (!sourceText) {
    return {
      text: "",
      removedCount: 0,
    };
  }

  const lines = sourceText.split("\n");
  const keptLines = [];
  let removedCount = 0;

  for (const line of lines) {
    if (
      lineContainsWordCountInstruction(
        line,
      )
    ) {
      removedCount += 1;
      continue;
    }
    keptLines.push(line);
  }

  const sanitizedText = keptLines
    .join("\n")
    .trim();
  return {
    text:
      sanitizedText ||
      sourceText,
    removedCount,
  };
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

async function generateEssayBuilderDraft({
  title,
  subjectName,
  sessionType,
  studentName,
  taskCodes = [],
  unitText,
  mode = "NORMAL",
  teacherId = "",
  missionDraftId = "",
  allowOverflowBlanks = false,
}) {
  const normalizedMode = normalizeEssayMode(mode);
  const modeConfig =
    ensureEssayModeConfig(
      normalizedMode,
    );
  const sourceSanitization =
    sanitizeEssayBuilderSourceText(
      unitText,
    );
  const aiSourceText =
    trimSourceTextForAi(
      sourceSanitization.text,
    );
  let lastValidationErrors = [];
  let lastError = null;
  let lastModel = "";

  if (
    sourceSanitization.removedCount > 0
  ) {
    console.warn(
      "[groq] essay_builder_source_sanitized",
      {
        missionDraftId:
          String(
            missionDraftId || "",
          ).trim() || null,
        teacherId:
          String(
            teacherId || "",
          ).trim() || null,
        mode: normalizedMode,
        removedCount:
          sourceSanitization.removedCount,
      },
    );
  }

  for (
    let attempt = 1;
    attempt <= ESSAY_BUILDER_RETRY_LIMIT;
    attempt += 1
  ) {
    const regenerationReason = lastValidationErrors.length ?
        `Previous draft failed validation: ${lastValidationErrors.join(" | ")}`
      : "";
    try {
      // WHY: Essay builder drafts must come from Groq so the sentence scaffolds
      // reflect the exact unitText and stay inside teacher-reviewed draft flow.
      const { model, parsed } = await requestGroqDraft(
        {
          systemPrompt:
            "You generate SEN-friendly DAILY Essay Builder drafts for ADHD learners. Student never types. Student only picks A/B/C/D options. Return JSON only with no markdown.",
          userPrompt: [
            `Mission title: ${title}`,
            `Subject: ${subjectName}`,
            `Session: ${sessionType}`,
            `Student name: ${studentName}`,
            `Essay mode: ${normalizedMode}`,
            `Mode target sentence count: approximately ${modeConfig.targetSentenceCount}`,
            `Mode target word range: ${modeConfig.targetWordMin}-${modeConfig.targetWordMax}`,
            taskCodes.length ?
              `Task focus: ${taskCodes.join(", ")}`
            : "Task focus: none specified",
            regenerationReason ?
              `Regeneration reason: ${regenerationReason}`
            : "Regeneration reason: none",
            "Return JSON only with this shape:",
            '{"type":"ESSAY_BUILDER","mode":"NORMAL","targets":{"targetWordMin":100,"targetWordMax":350,"targetSentenceCount":10,"targetBlankCount":10},"sentences":[{"id":"s1","role":"topic","learnFirst":{"title":"LEARN FIRST","bullets":["...","...","..."]},"parts":[{"type":"text","value":"..."},{"type":"blank","blankId":"b1","hint":"short hint","options":{"A":"...","B":"...","C":"...","D":"..."}},{"type":"text","value":"..."}]}]}',
            "Rules:",
            "- Use ONLY the provided unit text. Do not add outside facts.",
            "- Calm, SEN-friendly, concrete language.",
            "- Every sentence must include sentence-level LEARN FIRST with title and bullets.",
            "- Every sentence must include at least one blank.",
            "- Every blank must have exactly four options: A, B, C, D.",
            "- Exactly one option should be the best fit. Others can be plausible but less correct.",
            "- First sentence role must be topic. Last must be conclusion. Middle must be detail.",
            `- Prefer total blanks between ${ESSAY_TARGET_BLANK_MIN} and ${ESSAY_TARGET_BLANK_MAX}. Only exceed if needed to keep draft above minimum words.`,
            `- targetWordMin must be >= ${ESSAY_TARGET_WORD_MIN} and targetWordMax must be <= ${ESSAY_TARGET_WORD_MAX}.`,
            "- targetSentenceCount and targetBlankCount must match the actual generated totals.",
            "- Ignore any source-internal word-count instruction that conflicts with mode targets. Mode targets are the only valid word limits.",
            "- Draft must produce a complete essay paragraph when blanks are filled.",
            "Unit text:",
            aiSourceText,
          ].join("\n"),
          emptyMessage:
            "Groq returned an empty essay builder payload.",
          parseMessage:
            "Could not parse the Groq essay builder payload.",
        },
      );

      lastModel = model;
      const draftJson =
        sanitizeEssayBuilderDraft(
          parsed,
          normalizedMode,
          sourceSanitization.text,
        );
      const validation =
        validateEssayBuilderDraft(
          draftJson,
          {
            allowOverflowBlanks,
          },
        );

      if (validation.isValid) {
        return {
          title: String(
            title || "",
          ).trim(),
          teacherNote:
            "Complete each sentence by choosing A/B/C/D options to build your essay.",
          questions: [],
          aiModel: model,
          draftJson,
        };
      }

      lastValidationErrors =
        validation.errors;
      lastError = createError(
        502,
        validation.errors.join(
          " | ",
        ),
      );
      console.error(
        "[groq] essay_builder_validation_failed",
        {
          missionDraftId:
            String(
              missionDraftId || "",
            ).trim() || null,
          teacherId:
            String(
              teacherId || "",
            ).trim() || null,
          mode: normalizedMode,
          retryCount:
            attempt,
          validationErrors:
            validation.errors,
          metrics:
            validation.metrics,
        },
      );
    } catch (error) {
      if (error?.statusCode === 503) {
        throw error;
      }
      lastError = error;
      lastValidationErrors = [
        String(
          error?.message ||
            "Unknown Groq generation failure.",
        ),
      ];
      console.error(
        "[groq] essay_builder_generation_failed",
        {
          missionDraftId:
            String(
              missionDraftId || "",
            ).trim() || null,
          teacherId:
            String(
              teacherId || "",
            ).trim() || null,
          mode: normalizedMode,
          retryCount:
            attempt,
          validationErrors:
            lastValidationErrors,
        },
      );
    }
  }

  if (lastError?.statusCode === 503) {
    throw lastError;
  }

  const friendlyError =
    createError(
      502,
      "Could not generate an essay draft from this text. Try selecting a different task section or simplify the source.",
    );
  friendlyError.metadata = {
    missionDraftId:
      String(
        missionDraftId || "",
      ).trim() || null,
    teacherId:
      String(
        teacherId || "",
      ).trim() || null,
    mode: normalizedMode,
    aiModel: lastModel,
    validationErrors:
      lastValidationErrors,
  };
  throw friendlyError;
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
  generateEssayBuilderDraft,
  generateLearningAndBlocksWithGroq,
  planUnitFromSourceWithGroq,
};
