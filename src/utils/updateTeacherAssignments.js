/**
 * WHAT:
 * updateTeacherAssignments replaces one teacher's assigned-student list from
 * explicit student email arguments.
 * WHY:
 * Live bot teachers can drift away from the seeded assignment state, so this
 * utility repairs one affected teacher without reseeding the whole database.
 * HOW:
 * Resolve the teacher by email, resolve each provided student email, and write
 * the exact assignedStudents array back to the teacher account.
 */
require("dotenv").config();

const mongoose = require("mongoose");

const connectDB = require("../config/db");
const User = require("../models/User");

function ensureEmail(value, label) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) {
    throw new Error(`${label} must be a non-empty email.`);
  }
  return normalized;
}

async function updateTeacherAssignments() {
  await connectDB();

  const teacherEmail = ensureEmail(
    process.argv[2],
    "teacher email (arg 1)",
  );
  const studentEmails = process.argv
    .slice(3)
    .map((value, index) =>
      ensureEmail(value, `student email arg ${index + 2}`),
    );

  if (studentEmails.length === 0) {
    throw new Error(
      "Usage: node src/utils/updateTeacherAssignments.js <teacher-email> <student-email> [student-email...]",
    );
  }

  const teacher = await User.findOne({
    email: teacherEmail,
    role: "teacher",
  });

  if (!teacher) {
    throw new Error(`Teacher not found: ${teacherEmail}`);
  }

  const students = await User.find({
    email: { $in: studentEmails },
    role: "student",
  })
    .select("_id email")
    .lean();

  if (students.length !== studentEmails.length) {
    const foundEmails = new Set(
      students.map((student) => String(student.email || "").toLowerCase()),
    );
    const missingEmails = studentEmails.filter((email) => !foundEmails.has(email));
    throw new Error(`Student(s) not found: ${missingEmails.join(", ")}`);
  }

  teacher.assignedStudents = students.map((student) => student._id);
  await teacher.save();

  console.log(
    `Assigned ${students.length} student(s) to ${teacher.name} (${teacher.email}).`,
  );
}

updateTeacherAssignments()
  .catch((error) => {
    console.error("Failed to update teacher assignments:", error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.connection.close();
  });
