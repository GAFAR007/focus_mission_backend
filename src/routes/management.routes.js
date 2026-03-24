/**
 * WHAT:
 * management.routes registers management-only setup, archive recovery, and
 * reporting endpoints.
 * WHY:
 * Management needs result visibility, student setup tools, and timetable
 * editing without inheriting teacher publishing or send-result permissions.
 * HOW:
 * Protect all routes, require the original management role, validate ids, then
 * delegate to management.controller.
 */
const express = require("express");
const {
  body,
  param,
  query,
} = require("express-validator");

const managementController = require("../controllers/management.controller");
const {
  authorizeSourceRoles,
  protect,
} = require("../middleware/auth.middleware");
const {
  validateRequest,
} = require("../middleware/validate.middleware");

const router = express.Router();

router.use(
  protect,
  authorizeSourceRoles("management"),
);

router.post(
  "/users",
  [
    body("name")
      .notEmpty()
      .withMessage(
        "Name is required.",
      ),
    body("email")
      .isEmail()
      .withMessage(
        "Valid email is required.",
      ),
    body("password")
      .isLength({ min: 8 })
      .withMessage(
        "Password must be at least 8 characters.",
      ),
    body("role")
      .isIn(["student", "teacher"])
      .withMessage(
        "Role must be student or teacher.",
      ),
    body("subjectSpecialty")
      .optional()
      .isString()
      .withMessage(
        "subjectSpecialty must be text.",
      ),
    body("yearGroup")
      .optional()
      .isString()
      .withMessage(
        "yearGroup must be text.",
      ),
    validateRequest,
  ],
  managementController.createUser,
);

router.get(
  "/students",
  managementController.getStudents,
);

router.patch(
  "/students/:studentId/archive",
  [
    param("studentId")
      .isMongoId()
      .withMessage(
        "Valid studentId is required.",
      ),
    validateRequest,
  ],
  managementController.archiveStudent,
);

router.patch(
  "/students/:studentId/year-group",
  [
    param("studentId")
      .isMongoId()
      .withMessage(
        "Valid studentId is required.",
      ),
    body("yearGroup")
      .optional()
      .isString()
      .withMessage(
        "yearGroup must be text.",
      ),
    validateRequest,
  ],
  managementController.updateStudentYearGroup,
);

router.patch(
  "/students/:studentId/unarchive",
  [
    param("studentId")
      .isMongoId()
      .withMessage(
        "Valid studentId is required.",
      ),
    validateRequest,
  ],
  managementController.unarchiveStudent,
);

router.get(
  "/subjects",
  managementController.listSubjects,
);

router.get(
  "/teachers",
  managementController.listTeachers,
);

router.get(
  "/subjects/:subjectId/certification",
  [
    param("subjectId")
      .isMongoId()
      .withMessage(
        "Valid subjectId is required.",
      ),
    validateRequest,
  ],
  managementController.getSubjectCertificationSettings,
);

router.patch(
  "/subjects/:subjectId/certification",
  [
    param("subjectId")
      .isMongoId()
      .withMessage(
        "Valid subjectId is required.",
      ),
    body("certificationEnabled")
      .isBoolean()
      .withMessage(
        "certificationEnabled must be true or false.",
      ),
    body("requiredCertificationTaskCodes")
      .optional()
      .isArray()
      .withMessage(
        "requiredCertificationTaskCodes must be an array.",
      ),
    body("requiredCertificationTaskCodes.*")
      .optional()
      .isString()
      .matches(/^[PMD]\d+$/i)
      .withMessage(
        "Certification task codes must look like P1, P2, M1, or D1.",
      ),
    body("certificationLabel")
      .optional()
      .isString()
      .withMessage(
        "certificationLabel must be text.",
      ),
    validateRequest,
  ],
  managementController.updateSubjectCertificationSettings,
);

router.get(
  "/students/:studentId/certification",
  [
    param("studentId")
      .isMongoId()
      .withMessage(
        "Valid studentId is required.",
      ),
    validateRequest,
  ],
  managementController.getStudentCertification,
);

router.get(
  "/students/:studentId/day-plan",
  [
    param("studentId")
      .isMongoId()
      .withMessage(
        "Valid studentId is required.",
      ),
    query("date")
      .optional()
      .matches(/^\d{4}-\d{2}-\d{2}$/)
      .withMessage(
        "date must be in YYYY-MM-DD format.",
      ),
    validateRequest,
  ],
  managementController.getStudentDayPlan,
);

router.get(
  "/students/:studentId/results",
  [
    param("studentId")
      .isMongoId()
      .withMessage(
        "Valid studentId is required.",
      ),
    validateRequest,
  ],
  managementController.getStudentResults,
);

router.get(
  "/students/:studentId/targets",
  [
    param("studentId")
      .isMongoId()
      .withMessage(
        "Valid studentId is required.",
      ),
    query("date")
      .optional()
      .matches(/^\d{4}-\d{2}-\d{2}$/)
      .withMessage(
        "date must be in YYYY-MM-DD format.",
      ),
    validateRequest,
  ],
  managementController.getStudentTargets,
);

router.put(
  "/students/:studentId/timetable",
  [
    param("studentId")
      .isMongoId()
      .withMessage(
        "Valid studentId is required.",
      ),
    body("day")
      .isString()
      .trim()
      .isIn([
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
      ])
      .withMessage(
        "day must be Monday to Friday.",
      ),
    body("room")
      .isString()
      .trim()
      .notEmpty()
      .withMessage(
        "room is required.",
      ),
    body("morningSubjectId")
      .isMongoId()
      .withMessage(
        "Valid morningSubjectId is required.",
      ),
    body("afternoonSubjectId")
      .isMongoId()
      .withMessage(
        "Valid afternoonSubjectId is required.",
      ),
    body("morningTeacherId")
      .optional({ nullable: true, checkFalsy: true })
      .isMongoId()
      .withMessage(
        "morningTeacherId must be a valid teacher id.",
      ),
    body("afternoonTeacherId")
      .optional({ nullable: true, checkFalsy: true })
      .isMongoId()
      .withMessage(
        "afternoonTeacherId must be a valid teacher id.",
      ),
    validateRequest,
  ],
  managementController.saveStudentTimetableEntry,
);

router.get(
  "/results/:resultPackageId",
  [
    param("resultPackageId")
      .isMongoId()
      .withMessage(
        "Valid resultPackageId is required.",
      ),
    validateRequest,
  ],
  managementController.getResultPackage,
);

module.exports = router;
