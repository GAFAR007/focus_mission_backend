/**
 * WHAT:
 * criterionReport.service assembles one live teacher-facing Task Focus report,
 * persists comment overrides, calculates the five-part weighted score, and
 * exports separate student and teacher copies as selectable PDF text.
 * WHY:
 * Teachers need a current report without mutating immutable ResultPackage
 * evidence or accidentally reusing an older score when a redo is pending.
 * HOW:
 * Authorize the teacher/student/subject boundary, choose the newest mission in
 * each evidence stage, load only its linked result, calculate on the backend,
 * merge separate comment overrides, and render a content-only Student Copy or
 * full scoring Teacher Copy from one authoritative payload.
 */
const PDFDocument = require("pdfkit");

const CriterionReportDraft = require("../models/CriterionReportDraft");
const Mission = require("../models/Mission");
const ResultPackage = require("../models/ResultPackage");
const Subject = require("../models/Subject");
const Timetable = require("../models/Timetable");
const User = require("../models/User");
const subjectCertificationService = require("./subjectCertification.service");
const {
  calculateRequiredCorrectAnswers,
} = require("../utils/missionPassPolicy");

const TASK_CODE_PATTERN = /^[PMD]\d+$/;
const REPORT_COPY_TYPES = Object.freeze(["student", "teacher"]);
const SCORING_COMPONENTS = Object.freeze([
  Object.freeze({ key: "theory", label: "Theory", weight: 0.35 }),
  Object.freeze({ key: "assessmentA", label: "Assessment A", weight: 0.35 }),
  Object.freeze({ key: "essay", label: "Essay Builder - Final Essay", weight: 0.2 }),
  Object.freeze({ key: "q5", label: "Q5 Daily", weight: 0.05 }),
  Object.freeze({ key: "q8", label: "Q8 Revision", weight: 0.05 }),
]);

function createError(statusCode, message, code = "CRITERION_REPORT_ERROR") {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function normalizeTaskCode(value) {
  const taskCode = String(value || "").trim().toUpperCase();
  if (!TASK_CODE_PATTERN.test(taskCode)) {
    throw createError(400, "Task code must look like P1, P2, M1, or D1.", "INVALID_TASK_CODE");
  }
  return taskCode;
}

function normalizeReportCopyType(value) {
  const copyType = String(value || "teacher").trim().toLowerCase();
  if (!REPORT_COPY_TYPES.includes(copyType)) {
    throw createError(
      400,
      "Report copy must be student or teacher.",
      "INVALID_REPORT_COPY",
    );
  }
  return copyType;
}

function toTime(value) {
  if (!value) {
    return 0;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime();
}

function compareMissionRecency(left, right) {
  const fields = ["taskFocusAssignedAt", "availableOnDate", "createdAt", "_id"];
  for (const field of fields) {
    if (field === "_id") {
      const comparison = String(right?._id || "").localeCompare(String(left?._id || ""));
      if (comparison !== 0) {
        return comparison;
      }
      continue;
    }
    const leftTime = toTime(left?.[field]);
    const rightTime = toTime(right?.[field]);
    if (leftTime !== rightTime) {
      return rightTime - leftTime;
    }
  }
  return 0;
}

function missionStage(mission) {
  const format = String(mission?.draftFormat || "QUESTIONS").trim().toUpperCase();
  if (format === "THEORY") {
    return "theory";
  }
  if (format === "ESSAY_BUILDER") {
    return "essay";
  }
  const count = Array.isArray(mission?.questions)
    ? mission.questions.length
    : Number(mission?.questionCount || 0);
  if (count === 5) {
    return "q5";
  }
  if (count === 8) {
    return "q8";
  }
  if (count === 10) {
    return "assessment";
  }
  return "other";
}

function assessmentSequence(mission, taskCode) {
  const source = mission?.assessmentSequenceByTaskCode;
  const value = source && typeof source.get === "function"
    ? source.get(taskCode)
    : Object.entries(source && typeof source === "object" ? source : {})
        .find(([key]) => String(key).trim().toUpperCase() === taskCode)?.[1];
  const normalized = String(value || "").trim().toUpperCase();
  return normalized === "A" || normalized === "B" ? normalized : "";
}

function selectCurrentEvidenceMissions(missions, taskCode) {
  const normalizedTaskCode = normalizeTaskCode(taskCode);
  const sorted = [...(Array.isArray(missions) ? missions : [])].sort(
    compareMissionRecency,
  );
  const selected = { q5: null, q8: null, essay: null, theory: null, assessmentA: null, assessmentB: null };
  const unsequencedAssessments = [];

  for (const mission of sorted) {
    if (mission?.evidenceCurrentExcluded === true) {
      // WHY: Move Evidence keeps the source mission and ResultPackage in
      // history, but that old task focus must no longer use it as current.
      continue;
    }
    const stage = missionStage(mission);
    if (["q5", "q8", "essay", "theory"].includes(stage) && !selected[stage]) {
      selected[stage] = mission;
      continue;
    }
    if (stage !== "assessment") {
      continue;
    }
    const sequence = assessmentSequence(mission, normalizedTaskCode);
    if (sequence === "A" && !selected.assessmentA) {
      selected.assessmentA = mission;
    } else if (sequence === "B" && !selected.assessmentB) {
      selected.assessmentB = mission;
    } else if (!sequence) {
      unsequencedAssessments.push(mission);
    }
  }

  // WHY: Historical assessment missions predate A/B metadata. Only when an
  // explicit slot is absent do we use stable chronology; current sequenced
  // redo missions always take precedence over those historical records.
  const legacyChronology = [...unsequencedAssessments].sort((left, right) =>
    compareMissionRecency(right, left),
  );
  if (!selected.assessmentA && legacyChronology.length > 0) {
    selected.assessmentA = legacyChronology.shift();
  }
  if (!selected.assessmentB && legacyChronology.length > 0) {
    selected.assessmentB = legacyChronology.pop();
  }
  return selected;
}

function resultIsLinkedAndCurrent(mission, resultPackage) {
  return Boolean(
    mission &&
      resultPackage &&
      String(mission.latestResultPackageId || "") === String(resultPackage._id || resultPackage.id || "") &&
      String(resultPackage.missionId || "") === String(mission._id || mission.id || ""),
  );
}

function objectiveEvidence(label, mission, resultPackage) {
  if (!mission) {
    return { label, status: "pending", resultPackageId: "", missionId: "" };
  }
  if (!resultIsLinkedAndCurrent(mission, resultPackage)) {
    return {
      label,
      status: "pending",
      missionId: String(mission._id || ""),
      resultPackageId: "",
    };
  }
  const score = resultPackage.meta?.score || {};
  const correct = Number(score.correct || 0);
  const total = Number(score.total || 0);
  const percent = Number(score.percent || 0);
  const requiredCorrect = calculateRequiredCorrectAnswers(total);
  return {
    label,
    status: "scored",
    missionId: String(mission._id || ""),
    resultPackageId: String(resultPackage._id || ""),
    correct,
    total,
    percent,
    // WHY: Result labels reuse the frozen mission policy instead of creating a
    // competing report-only pass threshold.
    passed: requiredCorrect > 0 && correct >= requiredCorrect,
  };
}

function resolveEssayQuestion(mission) {
  const candidates = [
    mission?.draftJson?.essayQuestion,
    mission?.draftJson?.question,
    mission?.draftJson?.prompt,
    mission?.draftJson?.builder?.title,
    mission?.teacherNote,
    mission?.title,
  ];
  return String(candidates.find((item) => String(item || "").trim()) || "").trim();
}

function essayEvidence(mission, resultPackage, reportDraft) {
  const empty = {
    status: "pending",
    missionId: String(mission?._id || ""),
    resultPackageId: "",
    question: resolveEssayQuestion(mission),
    finalEssayText: "",
    wordCount: 0,
    scoreCorrect: null,
    scoreTotal: null,
    percent: null,
    teacherComment: "",
    nextTime: "",
  };
  if (!mission || !resultIsLinkedAndCurrent(mission, resultPackage)) {
    return empty;
  }
  const evidence = resultPackage.evidence || {};
  const review = evidence.teacherReview || {};
  const scored = String(evidence.teacherReviewStatus || "").toLowerCase() === "scored";
  const hasOverride = Boolean(reportDraft);
  return {
    ...empty,
    status: scored ? "scored" : "pending",
    resultPackageId: String(resultPackage._id || ""),
    finalEssayText: String(evidence.finalEssayText || ""),
    wordCount: Number(evidence.finalWordCount || 0),
    scoreCorrect: scored ? Number(review.scoreCorrect ?? resultPackage.meta?.score?.correct ?? 0) : null,
    scoreTotal: scored ? Number(review.scoreTotal ?? resultPackage.meta?.score?.total ?? 0) : null,
    percent: scored ? Number(review.scorePercent ?? resultPackage.meta?.score?.percent ?? 0) : null,
    // WHY: Report overrides are presentation drafts only. The source feedback
    // remains untouched inside immutable submitted evidence.
    teacherComment: hasOverride
      ? String(reportDraft.essayTeacherComment || "")
      : String(review.teacherFeedback || ""),
    nextTime: hasOverride
      ? String(reportDraft.essayNextTime || "")
      : String(review.nextTime || evidence.nextTime || ""),
  };
}

function theoryEvidence(mission, resultPackage, reportDraft) {
  const empty = {
    status: "pending",
    missionId: String(mission?._id || ""),
    resultPackageId: "",
    correct: null,
    total: 100,
    percent: null,
    passed: false,
    questions: [],
  };
  if (!mission || !resultIsLinkedAndCurrent(mission, resultPackage)) {
    return empty;
  }
  const evidence = resultPackage.evidence || {};
  const scored = String(evidence.reviewStatus || "").toLowerCase() === "scored";
  const overrides = new Map(
    (Array.isArray(reportDraft?.theoryQuestionComments)
      ? reportDraft.theoryQuestionComments
      : []).map((item) => [Number(item.questionIndex), String(item.comment || "")]),
  );
  const questions = (Array.isArray(evidence.questions) ? evidence.questions : []).map(
    (question, index) => ({
      questionIndex: index,
      prompt: String(question?.questionText || mission?.questions?.[index]?.prompt || ""),
      studentAnswer: String(question?.studentAnswer || ""),
      wordCount: Number(question?.studentWordCount || 0),
      originalTeacherScore: question?.teacherScorePercent === null || question?.teacherScorePercent === undefined
        ? null
        : Number(question.teacherScorePercent),
      teacherComment: overrides.has(index)
        ? overrides.get(index)
        : String(question?.teacherFeedback || ""),
    }),
  );
  const percent = scored
    ? Number(evidence.averageTeacherScorePercent ?? resultPackage.meta?.score?.percent ?? 0)
    : null;
  return {
    ...empty,
    status: scored ? "scored" : "pending",
    resultPackageId: String(resultPackage._id || ""),
    correct: percent,
    percent,
    passed: scored && Number(percent) >= 70,
    questions,
  };
}

function calculateWeightedScore(percentByKey) {
  const rows = SCORING_COMPONENTS.map((component) => {
    const raw = percentByKey?.[component.key];
    const percent = raw === null || raw === undefined || !Number.isFinite(Number(raw))
      ? null
      : Math.max(0, Math.min(100, Number(raw)));
    const contribution = percent === null
      ? null
      : Number((percent * component.weight).toFixed(2));
    return {
      ...component,
      weightPercent: component.weight * 100,
      percent,
      contribution,
      status: percent === null ? "pending" : "scored",
    };
  });
  const securedContribution = Number(
    rows.reduce((sum, row) => sum + Number(row.contribution || 0), 0).toFixed(2),
  );
  const pending = rows.some((row) => row.status === "pending");
  return {
    rows,
    status: pending ? "pending" : "scored",
    overallPercent: pending ? null : securedContribution,
    securedContribution,
  };
}

async function assertTeacherSubjectAccess({ teacherId, studentId, subjectId }) {
  const [teacher, student, subject, timetableAccess] = await Promise.all([
    User.findOne({ _id: teacherId, role: "teacher" }).select("name").lean(),
    User.findOne({ _id: studentId, role: "student", isArchived: { $ne: true } })
      .select("name")
      .lean(),
    Subject.findById(subjectId).select("name").lean(),
    Timetable.exists({
      studentId,
      $or: [
        { morningSubject: subjectId, morningTeacherId: teacherId },
        { afternoonSubject: subjectId, afternoonTeacherId: teacherId },
      ],
    }),
  ]);
  if (!teacher) {
    throw createError(404, "Teacher not found.", "TEACHER_NOT_FOUND");
  }
  if (!student) {
    throw createError(404, "Student not found.", "STUDENT_NOT_FOUND");
  }
  if (!subject) {
    throw createError(404, "Subject not found.", "SUBJECT_NOT_FOUND");
  }
  if (!timetableAccess) {
    // WHY: A teacher must own both the learner and selected subject through
    // the live timetable before seeing qualification evidence or comments.
    throw createError(
      403,
      "Teachers can only view reports for their assigned students and subjects.",
      "REPORT_ACCESS_DENIED",
    );
  }
  return { teacher, student, subject };
}

function resolveCriterionWording(selected, taskCode, subjectName, override) {
  const savedOverride = String(override || "").trim();
  if (savedOverride) {
    return { text: savedOverride, available: true };
  }
  for (const mission of Object.values(selected)) {
    const candidates = [
      mission?.criterionWording,
      mission?.draftJson?.criterionWording,
      mission?.draftJson?.criterionTitle,
    ];
    const value = candidates.find((item) => String(item || "").trim());
    if (value) {
      return { text: String(value).trim(), available: true };
    }
  }
  // WHY: Older missions do not have a canonical criterion-description field;
  // report output must admit that gap rather than inventing qualification text.
  return {
    text: `${taskCode} — ${subjectName} criterion wording was not stored with this evidence.`,
    available: false,
  };
}

function stageHistory(mission, resultById, teacherById) {
  if (!mission) {
    return null;
  }
  const movedFromTaskCode = String(
    mission.evidenceMovedFromTaskCode || "",
  ).trim();
  if (movedFromTaskCode) {
    const teacherId = String(mission.evidenceMovedBy || "");
    const movedToTaskCode = Array.isArray(mission.taskCodes)
      ? String(mission.taskCodes[0] || "").trim().toUpperCase()
      : "";
    return {
      kind: "move",
      title: movedToTaskCode
        ? `Moved from ${movedFromTaskCode} to ${movedToTaskCode}`
        : `Moved evidence from ${movedFromTaskCode}`,
      detail: `Moved by ${teacherById.get(teacherId) || "teacher"}`,
      at: mission.evidenceMovedAt
        ? new Date(mission.evidenceMovedAt).toISOString()
        : null,
    };
  }
  const previousResultId = String(mission.redoOfResultPackageId || "");
  if (previousResultId) {
    const previousResult = resultById.get(previousResultId) || null;
    const previousPercent = Number(previousResult?.meta?.score?.percent);
    return {
      kind: "redo",
      title: "Redo attempt",
      detail: Number.isFinite(previousPercent)
        ? `Previous result: ${previousPercent}% · Current: Pending`
        : "Previous result retained · Current: Pending",
      at: mission.createdAt ? new Date(mission.createdAt).toISOString() : null,
    };
  }
  return null;
}

async function getCriterionDraftReport({ teacherId, studentId, subjectId, taskCode }) {
  const normalizedTaskCode = normalizeTaskCode(taskCode);
  console.info("[criterion-report] build_start", {
    teacherId,
    studentId,
    subjectId,
    taskCode: normalizedTaskCode,
  });
  const context = await assertTeacherSubjectAccess({ teacherId, studentId, subjectId });
  const [missions, reportDraft, certifications] = await Promise.all([
    Mission.find({
      studentId,
      subjectId,
      taskCodes: normalizedTaskCode,
      taskFocusAssignedAt: { $exists: true, $ne: null },
      manualResultOnly: { $ne: true },
      isArchived: { $ne: true },
      $or: [
        { status: "draft", createdBy: teacherId },
        { status: "published" },
        { status: { $exists: false } },
      ],
    }).lean(),
    CriterionReportDraft.findOne({
      studentId,
      subjectId,
      taskCode: normalizedTaskCode,
    }).lean(),
    subjectCertificationService.getStudentCertificationSummaries({
      studentId,
      subjectId,
      applyAwards: false,
    }),
  ]);
  const selected = selectCurrentEvidenceMissions(missions, normalizedTaskCode);
  const selectedMissions = Object.values(selected).filter(Boolean);
  const resultIds = selectedMissions
    .flatMap((mission) => [
      String(mission?.latestResultPackageId || ""),
      String(mission?.redoOfResultPackageId || ""),
    ])
    .filter(Boolean);
  const movedByIds = selectedMissions
    .map((mission) => String(mission?.evidenceMovedBy || ""))
    .filter(Boolean);
  const [results, movedByTeachers] = await Promise.all([
    resultIds.length
      ? ResultPackage.find({ _id: { $in: resultIds } }).lean()
      : [],
    movedByIds.length
      ? User.find({ _id: { $in: movedByIds }, role: "teacher" })
          .select("name")
          .lean()
      : [],
  ]);
  const resultById = new Map(results.map((result) => [String(result._id), result]));
  const teacherById = new Map(
    movedByTeachers.map((teacher) => [String(teacher._id), String(teacher.name || "teacher")]),
  );
  const resultFor = (mission) =>
    mission ? resultById.get(String(mission.latestResultPackageId || "")) || null : null;

  const q5 = objectiveEvidence("Q5 Daily", selected.q5, resultFor(selected.q5));
  const q8 = objectiveEvidence("Q8 Revision", selected.q8, resultFor(selected.q8));
  const assessmentA = objectiveEvidence(
    `${normalizedTaskCode} Assessment A`,
    selected.assessmentA,
    resultFor(selected.assessmentA),
  );
  const assessmentB = selected.assessmentB
    ? objectiveEvidence(
        `${normalizedTaskCode} Assessment B`,
        selected.assessmentB,
        resultFor(selected.assessmentB),
      )
    : {
        label: `${normalizedTaskCode} Assessment B`,
        status: "not_created",
        optional: true,
        missionId: "",
        resultPackageId: "",
      };
  const essay = {
    ...essayEvidence(selected.essay, resultFor(selected.essay), reportDraft),
    history: stageHistory(selected.essay, resultById, teacherById),
  };
  const theory = {
    ...theoryEvidence(selected.theory, resultFor(selected.theory), reportDraft),
    history: stageHistory(selected.theory, resultById, teacherById),
  };
  const calculation = calculateWeightedScore({
    theory: theory.percent,
    assessmentA: assessmentA.status === "scored" ? assessmentA.percent : null,
    essay: essay.percent,
    q5: q5.status === "scored" ? q5.percent : null,
    q8: q8.status === "scored" ? q8.percent : null,
  });
  const certification = certifications
    .flatMap((summary) => summary.evidenceRows || [])
    .find((row) => String(row.taskCode || "").toUpperCase() === normalizedTaskCode) || null;
  const criterionWording = resolveCriterionWording(
    selected,
    normalizedTaskCode,
    context.subject.name,
    reportDraft?.criterionWording,
  );

  const report = {
    student: { id: String(context.student._id), name: context.student.name },
    subject: { id: String(context.subject._id), name: context.subject.name },
    taskCode: normalizedTaskCode,
    title: `${context.student.name} - ${normalizedTaskCode} ${context.subject.name} Online Report`,
    criterionWording: criterionWording.text,
    criterionWordingAvailable: criterionWording.available,
    q5,
    q8,
    essay,
    theory,
    assessmentA,
    assessmentB,
    scoringStructure: SCORING_COMPONENTS.map((item) => ({
      key: item.key,
      label: item.label,
      weightPercent: item.weight * 100,
    })),
    calculation,
    criterionStatus: certification
      ? {
          status: String(certification.status || "not_started"),
          passed: certification.status === "passed",
          reason: String(certification.reason || ""),
        }
      : {
          status: "not_configured",
          passed: false,
          reason: "This task focus is not configured in the active certification plan.",
        },
    reportDraftUpdatedAt: reportDraft?.updatedAt
      ? new Date(reportDraft.updatedAt).toISOString()
      : null,
  };
  console.info("[criterion-report] build_complete", {
    teacherId,
    studentId,
    subjectId,
    taskCode: normalizedTaskCode,
    overallStatus: calculation.status,
  });
  return report;
}

function normalizeReportDraftPayload(payload) {
  const hasCriterionWording = Object.prototype.hasOwnProperty.call(
    payload || {},
    "criterionWording",
  );
  const criterionWording = String(payload?.criterionWording || "").trim();
  const essayTeacherComment = String(payload?.essayTeacherComment || "");
  const essayNextTime = String(payload?.essayNextTime || "");
  if (criterionWording.length > 5000) {
    throw createError(
      400,
      "Criterion wording must be 5000 characters or fewer.",
      "INVALID_REPORT_DRAFT",
    );
  }
  if (essayTeacherComment.length > 20000 || essayNextTime.length > 20000) {
    throw createError(400, "Essay report comments are too long.", "INVALID_REPORT_DRAFT");
  }
  if (!Array.isArray(payload?.theoryQuestionComments)) {
    throw createError(
      400,
      "theoryQuestionComments must be an array.",
      "INVALID_REPORT_DRAFT",
    );
  }
  const comments = new Map();
  for (const item of payload.theoryQuestionComments) {
    const questionIndex = Number(item?.questionIndex);
    const comment = String(item?.comment || "");
    if (!Number.isInteger(questionIndex) || questionIndex < 0 || questionIndex > 9) {
      throw createError(400, "A Theory comment index is invalid.", "INVALID_REPORT_DRAFT");
    }
    if (comment.length > 10000) {
      throw createError(400, "A Theory report comment is too long.", "INVALID_REPORT_DRAFT");
    }
    comments.set(questionIndex, { questionIndex, comment });
  }
  const normalized = {
    essayTeacherComment,
    essayNextTime,
    theoryQuestionComments: [...comments.values()].sort(
      (left, right) => left.questionIndex - right.questionIndex,
    ),
  };
  if (hasCriterionWording) {
    // WHY: Clients deployed before the editable objective must be able to save
    // comments without silently clearing a newer saved objective.
    normalized.criterionWording = criterionWording;
  }
  return normalized;
}

async function saveCriterionReportDraft({
  teacherId,
  studentId,
  subjectId,
  taskCode,
  payload,
}) {
  const normalizedTaskCode = normalizeTaskCode(taskCode);
  await assertTeacherSubjectAccess({ teacherId, studentId, subjectId });
  const normalized = normalizeReportDraftPayload(payload);
  await CriterionReportDraft.findOneAndUpdate(
    { studentId, subjectId, taskCode: normalizedTaskCode },
    {
      $set: {
        ...normalized,
        updatedBy: teacherId,
      },
      $setOnInsert: { studentId, subjectId, taskCode: normalizedTaskCode },
    },
    { upsert: true, new: true, runValidators: true },
  );
  console.info("[criterion-report] wording_and_comments_saved", {
    teacherId,
    studentId,
    subjectId,
    taskCode: normalizedTaskCode,
  });
  return getCriterionDraftReport({
    teacherId,
    studentId,
    subjectId,
    taskCode: normalizedTaskCode,
  });
}

function formatPercent(value) {
  if (value === null || value === undefined) {
    return "Pending";
  }
  return `${Number(value).toFixed(Number(value) % 1 === 0 ? 0 : 2)}%`;
}

function objectiveLine(item) {
  if (item.status !== "scored") {
    return "Pending";
  }
  return `${item.correct}/${item.total} — ${formatPercent(item.percent)} — ${item.passed ? "Passed" : "Not yet passed"}`;
}

function buildCriterionReportPdf(report, options = {}) {
  const copyType = normalizeReportCopyType(options.copyType);
  return new Promise((resolve, reject) => {
    const reportTitle = String(report.title || "Report")
      .trim()
      .replace(/\bDraft Report\b/gi, "Report");
    const copyLabel = copyType === "student" ? "Student copy" : "Teacher copy";
    const doc = new PDFDocument({
      size: "A4",
      bufferPages: true,
      margins: { top: 44, bottom: 58, left: 44, right: 44 },
      info: {
        Title: `${reportTitle} - ${copyLabel}`,
        Author: "Focus Mission",
        Subject: `${report.taskCode} ${copyLabel}`,
      },
    });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const colors = {
      navy: "#17365D",
      blue: "#3B82F6",
      blueSoft: "#EEF5FF",
      ink: "#17243A",
      muted: "#607493",
      border: "#D7E2F0",
      surface: "#F7F9FC",
      green: "#16826C",
      greenSoft: "#ECF8F4",
      amber: "#A96B16",
      amberSoft: "#FFF6E8",
      white: "#FFFFFF",
    };
    const pdfText = (value, fallback = "-") => {
      const text = String(value || "").trim();
      return (text || fallback).replace(/[–—]/g, "-");
    };
    const left = doc.page.margins.left;
    const contentWidth = doc.page.width - left - doc.page.margins.right;
    const remainingHeight = () => doc.page.height - doc.page.margins.bottom - doc.y;
    const ensureSpace = (height) => {
      if (remainingHeight() < height) {
        doc.addPage();
      }
    };
    const finish = () => {
      const range = doc.bufferedPageRange();
      for (let pageIndex = range.start; pageIndex < range.start + range.count; pageIndex += 1) {
        doc.switchToPage(pageIndex);
        const footerY = doc.page.height - 35;
        const reservedBottomMargin = doc.page.margins.bottom;
        // WHY: The footer sits inside the reserved margin. Temporarily lowering
        // PDFKit's flow margin prevents footer text from creating blank pages.
        doc.page.margins.bottom = 18;
        doc.save()
          .moveTo(left, footerY - 7)
          .lineTo(doc.page.width - doc.page.margins.right, footerY - 7)
          .lineWidth(0.6)
          .strokeColor(colors.border)
          .stroke();
        doc.font("Helvetica").fontSize(8).fillColor(colors.muted)
          .text(`Focus Mission | ${copyLabel}`, left, footerY, {
            width: contentWidth / 2,
            lineBreak: false,
          })
          .text(`Page ${pageIndex + 1} of ${range.count}`, left + contentWidth / 2, footerY, {
            width: contentWidth / 2,
            align: "right",
            lineBreak: false,
          });
        doc.restore();
        doc.page.margins.bottom = reservedBottomMargin;
      }
      doc.end();
    };
    const titleBand = () => {
      const y = doc.y;
      const height = 88;
      doc.save()
        .roundedRect(left, y, contentWidth, height, 12)
        .fill(colors.navy)
        .restore();
      doc.font("Helvetica-Bold").fontSize(8.5).fillColor("#AFCBFA")
        .text("FOCUS MISSION", left + 16, y + 13, {
          width: contentWidth - 32,
          characterSpacing: 1.2,
          lineBreak: false,
        });
      doc.font("Helvetica-Bold").fontSize(17).fillColor(colors.white)
        .text(pdfText(reportTitle), left + 16, y + 31, {
          width: contentWidth - 32,
          height: 25,
          ellipsis: true,
        });
      doc.font("Helvetica").fontSize(9.5).fillColor("#DCE9FA")
        .text(
          `${copyLabel} | ${pdfText(report.subject?.name, "Subject")} | ${pdfText(report.taskCode, "Task")}`,
          left + 16,
          y + 65,
          { width: contentWidth - 32, lineBreak: false },
        );
      doc.x = left;
      doc.y = y + height + 14;
    };
    const sectionHeading = (value) => {
      ensureSpace(34);
      const y = doc.y;
      doc.save().roundedRect(left, y + 2, 4, 19, 2).fill(colors.blue).restore();
      doc.font("Helvetica-Bold").fontSize(15).fillColor(colors.navy)
        .text(pdfText(value), left + 12, y, { width: contentWidth - 12 });
      doc.x = left;
      doc.y = Math.max(doc.y, y + 25);
    };
    const panelHeight = (value, fallback = "Not added") => {
      const text = pdfText(value, fallback);
      const innerWidth = contentWidth - 28;
      doc.font("Helvetica").fontSize(10.5);
      const textHeight = doc.heightOfString(text, { width: innerWidth, lineGap: 1.5 });
      return Math.max(61, textHeight + 43) + 9;
    };
    const panel = (labelText, value, tone = "neutral", fallback = "Not added") => {
      const tones = {
        neutral: { fill: colors.surface, stroke: colors.border, label: colors.muted },
        blue: { fill: colors.blueSoft, stroke: "#C9DCF7", label: colors.blue },
        green: { fill: colors.greenSoft, stroke: "#C5E8DD", label: colors.green },
        amber: { fill: colors.amberSoft, stroke: "#F0D9B5", label: colors.amber },
      };
      const selectedTone = tones[tone] || tones.neutral;
      const text = pdfText(value, fallback);
      const innerWidth = contentWidth - 28;
      const totalHeight = panelHeight(value, fallback);
      const height = totalHeight - 9;
      ensureSpace(totalHeight);
      const y = doc.y;
      doc.save()
        .roundedRect(left, y, contentWidth, height, 9)
        .fillAndStroke(selectedTone.fill, selectedTone.stroke)
        .restore();
      doc.font("Helvetica-Bold").fontSize(8.7).fillColor(selectedTone.label)
        .text(pdfText(labelText).toUpperCase(), left + 14, y + 11, {
          width: innerWidth,
          characterSpacing: 0.35,
          height: 12,
          ellipsis: true,
        });
      doc.font("Helvetica").fontSize(10.5).fillColor(colors.ink)
        .text(text, left + 14, y + 29, {
          width: innerWidth,
          lineGap: 1.5,
        });
      doc.x = left;
      doc.y = y + height + 9;
    };
    const metricPair = (items) => {
      const gap = 10;
      const width = (contentWidth - gap) / 2;
      const height = 61;
      ensureSpace(height + 10);
      const y = doc.y;
      items.forEach((item, index) => {
        const x = left + index * (width + gap);
        doc.save()
          .roundedRect(x, y, width, height, 9)
          .fillAndStroke(colors.surface, colors.border)
          .restore();
        doc.font("Helvetica-Bold").fontSize(8.5).fillColor(colors.muted)
          .text(pdfText(item.label).toUpperCase(), x + 12, y + 11, {
            width: width - 24,
            lineBreak: false,
          });
        doc.font("Helvetica-Bold").fontSize(11.5).fillColor(colors.navy)
          .text(pdfText(item.value, "Pending"), x + 12, y + 31, {
            width: width - 24,
            height: 18,
            ellipsis: true,
          });
      });
      doc.x = left;
      doc.y = y + height + 10;
    };
    const tableRow = (cells, widths, isHeader = false) => {
      const padding = 8;
      doc.font(isHeader ? "Helvetica-Bold" : "Helvetica").fontSize(isHeader ? 8.5 : 9.3);
      const heights = cells.map((cell, index) => doc.heightOfString(pdfText(cell), {
        width: widths[index] - padding * 2,
      }));
      const height = Math.max(isHeader ? 30 : 34, Math.max(...heights) + padding * 2);
      ensureSpace(height + 1);
      const y = doc.y;
      doc.save()
        .rect(left, y, contentWidth, height)
        .fillAndStroke(isHeader ? colors.navy : colors.surface, colors.border)
        .restore();
      let x = left;
      cells.forEach((cell, index) => {
        doc.font(isHeader ? "Helvetica-Bold" : "Helvetica")
          .fontSize(isHeader ? 8.5 : 9.3)
          .fillColor(isHeader ? colors.white : colors.ink)
          .text(pdfText(cell), x + padding, y + padding, {
            width: widths[index] - padding * 2,
            align: index === 0 ? "left" : "right",
          });
        x += widths[index];
      });
      doc.x = left;
      doc.y = y + height;
    };
    const teacherComment = (comment, nextTime = "") => {
      const feedback = pdfText(comment, "No teacher comment added yet.");
      const next = String(nextTime || "").trim();
      return next ? `${feedback} Next time: ${pdfText(next)}` : feedback;
    };

    titleBand();
    panel(
      "Learning objective",
      report.criterionWording,
      report.criterionWordingAvailable ? "blue" : "amber",
      "Learning objective not added yet.",
    );

    if (copyType === "student") {
      sectionHeading("Essay Builder");
      panel("Question", report.essay.question, "neutral", "Question unavailable");
      panel("Your answer - exactly as submitted", report.essay.finalEssayText, "blue", "Pending");
      panel(
        "Teacher comment",
        teacherComment(report.essay.teacherComment, report.essay.nextTime),
        "green",
      );

      const studentQuestionHeight = (question) => 25 +
        panelHeight(question.prompt, "Question unavailable") +
        panelHeight(question.studentAnswer, "Pending") +
        panelHeight(question.teacherComment, "No teacher comment added yet.");
      // WHY: Start the student Theory section on a page that can keep the
      // heading with at least one complete question and its feedback.
      ensureSpace(25 + studentQuestionHeight(report.theory.questions[0] || {}));
      sectionHeading("Theory");
      for (const question of report.theory.questions) {
        ensureSpace(studentQuestionHeight(question));
        sectionHeading(`Question ${question.questionIndex + 1}`);
        panel("Question", question.prompt, "neutral", "Question unavailable");
        panel("Your answer - exactly as submitted", question.studentAnswer, "blue", "Pending");
        panel("Teacher comment", question.teacherComment, "green", "No teacher comment added yet.");
      }
      finish();
      return;
    }

    sectionHeading("Results overview");
    metricPair([
      { label: report.q5.label, value: objectiveLine(report.q5) },
      { label: report.q8.label, value: objectiveLine(report.q8) },
    ]);

    sectionHeading("Essay evidence");
    panel("Question / teacher note", report.essay.question, "neutral", "Question unavailable");
    panel("Student essay - exactly as submitted", report.essay.finalEssayText, "blue", "Pending");
    metricPair([
      {
        label: "Original score",
        value: report.essay.status === "scored"
          ? `${report.essay.scoreCorrect}/${report.essay.scoreTotal} - ${formatPercent(report.essay.percent)}`
          : "Pending",
      },
      { label: "Evidence state", value: report.essay.status === "scored" ? "Scored" : "Pending" },
    ]);
    panel(
      "Teacher feedback",
      teacherComment(report.essay.teacherComment, report.essay.nextTime),
      "green",
      "No teacher feedback added yet.",
    );

    sectionHeading("Theory evidence");
    panel(
      "Theory result",
      report.theory.status === "scored"
        ? `${formatPercent(report.theory.percent)} - ${report.theory.passed ? "Passed" : "Not yet passed"}`
        : "Pending",
      report.theory.passed ? "green" : "amber",
    );
    for (const question of report.theory.questions) {
      // WHY: A teacher should review one question, answer, score, and comment
      // as a single evidence block rather than chase feedback onto a new page.
      ensureSpace(
        25 +
        panelHeight(question.prompt, "Question unavailable") +
        panelHeight(question.studentAnswer, "Pending") +
        71 +
        panelHeight(question.teacherComment, "No teacher comment added yet."),
      );
      sectionHeading(`Theory question ${question.questionIndex + 1}`);
      panel("Exact question asked", question.prompt, "neutral", "Question unavailable");
      panel("Student answer - exactly as submitted", question.studentAnswer, "blue", "Pending");
      metricPair([
        {
          label: "Original teacher score",
          value: question.originalTeacherScore === null
            ? "Pending"
            : `${question.originalTeacherScore}/100`,
        },
        { label: "Question", value: `${question.questionIndex + 1} of ${report.theory.questions.length}` },
      ]);
      panel("Teacher comment", question.teacherComment, "green", "No teacher comment added yet.");
    }

    ensureSpace(96);
    sectionHeading("Assessment evidence");
    metricPair([
      { label: report.assessmentA.label, value: objectiveLine(report.assessmentA) },
      {
        label: `${report.assessmentB.label} (optional)`,
        value: report.assessmentB.status === "not_created"
          ? "Not created"
          : objectiveLine(report.assessmentB),
      },
    ]);

    // WHY: Keep the complete weighted table and final status together so a
    // reader never has to interpret continuation rows without their headers.
    ensureSpace(430);
    sectionHeading(`${report.taskCode} score calculation`);
    const columnWidths = [contentWidth * 0.39, contentWidth * 0.19, contentWidth * 0.18, contentWidth * 0.24];
    tableRow(["Evidence", "Result", "Weight", "Contribution"], columnWidths, true);
    for (const row of report.calculation.rows) {
      tableRow([
        row.label,
        formatPercent(row.percent),
        `${row.weightPercent}%`,
        row.contribution === null ? "Pending" : row.contribution.toFixed(2),
      ], columnWidths);
    }
    panel(
      `Overall ${report.taskCode} score`,
      report.calculation.status === "pending"
        ? `Pending - current secured contribution: ${report.calculation.securedContribution.toFixed(2)} / 100`
        : formatPercent(report.calculation.overallPercent),
      report.calculation.status === "pending" ? "amber" : "blue",
    );

    sectionHeading(`Final ${report.taskCode} status`);
    panel(
      report.criterionStatus.passed ? "Passed" : "Not yet achieved",
      report.criterionStatus.reason,
      report.criterionStatus.passed ? "green" : "amber",
      "Status detail unavailable.",
    );
    finish();
  });
}

async function exportCriterionDraftReportPdf(args) {
  const report = await getCriterionDraftReport(args);
  const copyType = normalizeReportCopyType(args.copyType);
  console.info("[criterion-report] pdf_export", {
    teacherId: args.teacherId,
    studentId: args.studentId,
    subjectId: args.subjectId,
    taskCode: report.taskCode,
    copyType,
  });
  return {
    report,
    pdf: await buildCriterionReportPdf(report, { copyType }),
    fileName: `${report.student.name}-${report.taskCode}-${copyType}-copy.pdf`
      .replace(/[^a-z0-9.-]+/gi, "-")
      .replace(/-+/g, "-"),
  };
}

module.exports = {
  SCORING_COMPONENTS,
  buildCriterionReportPdf,
  calculateWeightedScore,
  essayEvidence,
  exportCriterionDraftReportPdf,
  getCriterionDraftReport,
  missionStage,
  normalizeReportCopyType,
  normalizeReportDraftPayload,
  objectiveEvidence,
  saveCriterionReportDraft,
  selectCurrentEvidenceMissions,
  theoryEvidence,
};
