/**
 * WHAT:
 * CriterionReportDraft stores a teacher-editable learning objective and report
 * comments for one live Task Focus without changing submitted evidence.
 * WHY:
 * Qualification evidence must remain auditable while teachers refine the
 * wording used in a draft report and its PDF export.
 * HOW:
 * Persist one override record per student, subject, and task code, attributed
 * to the teacher who most recently saved it.
 */
const mongoose = require("mongoose");

const theoryQuestionCommentSchema = new mongoose.Schema(
  {
    questionIndex: { type: Number, required: true, min: 0, max: 9 },
    comment: { type: String, default: "", maxlength: 10000 },
  },
  { _id: false },
);

const criterionReportDraftSchema = new mongoose.Schema(
  {
    studentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    subjectId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Subject",
      required: true,
      index: true,
    },
    taskCode: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      match: /^[PMD]\d+$/,
      index: true,
    },
    criterionWording: { type: String, default: "", maxlength: 5000 },
    essayTeacherComment: { type: String, default: "", maxlength: 20000 },
    essayNextTime: { type: String, default: "", maxlength: 20000 },
    theoryQuestionComments: {
      type: [theoryQuestionCommentSchema],
      default: [],
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true },
);

criterionReportDraftSchema.index(
  { studentId: 1, subjectId: 1, taskCode: 1 },
  { unique: true, name: "unique_student_subject_task_report_draft" },
);

module.exports = mongoose.model(
  "CriterionReportDraft",
  criterionReportDraftSchema,
);
