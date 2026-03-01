/**
 * WHAT:
 * notification.routes registers in-app inbox endpoints for the authenticated
 * teacher or mentor.
 * WHY:
 * The UI needs one protected notification route surface so inbox data stays
 * behind auth and ownership checks.
 * HOW:
 * Protect the routes, validate notification ids, and delegate the handlers to
 * notification.controller.
 */
const express = require("express");
const { param } = require("express-validator");

const notificationController = require("../controllers/notification.controller");
const {
  authorizeRoles,
  protect,
} = require("../middleware/auth.middleware");
const { validateRequest } = require("../middleware/validate.middleware");

const router = express.Router();

router.use(protect, authorizeRoles("teacher", "mentor"));

router.get("/", notificationController.listNotifications);

router.patch(
  "/:notificationId/read",
  [
    param("notificationId")
      .isMongoId()
      .withMessage("Valid notificationId is required."),
    validateRequest,
  ],
  notificationController.markNotificationRead,
);

module.exports = router;
