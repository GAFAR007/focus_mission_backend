/**
 * WHAT:
 * mentor.controller exposes mentor overview, target, and difficulty handlers.
 * WHY:
 * Mentors need a dedicated boundary for student support actions without mixing
 * their workflow into teacher review or student mission controllers.
 * HOW:
 * Delegate mentor requests to mentor.service and return stable JSON payloads
 * for overview, target creation, target updates, and difficulty changes.
 */
const mentorService = require("../services/mentor.service");

async function getOverview(req, res, next) {
  try {
    const overview = await mentorService.getOverview(req.params.studentId, {
      dateKey: req.query.date,
    });
    res.json(overview);
  } catch (error) {
    next(error);
  }
}

async function getCoveredSessions(req, res, next) {
  try {
    const coveredSessions = await mentorService.listCoveredSessions({
      mentorId: req.user.id,
      studentId: req.params.studentId,
      dateKey: req.query.date,
    });
    res.json(coveredSessions);
  } catch (error) {
    next(error);
  }
}

async function createCoveredSessionLog(req, res, next) {
  try {
    const session = await mentorService.createCoveredSessionLog({
      mentorId: req.user.id,
      payload: req.body,
    });
    res.status(201).json(session);
  } catch (error) {
    next(error);
  }
}

async function createTarget(req, res, next) {
  try {
    const target = await mentorService.createTarget(req.body, req.user);
    res.status(201).json({ target });
  } catch (error) {
    next(error);
  }
}

async function updateTarget(req, res, next) {
  try {
    const target = await mentorService.updateTarget(
      req.params.targetId,
      req.body,
      req.user,
    );
    res.json({ target });
  } catch (error) {
    next(error);
  }
}

async function updateDifficulty(req, res, next) {
  try {
    const student = await mentorService.updateDifficulty(
      req.params.studentId,
      req.body,
    );
    res.json({ student });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getCoveredSessions,
  getOverview,
  createCoveredSessionLog,
  createTarget,
  updateTarget,
  updateDifficulty,
};
