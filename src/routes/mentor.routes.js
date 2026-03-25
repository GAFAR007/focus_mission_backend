/**
 * WHAT:
 * mentor.routes registers mentor-only overview, target, and difficulty
 * endpoints.
 * WHY:
 * Mentor support actions need their own protected route surface so they do not
 * overlap with teacher review or student mission actions.
 * HOW:
 * Protect all mentor routes, validate ids and payloads, then delegate to
 * mentor.controller.
 */
const express = require("express");
const { body, param, query } = require("express-validator");

const mentorController = require("../controllers/mentor.controller");
const {
  authorizeRoles,
  protect,
} = require("../middleware/auth.middleware");
const { validateRequest } = require("../middleware/validate.middleware");

const router = express.Router();

router.use(protect, authorizeRoles("mentor", "teacher"));

router.get(
  "/overview/:studentId",
  [
    param("studentId").isMongoId().withMessage("Valid studentId is required."),
    validateRequest,
  ],
  mentorController.getOverview,
);

router.get(
  "/covered-sessions/:studentId",
  authorizeRoles("mentor"),
  [
    param("studentId").isMongoId().withMessage("Valid studentId is required."),
    query("date")
      .optional()
      .matches(/^\d{4}-\d{2}-\d{2}$/)
      .withMessage("date must be a valid YYYY-MM-DD date."),
    validateRequest,
  ],
  mentorController.getCoveredSessions,
);

router.post(
  "/covered-session-log",
  authorizeRoles("mentor"),
  [
    body("studentId").isMongoId().withMessage("Valid studentId is required."),
    body("dateKey")
      .matches(/^\d{4}-\d{2}-\d{2}$/)
      .withMessage("dateKey must be a valid YYYY-MM-DD date."),
    body("sessionType")
      .isIn(["morning", "afternoon"])
      .withMessage("sessionType must be morning or afternoon."),
    body("focusScore")
      .optional()
      .isInt({ min: 0, max: 100 })
      .withMessage("focusScore must be between 0 and 100."),
    body("completedQuestions")
      .optional()
      .isInt({ min: 0 })
      .withMessage("completedQuestions must be 0 or greater."),
    body("behaviourStatus")
      .optional()
      .isIn(["great", "steady", "warning", "penalty"])
      .withMessage("behaviourStatus must be great, steady, warning, or penalty."),
    body("notes")
      .optional()
      .isString()
      .withMessage("notes must be text."),
    body("xpAwarded")
      .optional()
      .isInt({ min: 0, max: 50 })
      .withMessage("xpAwarded must be between 0 and 50."),
    validateRequest,
  ],
  mentorController.createCoveredSessionLog,
);

router.post(
  "/targets",
  [
    body("studentId").isMongoId().withMessage("Valid studentId is required."),
    body("title").notEmpty().withMessage("Title is required."),
    body("targetType")
      .optional()
      .isIn(["fixed_daily_mission", "fixed_assessment", "custom"])
      .withMessage("targetType must be fixed_daily_mission, fixed_assessment, or custom."),
    body("stars")
      .optional()
      .isInt({ min: 0, max: 3 })
      .withMessage("stars must be between 0 and 3."),
    body("awardDateKey")
      .optional()
      .isISO8601({ strict: true, strictSeparator: true })
      .withMessage("awardDateKey must be a valid YYYY-MM-DD date."),
    validateRequest,
  ],
  mentorController.createTarget,
);

router.patch(
  "/targets/:targetId",
  [
    param("targetId").isMongoId().withMessage("Valid targetId is required."),
    body("stars")
      .optional()
      .isInt({ min: 0, max: 3 })
      .withMessage("stars must be between 0 and 3."),
    body("targetType")
      .optional()
      .isIn(["fixed_daily_mission", "fixed_assessment", "custom"])
      .withMessage("targetType must be fixed_daily_mission, fixed_assessment, or custom."),
    body("awardDateKey")
      .optional()
      .isISO8601({ strict: true, strictSeparator: true })
      .withMessage("awardDateKey must be a valid YYYY-MM-DD date."),
    validateRequest,
  ],
  mentorController.updateTarget,
);

router.patch(
  "/difficulty/:studentId",
  [
    param("studentId").isMongoId().withMessage("Valid studentId is required."),
    body("preferredDifficulty")
      .isIn(["easy", "medium", "hard"])
      .withMessage("preferredDifficulty must be easy, medium, or hard."),
    validateRequest,
  ],
  mentorController.updateDifficulty,
);

module.exports = router;
