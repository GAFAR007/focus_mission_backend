/**
 * WHAT:
 * notification.service loads the current user's in-app notifications and marks
 * individual notifications as read.
 * WHY:
 * Teachers need one consistent inbox boundary for learning review and
 * submission alerts instead of each screen querying notification records
 * directly.
 * HOW:
 * Query notifications by recipient, serialize the populated student and
 * criterion context, and persist read-state changes only for the owning user.
 */
const Notification = require("../models/Notification");

function createError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function serializeNotification(notification) {
  const student =
    notification.studentId && typeof notification.studentId === "object"
      ? notification.studentId
      : null;
  const criterion =
    notification.criterionId && typeof notification.criterionId === "object"
      ? notification.criterionId
      : null;

  return {
    id: String(notification._id || notification.id),
    type: notification.type,
    title: notification.title,
    message: notification.message,
    isRead: notification.isRead === true,
    readAt: notification.readAt ? new Date(notification.readAt).toISOString() : null,
    createdAt: notification.createdAt
      ? new Date(notification.createdAt).toISOString()
      : null,
    studentId: student ? String(student._id || student.id) : null,
    studentName: student?.name || null,
    criterionId: criterion ? String(criterion._id || criterion.id) : null,
    criterionTitle: criterion?.title || null,
  };
}

async function listNotifications({ recipientId }) {
  const notifications = await Notification.find({ recipientId })
    .sort({ isRead: 1, createdAt: -1 })
    .limit(20)
    .populate("studentId", "name")
    .populate("criterionId", "title")
    .lean();

  const unreadCount = await Notification.countDocuments({
    recipientId,
    isRead: false,
  });

  return {
    unreadCount,
    notifications: notifications.map(serializeNotification),
  };
}

async function markNotificationRead({ recipientId, notificationId }) {
  const notification = await Notification.findOne({
    _id: notificationId,
    recipientId,
  });

  if (!notification) {
    throw createError(404, "Notification not found.");
  }

  if (!notification.isRead) {
    // WHY: Read state should only change when the recipient actually opens or
    // acknowledges the notification, so the inbox remains auditable.
    notification.isRead = true;
    notification.readAt = new Date();
    await notification.save();
  }

  await notification.populate("studentId", "name");
  await notification.populate("criterionId", "title");

  return {
    notification: serializeNotification(notification.toObject()),
  };
}

module.exports = {
  listNotifications,
  markNotificationRead,
};
