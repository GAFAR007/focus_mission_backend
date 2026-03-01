/**
 * WHAT:
 * notification.controller exposes inbox list and mark-read handlers for the
 * current authenticated user.
 * WHY:
 * Notifications need a thin controller boundary so request wiring stays
 * separate from notification query and read-state logic.
 * HOW:
 * Delegate to notification.service using the authenticated requester id and
 * return stable JSON payloads for inbox screens.
 */
const notificationService = require("../services/notification.service");

async function listNotifications(req, res, next) {
  try {
    const result = await notificationService.listNotifications({
      recipientId: req.user.id,
    });

    res.json(result);
  } catch (error) {
    next(error);
  }
}

async function markNotificationRead(req, res, next) {
  try {
    const result = await notificationService.markNotificationRead({
      recipientId: req.user.id,
      notificationId: req.params.notificationId,
    });

    res.json(result);
  } catch (error) {
    next(error);
  }
}

module.exports = {
  listNotifications,
  markNotificationRead,
};
