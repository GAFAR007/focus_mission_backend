/**
 * WHAT:
 * student.controller exposes dashboard, timetable, and mission session
 * handlers for learners.
 * WHY:
 * Student-facing requests need a focused controller layer so mission and
 * timetable flows stay separate from progression and teacher authoring logic.
 * HOW:
 * Delegate to student.service and return the serialized dashboard, timetable,
 * start-session, and complete-session payloads.
 */
const studentService = require("../services/student.service");
const standalonePaperSessionService = require("../services/standalonePaperSession.service");

async function getDashboard(req, res, next) {
  try {
    const dashboard = await studentService.getDashboard(req.params.studentId);
    res.json(dashboard);
  } catch (error) {
    next(error);
  }
}

async function getTimetable(req, res, next) {
  try {
    const timetable = await studentService.getTimetable(req.params.studentId);
    res.json({ timetable });
  } catch (error) {
    next(error);
  }
}

async function getSubjectReport(req, res, next) {
  try {
    const report = await studentService.getSubjectReport({
      requesterId: req.user.id,
      studentId: req.params.studentId,
      subjectId: req.params.subjectId,
    });
    res.json(report);
  } catch (error) {
    next(error);
  }
}

async function getResultReport(req, res, next) {
  try {
    const resultPackage = await studentService.getStudentResultReport({
      requesterId: req.user.id,
      resultPackageId: req.params.resultPackageId,
    });
    res.json({ resultPackage });
  } catch (error) {
    next(error);
  }
}

async function listAssignedMissions(req, res, next) {
  try {
    const missions = await studentService.listAssignedMissions({
      requesterId: req.user.id,
      requesterRole: req.user.role,
      studentId: req.params.studentId,
      subjectId: req.query.subjectId,
      sessionType: req.query.sessionType,
    });
    res.json({ missions });
  } catch (error) {
    next(error);
  }
}

async function startSession(req, res, next) {
  try {
    const session = await studentService.startSession(req.body);
    res.status(201).json(session);
  } catch (error) {
    next(error);
  }
}

async function completeSession(req, res, next) {
  try {
    const result = await studentService.completeSession(req.body);
    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
}

async function listStandalonePapers(req, res, next) {
  try {
    const papers = await standalonePaperSessionService.listAvailableStandalonePapersForStudent({
      studentId: req.params.studentId,
      requesterId: req.user.id,
    });
    res.json({ papers });
  } catch (error) {
    next(error);
  }
}

async function startStandalonePaperSession(req, res, next) {
  try {
    const result = await standalonePaperSessionService.startStandalonePaperSession({
      studentId: req.body.studentId,
      requesterId: req.user.id,
      paperId: req.params.paperId,
    });
    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
}

async function getStandalonePaperSession(req, res, next) {
  try {
    const result = await standalonePaperSessionService.getStandalonePaperSessionForStudent({
      studentId: req.params.studentId,
      requesterId: req.user.id,
      sessionId: req.params.sessionId,
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
}

async function saveStandalonePaperSessionProgress(req, res, next) {
  try {
    const result = await standalonePaperSessionService.saveStandalonePaperSessionProgress({
      studentId: req.body.studentId,
      requesterId: req.user.id,
      sessionId: req.params.sessionId,
      payload: req.body,
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
}

async function recordStandalonePaperHeartbeat(req, res, next) {
  try {
    const result = await standalonePaperSessionService.recordStandalonePaperHeartbeat({
      studentId: req.body.studentId,
      requesterId: req.user.id,
      sessionId: req.params.sessionId,
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
}

async function recordStandalonePaperIntegrityEvent(req, res, next) {
  try {
    const result = await standalonePaperSessionService.recordStandalonePaperIntegrityEvent({
      studentId: req.body.studentId,
      requesterId: req.user.id,
      sessionId: req.params.sessionId,
      payload: req.body,
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
}

async function submitStandalonePaperSession(req, res, next) {
  try {
    const result = await standalonePaperSessionService.submitStandalonePaperSession({
      studentId: req.body.studentId,
      requesterId: req.user.id,
      sessionId: req.params.sessionId,
    });
    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getDashboard,
  getResultReport,
  getSubjectReport,
  getTimetable,
  listAssignedMissions,
  startSession,
  completeSession,
  listStandalonePapers,
  startStandalonePaperSession,
  getStandalonePaperSession,
  saveStandalonePaperSessionProgress,
  recordStandalonePaperHeartbeat,
  recordStandalonePaperIntegrityEvent,
  submitStandalonePaperSession,
};
