/**
 * WHAT:
 * Stores in-app notifications for teacher action and criterion milestones.
 * WHY:
 * The frozen MVP requires in-app notifications for learning review requests
 * and criterion submissions so teachers can respond without email or silent
 * state changes.
 * HOW:
 * Each notification targets one recipient, references the student and
 * criterion where relevant, and keeps read-state metadata for later inbox UI.
 */

const mongoose = require("mongoose");

const notificationSchema = new mongoose.Schema(
  {
    recipientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    studentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    criterionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Criterion",
      default: null,
      index: true,
    },
    type: {
      type: String,
      enum: ["learning_review_required", "criterion_submitted"],
      required: true,
      index: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    message: {
      type: String,
      required: true,
      trim: true,
    },
    isRead: {
      type: Boolean,
      default: false,
      index: true,
    },
    readAt: {
      type: Date,
      default: null,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

notificationSchema.index({ recipientId: 1, isRead: 1, createdAt: -1 });

module.exports = mongoose.model("Notification", notificationSchema);
