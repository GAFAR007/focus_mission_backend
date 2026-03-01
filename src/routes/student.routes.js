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
      .isInt({ min: 0, max: 10 })
      .withMessage("correctAnswers must be between 0 and 10."),
    body("completedQuestions")
      .optional()
      .isInt({ min: 0, max: 10 })
      .withMessage("Completed questions must be between 0 and 10."),
    validateRequest,
  ],
  studentController.completeSession,
);

module.exports = router;
