/**
 * WHAT:
 * criterionReport.service assembles one live teacher-facing Task Focus report,
 * persists comment overrides, calculates the five-part weighted score, and
 * exports the same report as selectable PDF text.
 * WHY:
 * Teachers need a current report without mutating immutable ResultPackage
 * evidence or accidentally reusing an older score when a redo is pending.
 * HOW:
 * Authorize the teacher/student/subject boundary, choose the newest mission in
 * each evidence stage, load only its linked result, calculate on the backend,
 * merge separate comment overrides, and render JSON or PDF from one payload.
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

function resolveCriterionWording(selected, taskCode, subjectName) {
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
  );

  const report = {
    student: { id: String(context.student._id), name: context.student.name },
    subject: { id: String(context.subject._id), name: context.subject.name },
    taskCode: normalizedTaskCode,
    title: `${context.student.name} — ${normalizedTaskCode} ${context.subject.name} Online Draft Report`,
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
  const essayTeacherComment = String(payload?.essayTeacherComment || "");
  const essayNextTime = String(payload?.essayNextTime || "");
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
  return {
    essayTeacherComment,
    essayNextTime,
    theoryQuestionComments: [...comments.values()].sort(
      (left, right) => left.questionIndex - right.questionIndex,
    ),
  };
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
  console.info("[criterion-report] comments_saved", {
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

function buildCriterionReportPdf(report) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margins: { top: 44, bottom: 44, left: 48, right: 48 } });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const heading = (value) => {
      doc.moveDown(0.7).font("Helvetica-Bold").fontSize(15).fillColor("#17365D").text(value);
      doc.moveDown(0.25).font("Helvetica").fontSize(10.5).fillColor("#222222");
    };
    const label = (value) => doc.font("Helvetica-Bold").text(value);
    const body = (value) => doc.font("Helvetica").text(String(value || "-") || "-");

    doc.font("Helvetica-Bold").fontSize(20).fillColor("#17365D").text(report.title);
    doc.moveDown(0.5).font("Helvetica").fontSize(10.5).fillColor("#222222");
    label("Criterion wording");
    body(report.criterionWording);

    heading("Objective learning evidence");
    label(report.q5.label);
    body(objectiveLine(report.q5));
    doc.moveDown(0.35);
    label(report.q8.label);
    body(objectiveLine(report.q8));

    heading("Essay Builder");
    label("Exact question / Teacher Note");
    body(report.essay.question);
    doc.moveDown(0.35);
    label("Student final Essay — exactly as submitted");
    body(report.essay.finalEssayText || "Pending");
    doc.moveDown(0.35);
    label("Original score");
    body(report.essay.status === "scored"
      ? `${report.essay.scoreCorrect}/${report.essay.scoreTotal} — ${formatPercent(report.essay.percent)}`
      : "Pending");
    label("Teacher Draft Comment");
    body(report.essay.teacherComment);
    label("Next time");
    body(report.essay.nextTime);

    heading("Theory");
    body(report.theory.status === "scored"
      ? `${formatPercent(report.theory.percent)} — ${report.theory.passed ? "Passed" : "Not yet passed"}`
      : "Pending");
    for (const question of report.theory.questions) {
      doc.moveDown(0.6);
      label(`Theory Question ${question.questionIndex + 1}`);
      label("Exact question asked");
      body(question.prompt);
      label("Student answer — exactly as submitted");
      body(question.studentAnswer);
      label("Original teacher score");
      body(question.originalTeacherScore === null
        ? "Pending"
        : `${question.originalTeacherScore}/100`);
      label("Teacher Draft Comment");
      body(question.teacherComment);
    }

    heading("Assessment evidence");
    label(report.assessmentA.label);
    body(objectiveLine(report.assessmentA));
    label(report.assessmentB.label);
    body(report.assessmentB.status === "not_created"
      ? "Optional — Not created"
      : `Optional — ${objectiveLine(report.assessmentB)}`);

    heading(`${report.taskCode} Overall Scoring Structure`);
    for (const row of report.scoringStructure) {
      body(`${row.label}: ${row.weightPercent}%`);
    }
    body("Total: 100%");

    heading(`${report.student.name} — ${report.taskCode} Calculation`);
    for (const row of report.calculation.rows) {
      body(`${row.label}: ${formatPercent(row.percent)} x ${row.weightPercent}% = ${row.contribution === null ? "Pending" : row.contribution.toFixed(2)}`);
    }
    label(`Overall ${report.taskCode} Score`);
    body(report.calculation.status === "pending"
      ? `Pending (current secured contribution: ${report.calculation.securedContribution.toFixed(2)} / 100)`
      : formatPercent(report.calculation.overallPercent));

    heading(`Final ${report.taskCode} Status`);
    body(`${report.student.name} — ${report.criterionStatus.passed ? "PASSED" : "Not yet achieved"}`);
    body(report.criterionStatus.reason);
    doc.end();
  });
}

async function exportCriterionDraftReportPdf(args) {
  const report = await getCriterionDraftReport(args);
  return {
    report,
    pdf: await buildCriterionReportPdf(report),
    fileName: `${report.student.name}-${report.taskCode}-draft-report.pdf`
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
  normalizeReportDraftPayload,
  objectiveEvidence,
  saveCriterionReportDraft,
  selectCurrentEvidenceMissions,
  theoryEvidence,
};
