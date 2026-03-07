/**
 * WHAT:
 * management.routes registers management-only reporting endpoints.
 * WHY:
 * Management needs result visibility for assigned students without inheriting
 * teacher publishing or send-result permissions.
 * HOW:
 * Protect all routes, require the original management role, validate ids, then
 * delegate to management.controller.
 */
const express = require("express");
const {
  body,
  param,
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
    validateRequest,
  ],
  managementController.createUser,
);

router.get(
  "/subjects",
  managementController.listSubjects,
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
