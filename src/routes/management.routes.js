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
const { param } = require("express-validator");

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
