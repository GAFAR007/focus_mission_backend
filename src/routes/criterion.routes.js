/**
 * WHAT:
 * criterion.routes exposes the first criterion progression endpoints.
 * WHY:
 * Phase 2 requires learning enforcement routes so students can read approved
 * learning content before any knowledge-check blocks become available.
 * HOW:
 * Protect the routes, validate student and criterion ids, and delegate the
 * actual progression logic to criterion.controller.
 */
const express = require("express");
const { body, param } = require("express-validator");

const criterionController = require("../controllers/criterion.controller");
const {
  authorizeRoles,
  protect,
} = require("../middleware/auth.middleware");
const { validateRequest } = require("../middleware/validate.middleware");

const router = express.Router();

router.use(protect);

router.get(
  "/student/:studentId",
  [
    authorizeRoles("student", "teacher", "mentor"),
    param("studentId").isMongoId().withMessage("Valid studentId is required."),
    validateRequest,
  ],
  criterionController.listCriteriaForStudent,
);

router.get(
  "/student/:studentId/:criterionId",
  [
    authorizeRoles("student", "teacher", "mentor"),
    param("studentId").isMongoId().withMessage("Valid studentId is required."),
    param("criterionId")
      .isMongoId()
      .withMessage("Valid criterionId is required."),
    validateRequest,
  ],
  criterionController.getCriterionDetail,
);

router.post(
  "/student/:studentId/:criterionId/learning/complete",
  [
    authorizeRoles("student"),
    param("studentId").isMongoId().withMessage("Valid studentId is required."),
    param("criterionId")
      .isMongoId()
      .withMessage("Valid criterionId is required."),
    validateRequest,
  ],
  criterionController.completeLearning,
);

router.get(
  "/student/:studentId/:criterionId/blocks/learning-check",
  [
    authorizeRoles("student", "teacher", "mentor"),
    param("studentId").isMongoId().withMessage("Valid studentId is required."),
    param("criterionId")
      .isMongoId()
      .withMessage("Valid criterionId is required."),
    validateRequest,
  ],
  criterionController.getLearningCheckBlocks,
);

router.post(
  "/student/:studentId/:criterionId/blocks/learning-check/submit",
  [
    authorizeRoles("student"),
    param("studentId").isMongoId().withMessage("Valid studentId is required."),
    param("criterionId")
      .isMongoId()
      .withMessage("Valid criterionId is required."),
    body("answers")
      .isArray({ min: 1 })
      .withMessage("answers must include at least one learning-check answer."),
    body("answers.*.blockId")
      .isMongoId()
      .withMessage("Each learning-check answer needs a valid blockId."),
    body("answers.*.selectedIndex")
      .isInt({ min: 0, max: 3 })
      .withMessage("Each learning-check answer needs a selectedIndex between 0 and 3."),
    validateRequest,
  ],
  criterionController.submitLearningCheckAttempt,
);

router.post(
  "/student/:studentId/:criterionId/blocks/learning-check/reset",
  [
    authorizeRoles("teacher"),
    param("studentId").isMongoId().withMessage("Valid studentId is required."),
    param("criterionId")
      .isMongoId()
      .withMessage("Valid criterionId is required."),
    validateRequest,
  ],
  criterionController.resetLearningCheck,
);

router.get(
  "/student/:studentId/:criterionId/blocks/essay-builder",
  [
    authorizeRoles("student", "teacher", "mentor"),
    param("studentId").isMongoId().withMessage("Valid studentId is required."),
    param("criterionId")
      .isMongoId()
      .withMessage("Valid criterionId is required."),
    validateRequest,
  ],
  criterionController.getEssayBuilderBlocks,
);

router.post(
  "/student/:studentId/:criterionId/blocks/essay-builder/append",
  [
    authorizeRoles("student"),
    param("studentId").isMongoId().withMessage("Valid studentId is required."),
    param("criterionId")
      .isMongoId()
      .withMessage("Valid criterionId is required."),
    body("blockId").isMongoId().withMessage("Valid blockId is required."),
    validateRequest,
  ],
  criterionController.appendEssayBuilderBlock,
);

router.post(
  "/student/:studentId/:criterionId/submit",
  [
    authorizeRoles("student"),
    param("studentId").isMongoId().withMessage("Valid studentId is required."),
    param("criterionId")
      .isMongoId()
      .withMessage("Valid criterionId is required."),
    validateRequest,
  ],
  criterionController.submitCriterion,
);

router.post(
  "/student/:studentId/:criterionId/review",
  [
    authorizeRoles("teacher"),
    param("studentId").isMongoId().withMessage("Valid studentId is required."),
    param("criterionId")
      .isMongoId()
      .withMessage("Valid criterionId is required."),
    body("action")
      .isIn(["approve", "request_revision"])
      .withMessage("Review action must be approve or request_revision."),
    validateRequest,
  ],
  criterionController.reviewCriterion,
);

module.exports = router;
