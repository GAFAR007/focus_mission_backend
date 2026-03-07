/**
 * WHAT:
 * student.routes registers dashboard, timetable, and mission session routes
 * for learners and supporting staff.
 * WHY:
 * Student-facing operations need one clear protected route surface so lesson
 * access, mission starts, and completions stay consistent.
 * HOW:
 * Apply auth, validate route and body data, then delegate student workflow
 * logic to student.controller.
 */
const express = require("express");
const { body, param, query } = require("express-validator");

const studentController = require("../controllers/student.controller");
const {
  authorizeRoles,
  protect,
} = require("../middleware/auth.middleware");
const { validateRequest } = require("../middleware/validate.middleware");

const router = express.Router();

router.use(protect);

router.get(
  "/dashboard/:studentId",
  [
    authorizeRoles("student", "teacher", "mentor"),
    param("studentId").isMongoId().withMessage("Valid studentId is required."),
    validateRequest,
  ],
  studentController.getDashboard,
);

router.get(
  "/timetable/:studentId",
  [
    authorizeRoles("student", "teacher", "mentor"),
    param("studentId").isMongoId().withMessage("Valid studentId is required."),
    validateRequest,
  ],
  studentController.getTimetable,
);

router.get(
  "/missions/assigned/:studentId",
  [
    authorizeRoles("student", "teacher", "mentor"),
    param("studentId").isMongoId().withMessage("Valid studentId is required."),
    query("subjectId").isMongoId().withMessage("Valid subjectId is required."),
    query("sessionType")
      .isIn(["morning", "afternoon"])
      .withMessage("Session type must be morning or afternoon."),
    validateRequest,
  ],
  studentController.listAssignedMissions,
);

router.post(
  "/session/start",
  [
    authorizeRoles("student", "teacher"),
    body("studentId").isMongoId().withMessage("Valid studentId is required."),
    body("subjectId").isMongoId().withMessage("Valid subjectId is required."),
    body("sessionType")
      .isIn(["morning", "afternoon"])
      .withMessage("Session type must be morning or afternoon."),
    body("missionId")
      .optional()
      .isMongoId()
      .withMessage("missionId must be a valid mission id."),
    validateRequest,
  ],
  studentController.startSession,
);

router.post(
  "/session/complete",
  [
    authorizeRoles("student", "teacher"),
    body("studentId").isMongoId().withMessage("Valid studentId is required."),
    body("subjectId").isMongoId().withMessage("Valid subjectId is required."),
    body("sessionType")
      .isIn(["morning", "afternoon"])
      .withMessage("Session type must be morning or afternoon."),
    body("missionId")
      .optional()
      .isMongoId()
      .withMessage("missionId must be a valid mission id."),
    body("focusScore")
      .optional()
      .isInt({ min: 0, max: 100 })
      .withMessage("Focus score must be between 0 and 100."),
    body("correctAnswers")
      .optional()
      .isInt({ min: 0, max: 60 })
      .withMessage("correctAnswers must be between 0 and 60."),
    body("completedQuestions")
      .optional()
      .isInt({ min: 0, max: 60 })
      .withMessage("Completed questions must be between 0 and 60."),
    body("startTime")
      .optional()
      .isISO8601()
      .withMessage("startTime must be a valid ISO timestamp."),
    body("submitTime")
      .optional()
      .isISO8601()
      .withMessage("submitTime must be a valid ISO timestamp."),
    body("resultEvidence")
      .optional()
      .isObject()
      .withMessage("resultEvidence must be an object."),
    body("resultEvidence.questionResponses")
      .optional()
      .isArray({ max: 60 })
      .withMessage("questionResponses must include up to 60 entries."),
    body("resultEvidence.questionResponses.*.questionIndex")
      .optional()
      .isInt({ min: 0, max: 59 })
      .withMessage("questionIndex must be between 0 and 59."),
    body("resultEvidence.questionResponses.*.selectedIndex")
      .optional()
      .isInt({ min: 0, max: 3 })
      .withMessage("selectedIndex must be between 0 and 3."),
    body("resultEvidence.theoryResponses")
      .optional()
      .isArray({ max: 10 })
      .withMessage("theoryResponses must include up to 10 entries."),
    body("resultEvidence.theoryResponses.*.questionIndex")
      .optional()
      .isInt({ min: 0, max: 9 })
      .withMessage("theory questionIndex must be between 0 and 9."),
    body("resultEvidence.theoryResponses.*.answerText")
      .optional()
      .isString()
      .withMessage("theory answerText must be a string."),
    body("resultEvidence.theoryResponses.*.wordCount")
      .optional()
      .isInt({ min: 0, max: 5000 })
      .withMessage("theory wordCount must be between 0 and 5000."),
    body("resultEvidence.essayBuilder")
      .optional()
      .isObject()
      .withMessage("essayBuilder evidence must be an object."),
    body("resultEvidence.essayBuilder.sentenceResponses")
      .optional()
      .isArray({ max: 60 })
      .withMessage("sentenceResponses must include up to 60 entries."),
    body("resultEvidence.essayBuilder.sentenceResponses.*.sentenceId")
      .optional()
      .isString()
      .withMessage("sentenceId must be a string."),
    body("resultEvidence.essayBuilder.sentenceResponses.*.blankSelections")
      .optional()
      .isArray({ max: 40 })
      .withMessage("blankSelections must include up to 40 entries."),
    body(
      "resultEvidence.essayBuilder.sentenceResponses.*.blankSelections.*.blankId",
    )
      .optional()
      .isString()
      .withMessage("blankId must be a string."),
    body(
      "resultEvidence.essayBuilder.sentenceResponses.*.blankSelections.*.selectedOption",
    )
      .optional()
      .isIn(["A", "B", "C", "D"])
      .withMessage("selectedOption must be A, B, C, or D."),
    validateRequest,
  ],
  studentController.completeSession,
);

module.exports = router;
