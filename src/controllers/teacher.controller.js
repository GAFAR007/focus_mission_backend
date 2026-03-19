/**
 * WHAT:
 * teacher.controller exposes teacher routes for timetable actions, mission
 * authoring, criterion draft approval, and SessionLog analytics.
 * WHY:
 * Stage 7 needs explicit request handlers so AI-generated criterion drafts stay
 * behind teacher-only routes and review-before-save boundaries while dashboards
 * can read chart-ready outcomes from deterministic session logs.
 * HOW:
 * Delegate request payloads to teacher.service and return stable JSON
 * responses for the frontend, plus aggregate SessionLog metrics directly for
 * teacher analytics views.
 */
const mongoose = require("mongoose");
const SessionLog = require("../models/SessionLog");
const resultService = require("../services/result.service");
const subjectCertificationService = require("../services/subjectCertification.service");
const teacherService = require("../services/teacher.service");

const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function createError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function buildAnalyticsMatch(req) {
  const studentId = String(req.params.id || "").trim();
  if (!mongoose.Types.ObjectId.isValid(studentId)) {
    throw createError(400, "Valid student id is required.");
  }

  const from = String(req.query.from || "").trim();
  const to = String(req.query.to || "").trim();

  if (from && !DATE_KEY_PATTERN.test(from)) {
    throw createError(400, "from must use YYYY-MM-DD format.");
  }

  if (to && !DATE_KEY_PATTERN.test(to)) {
    throw createError(400, "to must use YYYY-MM-DD format.");
  }

  if (from && to && from > to) {
    throw createError(400, "from cannot be later than to.");
  }

  const match = {
    studentId: new mongoose.Types.ObjectId(studentId),
  };

  if (from || to) {
    // WHY: dateKey is persisted in YYYY-MM-DD format, so lexical range filters
    // stay deterministic without re-reading all historical session logs.
    match.dateKey = {};
    if (from) {
      match.dateKey.$gte = from;
    }
    if (to) {
      match.dateKey.$lte = to;
    }
  }

  return match;
}

async function getStudents(req, res, next) {
  try {
    const students = await teacherService.listStudents(req.user.id);
    res.json({ students });
  } catch (error) {
    next(error);
  }
}

async function createStudent(req, res, next) {
  try {
    const user = await teacherService.createStudent({
      teacherId: req.user.id,
      payload: req.body,
    });
    res.status(201).json({ user });
  } catch (error) {
    next(error);
  }
}

async function getSubjects(req, res, next) {
  try {
    const subjects = await teacherService.listSubjects(req.user.id);
    res.json({ subjects });
  } catch (error) {
    next(error);
  }
}

async function getStudentResults(req, res, next) {
  try {
    const missions = await teacherService.listStudentResults({
      teacherId: req.user.id,
      studentId: req.params.id,
    });
    res.json({ missions });
  } catch (error) {
    next(error);
  }
}

async function createTimetable(req, res, next) {
  try {
    const timetable = await teacherService.createTimetable(req.body);
    res.status(201).json({ timetable });
  } catch (error) {
    next(error);
  }
}

async function updateTimetableSlot(req, res, next) {
  try {
    const timetable = await teacherService.updateTimetableSlot({
      teacherId: req.user.id,
      studentId: req.params.id,
      payload: req.body,
    });
    res.json({ timetable });
  } catch (error) {
    next(error);
  }
}

async function createSessionLog(req, res, next) {
  try {
    const result = await teacherService.createSessionLog({
      ...req.body,
      createdBy: req.user.id,
    });
    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
}

async function generateLearningAndBlocksDraft(req, res, next) {
  try {
    const draft = await teacherService.generateLearningAndBlocksDraft(
      req.user.id,
      req.body,
    );
    res.json({ draft });
  } catch (error) {
    next(error);
  }
}

async function extractSourcePlan(req, res, next) {
  try {
    const draft = await teacherService.extractSourcePlan(req.user.id, {
      ...req.body,
      file: req.file,
    });
    res.json({ draft });
  } catch (error) {
    next(error);
  }
}

async function extractCriterionSourcePlan(req, res, next) {
  try {
    const draft = await teacherService.extractCriterionSourcePlan(req.user.id, {
      ...req.body,
      file: req.file,
    });
    res.json({ draft });
  } catch (error) {
    next(error);
  }
}

async function approveLearningAndBlocks(req, res, next) {
  try {
    const draft = await teacherService.approveLearningAndBlocks(
      req.user.id,
      req.body,
    );
    res.status(201).json({ draft });
  } catch (error) {
    next(error);
  }
}

async function generateMission(req, res, next) {
  try {
    const mission = await teacherService.generateMission(req.user.id, req.body);
    res.status(201).json({ mission });
  } catch (error) {
    next(error);
  }
}

async function previewMission(req, res, next) {
  try {
    const mission = await teacherService.previewMission(req.user.id, req.body);
    res.json({ mission });
  } catch (error) {
    next(error);
  }
}

async function getRecentMissions(req, res, next) {
  try {
    const missions = await teacherService.listRecentMissions(
      req.user.id,
      req.params.studentId,
    );
    res.json({ missions });
  } catch (error) {
    next(error);
  }
}

async function getDraftMissions(req, res, next) {
  try {
    const missions = await teacherService.listDraftMissions(
      req.user.id,
      req.params.studentId,
    );
    res.json({ missions });
  } catch (error) {
    next(error);
  }
}

async function updateMission(req, res, next) {
  try {
    const mission = await teacherService.updateMission(
      req.user.id,
      req.params.missionId,
      req.body,
    );
    res.json({ mission });
  } catch (error) {
    next(error);
  }
}

async function deleteMission(req, res, next) {
  try {
    const deleted = await teacherService.deleteMission(
      req.user.id,
      req.params.missionId,
    );
    res.json({
      success: true,
      missionId: deleted.missionId,
    });
  } catch (error) {
    next(error);
  }
}

async function reextractMissionSource(req, res, next) {
  try {
    const mission = await teacherService.reextractMissionSource(
      req.user.id,
      req.params.missionId,
    );
    res.json({ mission });
  } catch (error) {
    next(error);
  }
}

async function getStudentDailyTrend(req, res, next) {
  try {
    const match = buildAnalyticsMatch(req);
    const trend = await SessionLog.aggregate([
      { $match: match },
      {
        $group: {
          _id: "$dateKey",
          totalXp: { $sum: { $ifNull: ["$totalXpAwarded", 0] } },
          performanceXp: { $sum: { $ifNull: ["$performanceXpAwarded", 0] } },
          targetXp: { $sum: { $ifNull: ["$targetXpAwarded", 0] } },
        },
      },
      { $sort: { _id: 1 } },
      {
        $project: {
          _id: 0,
          date: "$_id",
          totalXp: 1,
          performanceXp: 1,
          targetXp: 1,
        },
      },
    ]);

    res.json(
      trend.map((point) => ({
        date: String(point.date || ""),
        totalXp: Math.round(Number(point.totalXp || 0)),
        performanceXp: Math.round(Number(point.performanceXp || 0)),
        targetXp: Math.round(Number(point.targetXp || 0)),
      })),
    );
  } catch (error) {
    next(error);
  }
}

async function getStudentSessionBreakdown(req, res, next) {
  try {
    const match = buildAnalyticsMatch(req);
    const breakdown = await SessionLog.aggregate([
      { $match: match },
      {
        $group: {
          _id: "$sessionType",
          totalXp: { $sum: { $ifNull: ["$totalXpAwarded", 0] } },
          avgScore: { $avg: { $ifNull: ["$scorePercent", 0] } },
          avgFocus: { $avg: { $ifNull: ["$focusScore", 0] } },
          sessions: { $sum: 1 },
        },
      },
      {
        $addFields: {
          sortOrder: {
            $cond: [{ $eq: ["$_id", "morning"] }, 0, 1],
          },
        },
      },
      { $sort: { sortOrder: 1 } },
      {
        $project: {
          _id: 0,
          sessionType: "$_id",
          totalXp: 1,
          avgScore: 1,
          avgFocus: 1,
          sessions: 1,
        },
      },
    ]);

    res.json(
      breakdown.map((item) => ({
        sessionType: String(item.sessionType || ""),
        totalXp: Math.round(Number(item.totalXp || 0)),
        avgScore: Math.round(Number(item.avgScore || 0)),
        avgFocus: Math.round(Number(item.avgFocus || 0)),
        sessions: Math.round(Number(item.sessions || 0)),
      })),
    );
  } catch (error) {
    next(error);
  }
}

async function getStudentSubjectAnalytics(req, res, next) {
  try {
    const match = buildAnalyticsMatch(req);
    const analytics = await SessionLog.aggregate([
      { $match: match },
      {
        $group: {
          _id: "$subjectId",
          totalXp: { $sum: { $ifNull: ["$totalXpAwarded", 0] } },
          avgScore: { $avg: { $ifNull: ["$scorePercent", 0] } },
          sessions: { $sum: 1 },
        },
      },
      { $sort: { sessions: -1, totalXp: -1 } },
      {
        $project: {
          _id: 0,
          subjectId: { $toString: "$_id" },
          totalXp: 1,
          avgScore: 1,
          sessions: 1,
        },
      },
    ]);

    res.json(
      analytics.map((item) => ({
        subjectId: String(item.subjectId || ""),
        totalXp: Math.round(Number(item.totalXp || 0)),
        avgScore: Math.round(Number(item.avgScore || 0)),
        sessions: Math.round(Number(item.sessions || 0)),
      })),
    );
  } catch (error) {
    next(error);
  }
}

async function getStudentCertification(
  req,
  res,
  next,
) {
  try {
    const certifications =
      await subjectCertificationService.getStudentCertificationSummaries(
        {
          studentId: req.params.id,
          applyAwards: true,
        },
      );
    res.json({ certifications });
  } catch (error) {
    next(error);
  }
}

async function updateStudentCertificationPlan(req, res, next) {
  try {
    const certification =
      await subjectCertificationService.updateTeacherStudentCertificationPlan({
        teacherId: req.user.id,
        studentId: req.params.id,
        subjectId: req.params.subjectId,
        payload: req.body,
      });
    res.json({ certification });
  } catch (error) {
    next(error);
  }
}

async function getStudentBehaviourTrend(req, res, next) {
  try {
    const match = buildAnalyticsMatch(req);
    const behaviourTrend = await SessionLog.aggregate([
      { $match: match },
      {
        $group: {
          _id: { $ifNull: ["$behaviourStatus", "steady"] },
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1, _id: 1 } },
      {
        $project: {
          _id: 0,
          behaviourStatus: "$_id",
          count: 1,
        },
      },
    ]);

    res.json(
      behaviourTrend.map((item) => ({
        behaviourStatus: String(item.behaviourStatus || ""),
        count: Math.round(Number(item.count || 0)),
      })),
    );
  } catch (error) {
    next(error);
  }
}

async function getResultPackage(req, res, next) {
  try {
    const resultPackage =
      await resultService.getResultPackageForTeacher({
        teacherId: req.user.id,
        resultPackageId: req.params.resultPackageId,
      });
    res.json({ resultPackage });
  } catch (error) {
    next(error);
  }
}

async function createManualResultPackage(req, res, next) {
  try {
    const created =
      await resultService.createManualResultPackageFromUpload({
        teacherId: req.user.id,
        missionId: req.params.missionId,
        file: req.file,
      });
    res.status(201).json(created);
  } catch (error) {
    next(error);
  }
}

async function scoreTheoryResultPackage(req, res, next) {
  try {
    const scored = await resultService.scoreTheoryResultPackage({
      teacherId: req.user.id,
      resultPackageId: req.params.resultPackageId,
      questions: req.body.questions,
    });
    res.status(200).json(scored);
  } catch (error) {
    next(error);
  }
}

async function scoreManualResultPackage(req, res, next) {
  try {
    const scored = await resultService.scoreManualResultPackage({
      teacherId: req.user.id,
      resultPackageId: req.params.resultPackageId,
      scoreCorrect: req.body.scoreCorrect,
      scoreTotal: req.body.scoreTotal,
      teacherFeedback: req.body.teacherFeedback,
    });
    res.status(200).json(scored);
  } catch (error) {
    next(error);
  }
}

async function sendResultPackage(req, res, next) {
  try {
    const sent = await resultService.sendResultPackage({
      teacherId: req.user.id,
      resultPackageId: req.params.resultPackageId,
      recipients: req.body.recipients,
      channels: req.body.channels,
      screenshotUrl: req.body.screenshotUrl,
    });
    res.status(201).json(sent);
  } catch (error) {
    next(error);
  }
}

async function uploadResultScreenshot(req, res, next) {
  try {
    const uploaded =
      await resultService.uploadResultScreenshot({
        teacherId: req.user.id,
        resultPackageId: req.params.resultPackageId,
        file: req.file,
      });
    res.status(201).json(uploaded);
  } catch (error) {
    next(error);
  }
}

async function getResultScreenshot(req, res, next) {
  try {
    const screenshot =
      await resultService.getResultScreenshotForTeacher({
        teacherId: req.user.id,
        screenshotId: req.params.screenshotId,
      });

    const screenshotData = Buffer.isBuffer(screenshot.data)
      ? screenshot.data
      : Buffer.from(
          screenshot?.data?.data || screenshot?.data?.buffer || [],
        );
    res.setHeader("Content-Type", screenshot.mimeType || "image/png");
    res.setHeader("Content-Length", String(screenshotData.length));
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${screenshot.fileName || `${screenshot._id}.png`}"`,
    );
    res.send(screenshotData);
  } catch (error) {
    next(error);
  }
}

module.exports = {
  createStudent,
  getStudents,
  getSubjects,
  getStudentResults,
  getStudentCertification,
  updateStudentCertificationPlan,
  createTimetable,
  updateTimetableSlot,
  createSessionLog,
  generateLearningAndBlocksDraft,
  approveLearningAndBlocks,
  extractSourcePlan,
  extractCriterionSourcePlan,
  generateMission,
  previewMission,
  getDraftMissions,
  getRecentMissions,
  updateMission,
  deleteMission,
  reextractMissionSource,
  getStudentDailyTrend,
  getStudentSessionBreakdown,
  getStudentSubjectAnalytics,
  getStudentBehaviourTrend,
  getResultPackage,
  createManualResultPackage,
  scoreTheoryResultPackage,
  scoreManualResultPackage,
  sendResultPackage,
  uploadResultScreenshot,
  getResultScreenshot,
};
