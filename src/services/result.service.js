/**
 * WHAT:
 * result.service owns mission result package creation, retrieval, screenshot
 * storage, send actions, and email retry processing.
 * WHY:
 * Mission evidence must remain auditable and reliably deliverable even when an
 * email channel fails transiently.
 * HOW:
 * Build immutable result packages at completion, store send logs per action,
 * attempt in-app/email delivery, and retry pending email sends on an interval.
 */

const Mission = require("../models/Mission");
const ResultPackage = require("../models/ResultPackage");
const ResultScreenshot = require("../models/ResultScreenshot");
const SessionLog = require("../models/SessionLog");
const SendLog = require("../models/SendLog");
const User = require("../models/User");

let retryWorkerHandle = null;
let retryWorkerRunning = false;

function createError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function countWords(value) {
  return String(value || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

function toOptionLetter(index) {
  const normalizedIndex = Number(index);
  if (!Number.isInteger(normalizedIndex)) {
    return "";
  }
  const letters = ["A", "B", "C", "D"];
  return letters[normalizedIndex] || "";
}

function buildOptionMap(options) {
  const safeOptions = Array.isArray(options) ?
      options
    : [];
  return {
    A: String(
      safeOptions[0] || "",
    ).trim(),
    B: String(
      safeOptions[1] || "",
    ).trim(),
    C: String(
      safeOptions[2] || "",
    ).trim(),
    D: String(
      safeOptions[3] || "",
    ).trim(),
  };
}

function buildBlankOptionMap(options) {
  const safeOptions =
    options &&
    typeof options ===
      "object" ?
      options
    : {};
  return {
    A: String(
      safeOptions.A || "",
    ).trim(),
    B: String(
      safeOptions.B || "",
    ).trim(),
    C: String(
      safeOptions.C || "",
    ).trim(),
    D: String(
      safeOptions.D || "",
    ).trim(),
  };
}

function normalizeText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeEmail(email) {
  return String(email || "")
    .trim()
    .toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
    normalizeEmail(email),
  );
}

function normalizeRecipients({
  teacherEmail,
  recipients,
}) {
  const unique = new Set();
  const ordered = [];
  const addEmail = (email) => {
    const normalized = normalizeEmail(email);
    if (
      !normalized ||
      !isValidEmail(normalized) ||
      unique.has(normalized)
    ) {
      return;
    }
    unique.add(normalized);
    ordered.push(normalized);
  };

  // WHY: Teacher default email must always be included so result dispatch
  // cannot omit the responsible classroom owner.
  addEmail(teacherEmail);
  for (const recipient of (
    Array.isArray(recipients)
  ) ?
    recipients
  : []) {
    addEmail(recipient);
  }

  return ordered;
}

function buildQuestionEvidence({
  missionQuestions,
  questionResponses,
}) {
  const selectedByIndex = new Map();
  for (const response of (
    Array.isArray(questionResponses)
  ) ?
    questionResponses
  : []) {
    const questionIndex = Number(
      response?.questionIndex,
    );
    const selectedIndex = Number(
      response?.selectedIndex,
    );
    if (
      Number.isInteger(questionIndex) &&
      questionIndex >= 0 &&
      Number.isInteger(selectedIndex)
    ) {
      selectedByIndex.set(
        questionIndex,
        selectedIndex,
      );
    }
  }

  const perQuestion = (
    Array.isArray(missionQuestions)
  ) ?
    missionQuestions.map(
      (question, index) => {
        const options = Array.isArray(
          question?.options,
        ) ?
            question.options.map(
              (option) =>
                String(
                  option || "",
                ).trim(),
            )
          : [];
        const selectedIndex = selectedByIndex.has(index) ?
            Number(
              selectedByIndex.get(
                index,
              ),
            )
          : -1;
        const selectedAnswer =
          selectedIndex >= 0 &&
          selectedIndex <
            options.length ?
            options[selectedIndex]
          : "";
        const optionMap =
          buildOptionMap(options);
        const selectedOptionLetter = toOptionLetter(
          selectedIndex,
        );
        const remainingOptions =
          options.filter(
            (
              _value,
              optionIndex,
            ) =>
              optionIndex !==
              selectedIndex,
          );
        const correctness =
          selectedIndex ===
          Number(
            question?.correctIndex,
          );
        const correctIndex = Number(
          question?.correctIndex,
        );
        const correctAnswer =
          correctIndex >= 0 &&
          correctIndex <
            options.length ?
            options[correctIndex]
          : "";
        const correctOptionLetter = toOptionLetter(
          correctIndex,
        );
        const maxPoints = 1;
        const pointsEarned =
          correctness ? 1 : 0;

        return {
          questionText: String(
            question?.prompt || "",
          ).trim(),
          options: optionMap,
          selectedOptionLetter,
          selectedAnswer,
          correctOptionLetter,
          correctAnswer,
          remainingOptions,
          correctness,
          maxPoints,
          pointsEarned,
          attempted:
            selectedAnswer.length > 0,
        };
      },
    )
  : [];
  const totalPointsEarned =
    perQuestion.reduce(
      (sum, question) =>
        sum +
        Number(
          question?.pointsEarned || 0,
        ),
      0,
    );
  const totalPointsPossible =
    perQuestion.reduce(
      (sum, question) =>
        sum +
        Number(
          question?.maxPoints || 0,
        ),
      0,
    );
  const questionsAnsweredCount =
    perQuestion.filter(
      (question) =>
        question?.attempted === true,
    ).length;

  return {
    format: "QUESTIONS",
    questionsAnsweredCount,
    totalPointsEarned,
    totalPointsPossible,
    questions: perQuestion,
  };
}

function resolveMissionScoreSnapshot(
  mission,
) {
  const fallbackTotal =
    mission?.draftFormat ===
    "ESSAY_BUILDER" ?
      Number(
        mission?.draftJson?.targets
          ?.targetSentenceCount || 0,
      )
    : Array.isArray(mission?.questions) ?
      mission.questions.length
    : 0;
  const scoreTotal = Math.max(
    0,
    Number(
      mission?.latestScoreTotal ||
        fallbackTotal ||
        0,
    ),
  );
  const scoreCorrect = Math.max(
    0,
    Math.min(
      Number(
        mission?.latestScoreCorrect ||
          0,
      ),
      scoreTotal,
    ),
  );
  const scorePercent =
    scoreTotal > 0 ?
      Math.round(
        (scoreCorrect / scoreTotal) * 100,
      )
    : 0;

  return {
    scoreCorrect,
    scoreTotal,
    scorePercent,
  };
}

function buildLegacyQuestionEvidence({
  missionQuestions,
  scoreCorrect,
  scoreTotal,
}) {
  const questions = Array.isArray(
    missionQuestions,
  ) ?
      missionQuestions
    : [];
  const normalizedTotal = Math.max(
    questions.length,
    Number(scoreTotal || 0),
  );
  const normalizedCorrect = Math.max(
    0,
    Math.min(
      Number(scoreCorrect || 0),
      normalizedTotal,
    ),
  );

  const perQuestion = questions.map(
    (question, index) => {
      const options = Array.isArray(
        question?.options,
      ) ?
          question.options.map(
            (option) =>
              String(option || "").trim(),
          )
        : [];
      const optionMap =
        buildOptionMap(options);
      const correctIndex = Number(
        question?.correctIndex,
      );
      const correctOptionLetter =
        toOptionLetter(correctIndex);
      const correctAnswer =
        correctIndex >= 0 &&
        correctIndex <
          options.length ?
          options[correctIndex]
        : "";
      const reconstructedCorrect =
        index < normalizedCorrect;

      return {
        questionText: String(
          question?.prompt || "",
        ).trim(),
        options: optionMap,
        selectedOptionLetter:
          reconstructedCorrect ?
            correctOptionLetter
          : "",
        selectedAnswer:
          reconstructedCorrect ?
            correctAnswer
          : "",
        correctOptionLetter,
        correctAnswer,
        remainingOptions:
          options.filter(
            (
              _value,
              optionIndex,
            ) =>
              optionIndex !==
              correctIndex,
          ),
        correctness:
          reconstructedCorrect,
        maxPoints: 1,
        pointsEarned:
          reconstructedCorrect ? 1 : 0,
        attempted:
          index <
          Number(scoreTotal || 0),
        legacySelectionUnavailable:
          true,
      };
    },
  );

  return {
    format: "QUESTIONS",
    questionsAnsweredCount: Math.min(
      Number(scoreTotal || 0),
      normalizedTotal,
    ),
    totalPointsEarned: normalizedCorrect,
    totalPointsPossible:
      normalizedTotal,
    questions: perQuestion,
    legacyBackfill: true,
    legacyBackfillReason:
      "This result package was reconstructed from saved mission score totals.",
  };
}

function buildLegacyEssayEvidence({
  draftJson,
}) {
  const baseEvidence =
    buildEssayEvidence({
      draftJson: draftJson || {},
      essayBuilderEvidence: {},
    });

  return {
    ...baseEvidence,
    legacyBackfill: true,
    legacyBackfillReason:
      "This result package was reconstructed from saved mission totals; original blank selections were not preserved.",
  };
}

function mapEssaySelectionsBySentence(
  sentenceResponses,
) {
  const bySentenceId = new Map();
  for (const sentenceResponse of (
    Array.isArray(
      sentenceResponses,
    )
  ) ?
    sentenceResponses
  : []) {
    const sentenceId = String(
      sentenceResponse?.sentenceId || "",
    ).trim();
    if (!sentenceId) {
      continue;
    }
    const blankSelections = new Map();
    for (const blankSelection of (
      Array.isArray(
        sentenceResponse?.blankSelections,
      )
    ) ?
      sentenceResponse.blankSelections
    : []) {
      const blankId = String(
        blankSelection?.blankId || "",
      ).trim();
      const selectedOption = String(
        blankSelection?.selectedOption || "",
      )
        .trim()
        .toUpperCase();
      if (
        blankId &&
        ["A", "B", "C", "D"].includes(
          selectedOption,
        )
      ) {
        blankSelections.set(
          blankId,
          selectedOption,
        );
      }
    }
    bySentenceId.set(
      sentenceId,
      blankSelections,
    );
  }
  return bySentenceId;
}

function buildEssaySentenceOutput(
  sentence,
  selectionMap,
) {
  const buffer = [];
  const blankEvidence = [];
  for (const part of (
    Array.isArray(
      sentence?.parts,
    )
  ) ?
    sentence.parts
  : []) {
    if (
      part &&
      part.type === "blank"
    ) {
      const blankId = String(
        part.blankId || "",
      ).trim();
      const selectedOption = String(
        selectionMap.get(blankId) || "",
      )
        .trim()
        .toUpperCase();
      const options =
        buildBlankOptionMap(
          part?.options,
        );
      const correctOptionLetter = String(
        part?.correctOption || "",
      )
        .trim()
        .toUpperCase();
      const normalizedCorrectOption =
        ["A", "B", "C", "D"].includes(
          correctOptionLetter,
        ) ?
          correctOptionLetter
        : "";
      const selectedText = String(
        options[
          selectedOption
        ] || "",
      ).trim();
      const correctText = String(
        options[
          normalizedCorrectOption
        ] || "",
      ).trim();
      buffer.push(selectedText);
      blankEvidence.push({
        blankId,
        hint: String(
          part?.hint || "",
        ).trim(),
        options,
        chosenOptionLetter:
          selectedOption,
        chosenOptionText:
          selectedText,
        correctOptionLetter:
          normalizedCorrectOption,
        correctOptionText:
          correctText,
        isCorrect:
          selectedOption &&
          normalizedCorrectOption ?
            selectedOption ===
            normalizedCorrectOption
          : false,
      });
      continue;
    }

    buffer.push(
      String(part?.value || ""),
    );
  }

  return {
    blanks: blankEvidence,
    fullSentenceOutput:
      normalizeText(
        buffer.join(""),
      ),
  };
}

function buildEssayEvidence({
  draftJson,
  essayBuilderEvidence,
}) {
  const sentenceResponsesById =
    mapEssaySelectionsBySentence(
      essayBuilderEvidence?.sentenceResponses,
    );
  const sentenceEvidence = [];
  const sentences = Array.isArray(
    draftJson?.sentences,
  ) ?
      draftJson.sentences
    : [];

  for (const sentence of sentences) {
    const sentenceId = String(
      sentence?.id || "",
    ).trim();
    const selectionMap =
      sentenceResponsesById.get(
        sentenceId,
      ) || new Map();
    const built =
      buildEssaySentenceOutput(
        sentence,
        selectionMap,
      );
    sentenceEvidence.push({
      sentenceId,
      role: String(
        sentence?.role || "",
      ).trim(),
      learnFirstBullets: (
        Array.isArray(
          sentence?.learnFirst?.bullets,
        )
      ) ?
          sentence.learnFirst.bullets
            .map((bullet) =>
              String(
                bullet || "",
              ).trim(),
            )
            .filter(Boolean)
        : [],
      blankSelections:
        built.blanks,
      fullSentenceOutput:
        built.fullSentenceOutput,
    });
  }

  const finalEssayText =
    normalizeText(
      essayBuilderEvidence?.finalEssayText ||
        sentenceEvidence
          .map(
            (item) =>
              item.fullSentenceOutput,
          )
          .join(" "),
    );
  const finalWordCount = Number(
    essayBuilderEvidence?.finalWordCount ||
      countWords(finalEssayText),
  );
  const blankCompletionCount = Number(
    essayBuilderEvidence?.blankCompletedCount ||
      sentenceEvidence.reduce(
        (sum, sentence) =>
          sum +
          sentence.blankSelections
            .filter(
              (
                blankSelection,
              ) =>
                String(
                  blankSelection.chosenOptionLetter ||
                    "",
                ).trim(),
            )
            .length,
        0,
      ),
  );
  const blankTargetCount = Number(
    essayBuilderEvidence?.blankTargetCount ||
      draftJson?.targets
        ?.targetBlankCount ||
      0,
  );

  return {
    format: "ESSAY_BUILDER",
    mode: String(
      draftJson?.mode || "",
    ).trim(),
    perSentence:
      sentenceEvidence,
    finalEssayText,
    finalWordCount,
    blankCompletionCount,
    blankTargetCount,
  };
}

function serializeSendLog(sendLog) {
  return {
    id: String(
      sendLog._id ||
        sendLog.id ||
        "",
    ),
    resultPackageId: String(
      sendLog.resultPackageId || "",
    ),
    sentBy: String(
      sendLog.sentBy || "",
    ),
    sentAt: sendLog.sentAt ?
        new Date(
          sendLog.sentAt,
        ).toISOString()
      : null,
    recipients: Array.isArray(
      sendLog.recipients,
    ) ?
      sendLog.recipients
    : [],
    channelsAttempted: {
      inApp:
        sendLog?.channelsAttempted
          ?.inApp === true,
      email:
        sendLog?.channelsAttempted
          ?.email === true,
    },
    channelStatus: {
      inApp: {
        status: String(
          sendLog?.channelStatus
            ?.inApp?.status ||
            "not_requested",
        ),
        failureReason: String(
          sendLog?.channelStatus
            ?.inApp
            ?.failureReason || "",
        ),
      },
      email: {
        status: String(
          sendLog?.channelStatus
            ?.email?.status ||
            "not_requested",
        ),
        failureReason: String(
          sendLog?.channelStatus
            ?.email
            ?.failureReason || "",
        ),
      },
    },
    failureReason: String(
      sendLog.failureReason || "",
    ),
    screenshotUrl: String(
      sendLog.screenshotUrl || "",
    ),
    emailRetry: {
      pending:
        sendLog?.emailRetry
          ?.pending === true,
      retryCount: Number(
        sendLog?.emailRetry
          ?.retryCount || 0,
      ),
      maxRetries: Number(
        sendLog?.emailRetry
          ?.maxRetries || 0,
      ),
      nextRetryAt:
        sendLog?.emailRetry
          ?.nextRetryAt ?
          new Date(
            sendLog.emailRetry
              .nextRetryAt,
          ).toISOString()
        : null,
      lastAttemptAt:
        sendLog?.emailRetry
          ?.lastAttemptAt ?
          new Date(
            sendLog.emailRetry
              .lastAttemptAt,
          ).toISOString()
        : null,
    },
  };
}

function serializeResultPackage(
  resultPackage,
  sendLogs = [],
) {
  return {
    id: String(
      resultPackage._id ||
        resultPackage.id ||
        "",
    ),
    studentId: String(
      resultPackage.studentId || "",
    ),
    teacherId: String(
      resultPackage.teacherId || "",
    ),
    missionId: String(
      resultPackage.missionId || "",
    ),
    missionType: String(
      resultPackage.missionType || "",
    ),
    meta: {
      ...resultPackage.meta,
      startTime:
        resultPackage?.meta
          ?.startTime ?
          new Date(
            resultPackage.meta
              .startTime,
          ).toISOString()
        : null,
      submitTime:
        resultPackage?.meta
          ?.submitTime ?
          new Date(
            resultPackage.meta
              .submitTime,
          ).toISOString()
        : null,
    },
    evidence: resultPackage.evidence || {},
    latestSendStatus: String(
      resultPackage.latestSendStatus ||
        "not_sent",
    ),
    createdAt: resultPackage.createdAt ?
        new Date(
          resultPackage.createdAt,
        ).toISOString()
      : null,
    updatedAt: resultPackage.updatedAt ?
        new Date(
          resultPackage.updatedAt,
        ).toISOString()
      : null,
    sendLogs: sendLogs.map(
      serializeSendLog,
    ),
  };
}

async function assertTeacherAccess(
  teacherId,
  resultPackage,
) {
  if (
    String(
      resultPackage?.teacherId || "",
    ) === String(teacherId)
  ) {
    return;
  }

  const mission = await Mission.findById(
    resultPackage.missionId,
  )
    .select("createdBy")
    .lean();
  if (
    mission &&
    String(
      mission.createdBy || "",
    ) === String(teacherId)
  ) {
    return;
  }

  throw createError(
    403,
    "You do not have access to this result package.",
  );
}

function resolveLatestSendStatus(
  sendLog,
) {
  const inAppStatus = String(
    sendLog?.channelStatus
      ?.inApp?.status ||
      "not_requested",
  );
  const emailStatus = String(
    sendLog?.channelStatus
      ?.email?.status ||
      "not_requested",
  );

  if (
    emailStatus ===
    "pending_retry"
  ) {
    return "email_pending_retry";
  }
  if (emailStatus === "fail") {
    return inAppStatus === "success" ?
        "partial_failure"
      : "email_failed";
  }
  if (emailStatus === "success") {
    return "email_sent";
  }
  if (inAppStatus === "success") {
    return "in_app_sent";
  }
  return "not_sent";
}

async function sendResultEmail({
  recipients,
  resultPackage,
  screenshotUrl = "",
}) {
  const webhookUrl = String(
    process.env.RESULT_EMAIL_WEBHOOK_URL ||
      "",
  ).trim();
  if (!webhookUrl) {
    throw createError(
      503,
      "Email provider is not configured.",
    );
  }

  const subject = `Focus Mission Result: ${resultPackage.meta.missionTitle}`;
  const body = [
    `Student: ${resultPackage.meta.studentName}`,
    `Mission: ${resultPackage.meta.missionTitle}`,
    `Score: ${resultPackage.meta.score.correct}/${resultPackage.meta.score.total} (${resultPackage.meta.score.percent}%)`,
    `XP Awarded: ${resultPackage.meta.xpAwarded}`,
    screenshotUrl ?
      `Screenshot: ${screenshotUrl}`
    : "",
  ]
    .filter(Boolean)
    .join("\n");

  // WHY: Delivery is delegated to a configurable webhook so environments can
  // plug in any provider without hardcoding one transport in app logic.
  const response = await fetch(
    webhookUrl,
    {
      method: "POST",
      headers: {
        "Content-Type":
          "application/json",
      },
      body: JSON.stringify({
        to: recipients,
        subject,
        body,
        resultPackageId: String(
          resultPackage._id,
        ),
      }),
    },
  );
  if (!response.ok) {
    const text = await response.text();
    throw createError(
      502,
      `Email provider returned ${response.status}: ${text || "empty response"}`,
    );
  }
}

function calculateNextRetryAt(
  retryCount,
) {
  const minutes = Math.min(
    30,
    Math.max(
      2,
      2 * (retryCount + 1),
    ),
  );
  return new Date(
    Date.now() +
      minutes * 60 * 1000,
  );
}

async function createResultPackageForCompletion({
  student,
  mission,
  sessionLog,
  scoreCorrect,
  scoreTotal,
  scorePercent,
  xpAwarded,
  startTime,
  submitTime,
  resultEvidence,
}) {
  if (!mission) {
    return null;
  }

  const missionType =
    mission.draftFormat ===
    "ESSAY_BUILDER" ?
      "ESSAY_BUILDER"
    : "QUESTIONS";
  const parsedStartTime =
    startTime ?
      new Date(startTime)
    : null;
  const safeStartTime =
    parsedStartTime &&
    !Number.isNaN(
      parsedStartTime.getTime(),
    ) ?
      parsedStartTime
    : null;
  const safeSubmitTime =
    submitTime &&
    !Number.isNaN(
      new Date(submitTime).getTime(),
    ) ?
      new Date(submitTime)
    : new Date();
  const durationSeconds =
    safeStartTime ?
      Math.max(
        0,
        Math.round(
          (safeSubmitTime.getTime() -
            safeStartTime.getTime()) /
            1000,
        ),
      )
    : 0;
  const previousAttemptCount =
    await ResultPackage.countDocuments({
      missionId: mission._id,
      studentId: mission.studentId,
    });
  const completionAttemptNumber =
    Math.max(
      1,
      Number(
        previousAttemptCount || 0,
      ) + 1,
    );
  const evidence = missionType ===
      "ESSAY_BUILDER" ?
      buildEssayEvidence({
        draftJson:
          mission.draftJson || {},
        essayBuilderEvidence:
          resultEvidence
            ?.essayBuilder ||
          {},
      })
    : buildQuestionEvidence({
        missionQuestions:
          mission.questions || [],
        questionResponses:
          resultEvidence
            ?.questionResponses ||
          [],
      });
  const evidenceWithAttempt =
    {
      ...evidence,
      completionAttemptNumber,
      triesToComplete:
        completionAttemptNumber,
    };

  const resultPackage =
    await ResultPackage.create(
      {
        studentId: mission.studentId,
        teacherId:
          mission.createdBy || null,
        missionId: mission._id,
        sessionLogId:
          sessionLog._id,
        subjectId:
          mission.subjectId &&
          typeof mission.subjectId ===
            "object" ?
            mission.subjectId._id
          : mission.subjectId,
        missionType,
        meta: {
          studentName: String(
            student?.name || "",
          ).trim(),
          studentId: String(
            student?._id || "",
          ),
          teacherId: String(
            mission.createdBy || "",
          ),
          missionId: String(
            mission._id || "",
          ),
          missionTitle: String(
            mission.title || "",
          ).trim(),
          subject: String(
            mission?.subjectId?.name ||
              "",
          ).trim(),
          taskCodes: Array.isArray(
            mission.taskCodes,
          ) ?
            mission.taskCodes
          : [],
          assignedDate: String(
            mission.availableOnDate || "",
          ).trim(),
          startTime:
            safeStartTime,
          submitTime:
            safeSubmitTime,
          durationSeconds,
          score: {
            correct:
              Number(
                scoreCorrect || 0,
              ),
            total: Number(
              scoreTotal || 0,
            ),
            percent:
              Number(
                scorePercent || 0,
              ),
          },
          xpAwarded: Number(
            xpAwarded || 0,
          ),
        },
        evidence:
          evidenceWithAttempt,
        latestSendStatus:
          "not_sent",
      },
    );

  // WHY: Mission summary cards need one quick lookup id for the latest result.
  await Mission.findByIdAndUpdate(
    mission._id,
    {
      latestResultPackageId:
        resultPackage._id,
    },
  );

  return resultPackage;
}

async function ensureResultPackageForMission({
  teacherId,
  missionId,
}) {
  const mission = await Mission.findById(
    missionId,
  )
    .populate("subjectId", "name")
    .lean();
  if (!mission) {
    throw createError(
      404,
      "Mission not found.",
    );
  }
  if (
    String(
      mission.createdBy || "",
    ) !== String(teacherId || "")
  ) {
    throw createError(
      403,
      "You do not have access to this mission.",
    );
  }

  const linkedResultPackageId = String(
    mission.latestResultPackageId ||
      "",
  ).trim();
  if (linkedResultPackageId) {
    const linked =
      await ResultPackage.findById(
        linkedResultPackageId,
      )
        .select("_id")
        .lean();
    if (linked) {
      return {
        resultPackageId: String(
          linked._id,
        ),
        created: false,
      };
    }
  }

  // WHY: Older missions may have a saved result package that was never linked
  // on the mission document, so we recover it before creating anything new.
  const existing =
    await ResultPackage.findOne({
      missionId: mission._id,
      studentId: mission.studentId,
    })
      .sort({ createdAt: -1 })
      .select("_id")
      .lean();
  if (existing) {
    await Mission.findByIdAndUpdate(
      mission._id,
      {
        latestResultPackageId:
          existing._id,
      },
    );
    return {
      resultPackageId: String(
        existing._id,
      ),
      created: false,
    };
  }

  const scoreSnapshot =
    resolveMissionScoreSnapshot(
      mission,
    );
  const xpAwarded = Math.max(
    0,
    Number(
      mission.latestXpEarned || 0,
    ),
  );
  if (
    scoreSnapshot.scoreTotal <= 0 &&
    xpAwarded <= 0
  ) {
    return {
      resultPackageId: "",
      created: false,
      reason:
        "mission_not_completed",
    };
  }

  const student = await User.findById(
    mission.studentId,
  )
    .select("name")
    .lean();
  const sessionLog =
    await SessionLog.findOne({
      missionId: mission._id,
      studentId: mission.studentId,
    })
      .sort({ createdAt: -1 })
      .lean();
  const submitTime =
    sessionLog?.createdAt ?
      new Date(
        sessionLog.createdAt,
      )
    : mission.updatedAt ?
      new Date(mission.updatedAt)
    : mission.createdAt ?
      new Date(mission.createdAt)
    : new Date();
  const missionType =
    mission.draftFormat ===
    "ESSAY_BUILDER" ?
      "ESSAY_BUILDER"
    : "QUESTIONS";
  const previousAttemptCount =
    await ResultPackage.countDocuments({
      missionId: mission._id,
      studentId: mission.studentId,
    });
  const completionAttemptNumber =
    Math.max(
      1,
      Number(
        previousAttemptCount || 0,
      ) + 1,
    );
  const evidence =
    missionType ===
    "ESSAY_BUILDER" ?
      buildLegacyEssayEvidence({
        draftJson:
          mission.draftJson || {},
      })
    : buildLegacyQuestionEvidence({
        missionQuestions:
          mission.questions || [],
        scoreCorrect:
          scoreSnapshot.scoreCorrect,
        scoreTotal:
          scoreSnapshot.scoreTotal,
      });
  const evidenceWithAttempt = {
    ...evidence,
    completionAttemptNumber,
    triesToComplete:
      completionAttemptNumber,
  };

  const resultPackage =
    await ResultPackage.create({
      studentId: mission.studentId,
      teacherId:
        mission.createdBy || null,
      missionId: mission._id,
      sessionLogId:
        sessionLog?._id || null,
      subjectId:
        mission.subjectId &&
        typeof mission.subjectId ===
          "object" ?
          mission.subjectId._id
        : mission.subjectId,
      missionType,
      meta: {
        studentName: String(
          student?.name || "",
        ).trim(),
        studentId: String(
          mission.studentId || "",
        ),
        teacherId: String(
          mission.createdBy || "",
        ),
        missionId: String(
          mission._id || "",
        ),
        missionTitle: String(
          mission.title || "",
        ).trim(),
        subject: String(
          mission?.subjectId?.name ||
            "",
        ).trim(),
        taskCodes: Array.isArray(
          mission.taskCodes,
        ) ?
          mission.taskCodes
        : [],
        assignedDate: String(
          mission.availableOnDate || "",
        ).trim(),
        startTime: null,
        submitTime,
        durationSeconds: 0,
        score: {
          correct:
            scoreSnapshot.scoreCorrect,
          total:
            scoreSnapshot.scoreTotal,
          percent:
            scoreSnapshot.scorePercent,
        },
        xpAwarded,
      },
      evidence:
        evidenceWithAttempt,
      latestSendStatus:
        "not_sent",
    });

  await Mission.findByIdAndUpdate(
    mission._id,
    {
      latestResultPackageId:
        resultPackage._id,
    },
  );

  return {
    resultPackageId: String(
      resultPackage._id,
    ),
    created: true,
  };
}

async function getResultPackageForTeacher({
  teacherId,
  resultPackageId,
}) {
  const resultPackage =
    await ResultPackage.findById(
      resultPackageId,
    ).lean();
  if (!resultPackage) {
    throw createError(
      404,
      "Result package not found.",
    );
  }

  await assertTeacherAccess(
    teacherId,
    resultPackage,
  );
  const sendLogs =
    await SendLog.find({
      resultPackageId,
    })
      .sort({
        createdAt: -1,
      })
      .limit(20)
      .lean();
  return serializeResultPackage(
    resultPackage,
    sendLogs,
  );
}

async function sendResultPackage({
  teacherId,
  resultPackageId,
  recipients,
  channels,
  screenshotUrl = "",
}) {
  const resultPackage =
    await ResultPackage.findById(
      resultPackageId,
    );
  if (!resultPackage) {
    throw createError(
      404,
      "Result package not found.",
    );
  }

  await assertTeacherAccess(
    teacherId,
    resultPackage.toObject(),
  );
  const teacher = await User.findOne(
    {
      _id: teacherId,
      role: "teacher",
    },
  )
    .select("email")
    .lean();
  if (!teacher) {
    throw createError(
      404,
      "Teacher not found.",
    );
  }

  const inAppRequested =
    channels?.inApp === true;
  const emailRequested =
    channels?.email === true;
  if (
    !inAppRequested &&
    !emailRequested
  ) {
    throw createError(
      400,
      "Select at least one send channel.",
    );
  }

  const normalizedRecipients =
    normalizeRecipients({
      teacherEmail: teacher.email,
      recipients,
    });
  const channelStatus = {
    inApp: {
      status: inAppRequested ?
          "success"
        : "not_requested",
      failureReason: "",
    },
    email: {
      status: emailRequested ?
          "fail"
        : "not_requested",
      failureReason: "",
    },
  };
  const now = new Date();
  const sendLog = new SendLog({
    resultPackageId:
      resultPackage._id,
    sentBy: teacherId,
    sentAt: now,
    recipients:
      normalizedRecipients,
    channelsAttempted: {
      inApp: inAppRequested,
      email: emailRequested,
    },
    channelStatus,
    screenshotUrl: String(
      screenshotUrl || "",
    ).trim(),
    emailRetry: {
      pending: false,
      retryCount: 0,
      maxRetries: 3,
      nextRetryAt: null,
      lastAttemptAt:
        emailRequested ?
          now
        : null,
    },
  });

  if (emailRequested) {
    try {
      if (
        !normalizedRecipients.length
      ) {
        throw createError(
          400,
          "No valid email recipients were provided.",
        );
      }
      await sendResultEmail({
        recipients:
          normalizedRecipients,
        resultPackage,
        screenshotUrl,
      });
      sendLog.channelStatus.email = {
        status: "success",
        failureReason: "",
      };
    } catch (error) {
      sendLog.channelStatus.email = {
        status: "pending_retry",
        failureReason: String(
          error?.message ||
            "Email send failed.",
        ),
      };
      sendLog.emailRetry.pending = true;
      sendLog.emailRetry.retryCount = 1;
      sendLog.emailRetry.nextRetryAt =
        calculateNextRetryAt(1);
      sendLog.failureReason = String(
        error?.message ||
          "Email send failed.",
      );
    }
  }

  resultPackage.latestSendStatus =
    resolveLatestSendStatus(sendLog);
  await Promise.all([
    sendLog.save(),
    resultPackage.save(),
  ]);

  return {
    sendLog: serializeSendLog(
      sendLog.toObject(),
    ),
  };
}

async function processPendingEmailRetries() {
  if (retryWorkerRunning) {
    return {
      processed: 0,
    };
  }

  retryWorkerRunning = true;
  try {
    const now = new Date();
    const pendingLogs =
      await SendLog.find({
        "emailRetry.pending": true,
        "emailRetry.nextRetryAt": {
          $lte: now,
        },
        "channelStatus.email.status":
          "pending_retry",
      })
        .sort({
          "emailRetry.nextRetryAt": 1,
        })
        .limit(20);

    let processed = 0;
    for (const sendLog of pendingLogs) {
      const resultPackage =
        await ResultPackage.findById(
          sendLog.resultPackageId,
        );
      if (!resultPackage) {
        sendLog.channelStatus.email = {
          status: "fail",
          failureReason:
            "Result package missing during retry.",
        };
        sendLog.emailRetry.pending =
          false;
        sendLog.failureReason =
          "Result package missing during retry.";
        await sendLog.save();
        processed += 1;
        continue;
      }

      try {
        await sendResultEmail({
          recipients:
            sendLog.recipients || [],
          resultPackage,
          screenshotUrl:
            sendLog.screenshotUrl,
        });
        sendLog.channelStatus.email = {
          status: "success",
          failureReason: "",
        };
        sendLog.emailRetry.pending =
          false;
        sendLog.emailRetry.nextRetryAt =
          null;
        sendLog.emailRetry.lastAttemptAt =
          now;
        sendLog.failureReason = "";
      } catch (error) {
        const nextRetryCount =
          Number(
            sendLog?.emailRetry
              ?.retryCount || 0,
          ) + 1;
        const maxRetries = Number(
          sendLog?.emailRetry
            ?.maxRetries || 3,
        );

        sendLog.emailRetry.retryCount =
          nextRetryCount;
        sendLog.emailRetry.lastAttemptAt =
          now;
        sendLog.failureReason = String(
          error?.message ||
            "Email retry failed.",
        );

        if (
          nextRetryCount >=
          maxRetries
        ) {
          sendLog.channelStatus.email = {
            status: "fail",
            failureReason:
              sendLog.failureReason,
          };
          sendLog.emailRetry.pending =
            false;
          sendLog.emailRetry.nextRetryAt =
            null;
        } else {
          sendLog.channelStatus.email = {
            status: "pending_retry",
            failureReason:
              sendLog.failureReason,
          };
          sendLog.emailRetry.pending =
            true;
          sendLog.emailRetry.nextRetryAt =
            calculateNextRetryAt(
              nextRetryCount,
            );
        }
      }

      await Promise.all([
        sendLog.save(),
        ResultPackage.findByIdAndUpdate(
          resultPackage._id,
          {
            latestSendStatus:
              resolveLatestSendStatus(
                sendLog,
              ),
          },
        ),
      ]);
      processed += 1;
    }

    return { processed };
  } finally {
    retryWorkerRunning = false;
  }
}

function startResultEmailRetryWorker() {
  if (retryWorkerHandle) {
    return;
  }

  const intervalMs = Math.max(
    30000,
    Number(
      process.env
        .RESULT_EMAIL_RETRY_INTERVAL_MS || 60000,
    ),
  );
  retryWorkerHandle = setInterval(
    () => {
      processPendingEmailRetries().catch(
        (error) => {
          console.error(
            "[result] email retry worker failed",
            {
              message:
                error?.message,
            },
          );
        },
      );
    },
    intervalMs,
  );
  if (
    typeof retryWorkerHandle.unref ===
    "function"
  ) {
    retryWorkerHandle.unref();
  }
}

async function uploadResultScreenshot({
  teacherId,
  resultPackageId,
  file,
}) {
  if (
    !file ||
    !Buffer.isBuffer(file.buffer)
  ) {
    throw createError(
      400,
      "Screenshot file is required.",
    );
  }
  const mimeType = String(
    file.mimetype || "",
  ).trim();
  if (!mimeType.startsWith("image/")) {
    throw createError(
      400,
      "Screenshot must be an image file.",
    );
  }

  const resultPackage =
    await ResultPackage.findById(
      resultPackageId,
    ).lean();
  if (!resultPackage) {
    throw createError(
      404,
      "Result package not found.",
    );
  }

  await assertTeacherAccess(
    teacherId,
    resultPackage,
  );
  const screenshot =
    await ResultScreenshot.create(
      {
        resultPackageId:
          resultPackage._id,
        missionId:
          resultPackage.missionId,
        studentId:
          resultPackage.studentId,
        uploadedBy: teacherId,
        fileName: String(
          file.originalname || "",
        ).trim(),
        mimeType,
        byteSize:
          Number(
            file.size || 0,
          ) || file.buffer.length,
        data: file.buffer,
      },
    );
  const screenshotUrl = `/api/teacher/results/screenshots/${String(screenshot._id)}`;
  return {
    screenshot: {
      id: String(
        screenshot._id,
      ),
      resultPackageId: String(
        screenshot.resultPackageId,
      ),
      screenshotUrl,
      uploadedBy: String(
        screenshot.uploadedBy,
      ),
      uploadedAt: new Date(
        screenshot.createdAt,
      ).toISOString(),
      byteSize: Number(
        screenshot.byteSize || 0,
      ),
      mimeType: screenshot.mimeType,
    },
  };
}

async function getResultScreenshotForTeacher({
  teacherId,
  screenshotId,
}) {
  const screenshot =
    await ResultScreenshot.findById(
      screenshotId,
    ).lean();
  if (!screenshot) {
    throw createError(
      404,
      "Result screenshot not found.",
    );
  }
  const resultPackage =
    await ResultPackage.findById(
      screenshot.resultPackageId,
    ).lean();
  if (!resultPackage) {
    throw createError(
      404,
      "Result package not found for screenshot.",
    );
  }

  await assertTeacherAccess(
    teacherId,
    resultPackage,
  );
  return screenshot;
}

module.exports = {
  createResultPackageForCompletion,
  ensureResultPackageForMission,
  getResultPackageForTeacher,
  sendResultPackage,
  processPendingEmailRetries,
  startResultEmailRetryWorker,
  uploadResultScreenshot,
  getResultScreenshotForTeacher,
};
