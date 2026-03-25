/**
 * WHAT:
 * ensureTeacher creates or updates a teacher account with a known password.
 * WHY:
 * Bot teacher emails must exist in production for login and timetable links.
 * HOW:
 * Upsert by email, set role/subject, and set password hash.
 */
require("dotenv").config();

const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");

const connectDB = require("../config/db");
const User = require("../models/User");
const {
  normalizeTeacherSubjectSpecialties,
} = require("./teacherSubjectSpecialties");

async function ensureTeacher() {
  await connectDB();

  const email = String(process.argv[2] || "").trim().toLowerCase();
  const name = String(process.argv[3] || "").trim();
  const subject = String(process.argv[4] || "").trim();
  const password = String(process.argv[5] || "flexiblelearning123!");
  const additionalSubjects = process.argv.slice(6);

  if (!email || !name || !subject) {
    throw new Error(
      "Usage: node src/utils/ensureTeacher.js <email> <name> <primary-subject> [password] [additional-subject ...]",
    );
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const normalizedSubjects = normalizeTeacherSubjectSpecialties({
    primarySubjectSpecialty: subject,
    subjectSpecialties: additionalSubjects,
  });
  const update = {
    name,
    email,
    passwordHash,
    role: "teacher",
    subjectSpecialty: normalizedSubjects[0] || subject,
    subjectSpecialties: normalizedSubjects,
    isPlaceholder: true,
    avatarSeed: name,
    avatar: "",
  };

  const result = await User.findOneAndUpdate(
    { email },
    update,
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  console.log(`Teacher ready: ${result.name} (${result.email})`);
}

ensureTeacher()
  .catch((error) => {
    console.error("Ensure teacher failed:", error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.connection.close();
  });
