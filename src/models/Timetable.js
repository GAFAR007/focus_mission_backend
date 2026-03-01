/**
 * WHAT:
 * Timetable stores the student's scheduled morning and afternoon lessons for a
 * given weekday.
 * WHY:
 * Teacher permission checks and date-based mission availability depend on a
 * stable record of which subject and teacher owns each lesson slot.
 * HOW:
 * Save subject, room, mentor, and teacher assignments per student and weekday
 * so services can resolve the correct slot before generating or serving work.
 */
const mongoose = require("mongoose");

const timetableSchema = new mongoose.Schema(
  {
    studentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    day: {
      type: String,
      required: true,
      trim: true,
    },
    morningSubject: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Subject",
      required: true,
    },
    afternoonSubject: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Subject",
      required: true,
    },
    room: {
      type: String,
      default: "",
      trim: true,
    },
    mentorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    morningTeacherId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      // WHY: Slot-level teacher ownership is required so only the assigned
      // teacher can prepare or publish the lesson mission for that period.
    },
    afternoonTeacherId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      // WHY: Afternoon lessons may have a different teacher, so permission
      // checks cannot rely on a single teacher field for the full day.
    },
  },
  {
    timestamps: true,
  },
);

module.exports = mongoose.model("Timetable", timetableSchema);
