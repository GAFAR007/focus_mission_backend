/**
 * WHAT:
 * ResultScreenshot stores teacher-captured result report screenshots uploaded
 * from the Flutter result report view.
 * WHY:
 * Teachers can optionally attach screenshot evidence when sending result
 * packages, so the binary asset and ownership metadata must be persisted.
 * HOW:
 * Save image bytes and metadata keyed by result package and teacher, then serve
 * by id through a protected route.
 */

const mongoose = require("mongoose");

const resultScreenshotSchema = new mongoose.Schema(
  {
    resultPackageId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ResultPackage",
      required: true,
      index: true,
    },
    missionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Mission",
      default: null,
      index: true,
    },
    studentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    uploadedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    fileName: {
      type: String,
      default: "",
      trim: true,
    },
    mimeType: {
      type: String,
      default: "image/png",
      trim: true,
    },
    byteSize: {
      type: Number,
      min: 0,
      default: 0,
    },
    data: {
      type: Buffer,
      required: true,
    },
  },
  {
    timestamps: true,
  },
);

resultScreenshotSchema.index({
  resultPackageId: 1,
  createdAt: -1,
});

module.exports = mongoose.model("ResultScreenshot", resultScreenshotSchema);
