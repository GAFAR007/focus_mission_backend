/**
 * WHAT:
 * SendLog records each teacher-triggered result delivery attempt and channel
 * outcome details.
 * WHY:
 * Result sending must remain traceable with per-channel success/failure status
 * and retry state, especially when email delivery is delayed.
 * HOW:
 * Persist recipients, attempted channels, channel statuses, retry metadata, and
 * optional screenshot reference for every send action.
 */

const mongoose = require("mongoose");

const channelStatusSchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: ["not_requested", "success", "fail", "pending_retry"],
      default: "not_requested",
    },
    failureReason: {
      type: String,
      default: "",
      trim: true,
    },
  },
  { _id: false },
);

const sendLogSchema = new mongoose.Schema(
  {
    resultPackageId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ResultPackage",
      required: true,
      index: true,
    },
    sentBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    sentAt: {
      type: Date,
      required: true,
      default: Date.now,
      index: true,
    },
    recipients: {
      type: [String],
      default: [],
    },
    channelsAttempted: {
      inApp: {
        type: Boolean,
        default: false,
      },
      email: {
        type: Boolean,
        default: false,
      },
    },
    channelStatus: {
      inApp: {
        type: channelStatusSchema,
        default: () => ({ status: "not_requested", failureReason: "" }),
      },
      email: {
        type: channelStatusSchema,
        default: () => ({ status: "not_requested", failureReason: "" }),
      },
    },
    failureReason: {
      type: String,
      default: "",
      trim: true,
    },
    screenshotUrl: {
      type: String,
      default: "",
      trim: true,
    },
    emailRetry: {
      pending: {
        type: Boolean,
        default: false,
        index: true,
      },
      retryCount: {
        type: Number,
        min: 0,
        default: 0,
      },
      maxRetries: {
        type: Number,
        min: 0,
        default: 3,
      },
      nextRetryAt: {
        type: Date,
        default: null,
        index: true,
      },
      lastAttemptAt: {
        type: Date,
        default: null,
      },
    },
  },
  {
    timestamps: true,
  },
);

sendLogSchema.index({
  resultPackageId: 1,
  sentAt: -1,
});

module.exports = mongoose.model("SendLog", sendLogSchema);
