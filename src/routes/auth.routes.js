/**
 * WHAT:
 * auth.routes registers the public login route and protected profile routes.
 * WHY:
 * Authentication needs a small dedicated route surface so credentials and
 * profile updates stay separate from subject and progression flows.
 * HOW:
 * Validate incoming auth payloads, protect profile endpoints, and delegate the
 * request handling to auth.controller.
 */
const express = require("express");
const { body } = require("express-validator");

const authController = require("../controllers/auth.controller");
const { protect } = require("../middleware/auth.middleware");
const { validateRequest } = require("../middleware/validate.middleware");

const router = express.Router();

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
