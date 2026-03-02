/**
 * WHAT:
 * updateTimetable rewrites a student's timetable entries from structured JSON.
 * WHY:
 * Teachers may need to correct schedule data after you deploy, so a small
 * script avoids manual Atlas editing and keeps IDs consistent.
 * HOW:
 * Resolve student/subject/teacher references, drop existing entries, and insert
 * the new schedule payload provided by a JSON file path argument.
 */
require("dotenv").config();

const mongoose = require("mongoose");
const fs = require("fs");
const path = require("path");

const connectDB = require("../config/db");
const Subject = require("../models/Subject");
const Timetable = require("../models/Timetable");
const User = require("../models/User");

async function loadSchedule(filePath) {
  const resolved = path.isAbsolute(filePath)
    ? filePath
    : path.join(process.cwd(), filePath);

  const content = await fs.promises.readFile(resolved, "utf8");
  return JSON.parse(content);
}

function ensureString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

async function findSubjectId(name) {
  const subjectName = ensureString(name, "subject name");
  let subject = await Subject.findOne({
    name: new RegExp(`^${subjectName}$`, "i"),
  });
  if (!subject) {
    subject = await Subject.create({
      name: subjectName,
      icon: "menu_book",
      color: "#D6D9F0",
      difficultyDefaults: ["easy", "medium"],
    });
  }
  return subject._id;
}

async function findTeacherId(email) {
  const teacherEmail = ensureString(email, "teacher email").toLowerCase();
  let user = await User.findOne({
    email: teacherEmail,
    role: "teacher",
  });
  if (!user) {
    const fallbackName = teacherEmail.split("@")[0].replace(/\./g, " ");
    user = await User.create({
      name: fallbackName
        .split(" ")
        .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
        .join(" "),
      email: teacherEmail,
      passwordHash: "$2b$10$0gy7m8cDWd0l9tFtkcR1xO64sE4g8yOZj2J9EvQv3xR2K9bM82K6C",
      role: "teacher",
      subjectSpecialty: "",
      isPlaceholder: true,
      avatarSeed: teacherEmail,
      avatar: "",
    });
  }
  return user._id;
}

async function findMentorId(email) {
  const user = await User.findOne({
    email: email.toLowerCase().trim(),
    role: "mentor",
  });
  if (!user) {
    throw new Error(`Mentor not found: ${email}`);
  }
  return user._id;
}

async function updateTimetable() {
  await connectDB();

  const email = ensureString(
    process.argv[2] || "",
    "student email (arg 1)",
  ).toLowerCase();
  const schedulePath = ensureString(
    process.argv[3] || "",
    "path to schedule JSON (arg 2)",
  );

  const student = await User.findOne({ email, role: "student" });
  if (!student) {
    throw new Error(`Student not found: ${email}`);
  }

  const rows = await loadSchedule(schedulePath);
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error("Schedule file must contain a non-empty array.");
  }

  await Timetable.deleteMany({ studentId: student._id });

  const entries = [];
  for (const row of rows) {
    const day = ensureString(row.day, "day");
    const room = ensureString(row.room || "Room 1", "room");
    const morningSubject = ensureString(
      row.morningSubject,
      `morningSubject (row: ${day})`,
    );
    const afternoonSubject = ensureString(
      row.afternoonSubject,
      `afternoonSubject (row: ${day})`,
    );
    const morningTeacher = ensureString(
      row.morningTeacherEmail,
      `morningTeacherEmail (row: ${day})`,
    );
    const afternoonTeacher = ensureString(
      row.afternoonTeacherEmail,
      `afternoonTeacherEmail (row: ${day})`,
    );
    const mentorEmail = row.mentorEmail
      ? ensureString(row.mentorEmail, `mentorEmail (row: ${day})`)
      : null;

    const entry = {
      studentId: student._id,
      day,
      room,
      morningSubject: await findSubjectId(morningSubject),
      afternoonSubject: await findSubjectId(afternoonSubject),
      morningTeacherId: await findTeacherId(morningTeacher),
      afternoonTeacherId: await findTeacherId(afternoonTeacher),
      mentorId: mentorEmail ? await findMentorId(mentorEmail) : null,
    };

    entries.push(entry);
  }

  await Timetable.insertMany(entries);

  console.log(
    `Updated ${entries.length} timetable entries for ${student.name} (${email}).`,
  );
}

updateTimetable()
  .catch((error) => {
    console.error("Failed to update timetable:", error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.connection.close();
  });
