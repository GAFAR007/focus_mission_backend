/**
 * WHAT:
 * criterion.controller exposes criterion progression endpoints for learning
 * access, learning completion, and learning-check block retrieval.
 * WHY:
 * The progression flow needs a dedicated boundary so learning enforcement is
 * not mixed into unrelated mission or timetable handlers.
 * HOW:
 * Delegate progression rules to criterionProgress.service and return stable
 * JSON payloads for students, teachers, and mentors.
 */
const criterionProgressService = require("../services/criterionProgress.service");

async function listCriteriaForStudent(req, res, next) {
  try {
    const result = await criterionProgressService.listCriteriaForStudent({
      requesterId: req.user.id,
      requesterRole: req.user.role,
      studentId: req.params.studentId,
    });

    res.json(result);
  } catch (error) {
    next(error);
  }
}

async function getCriterionDetail(req, res, next) {
  try {
    const result = await criterionProgressService.getCriterionDetail({
      requesterId: req.user.id,
      requesterRole: req.user.role,
      studentId: req.params.studentId,
      criterionId: req.params.criterionId,
    });

    res.json(result);
  } catch (error) {
    next(error);
  }
}

async function completeLearning(req, res, next) {
  try {
    const result = await criterionProgressService.completeLearning({
      requesterId: req.user.id,
      requesterRole: req.user.role,
      studentId: req.params.studentId,
      criterionId: req.params.criterionId,
    });

    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
}

async function getLearningCheckBlocks(req, res, next) {
  try {
    const result = await criterionProgressService.getLearningCheckBlocks({
      requesterId: req.user.id,
      requesterRole: req.user.role,
      studentId: req.params.studentId,
      criterionId: req.params.criterionId,
    });

    res.json(result);
  } catch (error) {
    next(error);
  }
}

async function submitLearningCheckAttempt(req, res, next) {
  try {
    const result = await criterionProgressService.submitLearningCheckAttempt({
      requesterId: req.user.id,
      requesterRole: req.user.role,
      studentId: req.params.studentId,
      criterionId: req.params.criterionId,
      answers: req.body.answers,
    });

    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
}

async function resetLearningCheck(req, res, next) {
  try {
    const result = await criterionProgressService.resetLearningCheck({
      requesterId: req.user.id,
      requesterRole: req.user.role,
      studentId: req.params.studentId,
      criterionId: req.params.criterionId,
    });

    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
}

async function getEssayBuilderBlocks(req, res, next) {
  try {
    const result = await criterionProgressService.getEssayBuilderBlocks({
      requesterId: req.user.id,
      requesterRole: req.user.role,
      studentId: req.params.studentId,
      criterionId: req.params.criterionId,
    });

    res.json(result);
  } catch (error) {
    next(error);
  }
}

async function appendEssayBuilderBlock(req, res, next) {
  try {
    const result = await criterionProgressService.appendEssayBuilderBlock({
      requesterId: req.user.id,
      requesterRole: req.user.role,
      studentId: req.params.studentId,
      criterionId: req.params.criterionId,
      blockId: req.body.blockId,
    });

    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
}

async function submitCriterion(req, res, next) {
  try {
    const result = await criterionProgressService.submitCriterion({
      requesterId: req.user.id,
      requesterRole: req.user.role,
      studentId: req.params.studentId,
      criterionId: req.params.criterionId,
    });

    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
}

async function reviewCriterion(req, res, next) {
  try {
    const result = await criterionProgressService.reviewCriterion({
      requesterId: req.user.id,
      requesterRole: req.user.role,
      studentId: req.params.studentId,
      criterionId: req.params.criterionId,
      action: req.body.action,
    });

    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
}

module.exports = {
  listCriteriaForStudent,
  getCriterionDetail,
  completeLearning,
  getLearningCheckBlocks,
  submitLearningCheckAttempt,
  resetLearningCheck,
  getEssayBuilderBlocks,
  appendEssayBuilderBlock,
  submitCriterion,
  reviewCriterion,
};
