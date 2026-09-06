/**
 * WHAT:
 * auth.routes registers public login and access verification, school-gated
 * demo-account lookup, and protected profile routes.
 * WHY:
 * Authentication needs a small dedicated route surface so credentials and
 * profile updates stay separate from subject and progression flows.
 * HOW:
 * Validate incoming auth payloads, protect profile endpoints, and delegate the
 * request handling to auth.controller.
 */
const express = require("express");
const { body, query } = require("express-validator");

const accessGateController = require("../controllers/accessGate.controller");
const authController = require("../controllers/auth.controller");
const {
  requireSchoolAccess,
} = require("../middleware/accessGate.middleware");
const { protect } = require("../middleware/auth.middleware");
const { validateRequest } = require("../middleware/validate.middleware");

const router = express.Router();

router.post(
  "/access-gate/verify",
  [
    body("code")
      .isString()
      .bail()
      .custom((value) => {
        const code = String(value || "").trim();
        // WHY: A bounded non-empty string rejects malformed traffic without
        // revealing the real access-code length or format.
        return code.length > 0 && code.length <= 256;
      })
      .withMessage("A valid access code is required."),
    validateRequest,
  ],
  accessGateController.verify,
);

router.post(
  "/login",
  [
    body("email").isEmail().withMessage("A valid email is required."),
    body("password")
      .isLength({ min: 8 })
      .withMessage("Password must be at least 8 characters."),
    validateRequest,
  ],
  authController.login,
);

router.post(
  "/password-reset/request",
  [
    body("email").isEmail().withMessage("A valid email is required."),
    validateRequest,
  ],
  authController.requestPasswordResetCode,
);

router.post(
  "/password-reset/confirm",
  [
    body("email").isEmail().withMessage("A valid email is required."),
    body("code")
      .isLength({ min: 6, max: 6 })
      .withMessage("Reset code must be 6 digits."),
    body("newPassword")
      .isLength({ min: 8 })
      .withMessage("Password must be at least 8 characters."),
    validateRequest,
  ],
  authController.confirmPasswordReset,
);

router.get(
  "/demo-accounts",
  [
    requireSchoolAccess,
    query("role")
      .isIn(["student", "teacher", "mentor", "management"])
      .withMessage("role must be student, teacher, mentor, or management."),
    validateRequest,
  ],
  authController.getDemoAccounts,
);

router.get("/me", protect, authController.me);

router.patch(
  "/me/avatar",
  [
    protect,
    body("avatar").isURL().withMessage("A valid avatar URL is required."),
    body("avatarSeed")
      .trim()
      .notEmpty()
      .withMessage("avatarSeed is required."),
    validateRequest,
  ],
  authController.updateAvatar,
);

module.exports = router;
