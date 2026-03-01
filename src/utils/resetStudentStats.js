/**
 * WHAT:
 * resetStudentStats clears one student's test-derived mission/session stats.
 * WHY:
 * Local testing can leave XP, streak, badges, and mission scores that should
 * be wiped before real-date validation.
 * HOW:
 * Resolve the student by email, clear score-bearing collections, reset mission
 * score fields, and restore core user progress fields to baseline values.
 */
require("dotenv").config();

const mongoose = require("mongoose");

const connectDB = require("../config/db");
const Mission = require("../models/Mission");
const SessionLog = require("../models/SessionLog");
const Target = require("../models/Target");
const User = require("../models/User");

async function resetStudentStats() {
  await connectDB();

  const email = String(process.argv[2] || "student@focusmission.app")
    .trim()
    .toLowerCase();

  const student = await User.findOne({
    email,
    role: "student",
  });

  if (!student) {
    throw new Error(`Student not found for email: ${email}`);
  }

  const studentId = student._id;

  const [sessionDeleteResult, missionUpdateResult, targetUpdateResult] =
    await Promise.all([
      SessionLog.deleteMany({ studentId }),
      Mission.updateMany(
        { studentId },
        {
          $set: {
            latestScoreCorrect: 0,
            latestScoreTotal: 0,
            latestScorePercent: 0,
            latestXpEarned: 0,
          },
        },
      ),
      Target.updateMany(
        { studentId },
        {
          $set: {
            stars: 0,
            xpAwarded: 0,
            awardedByStaffId: null,
            awardedAt: null,
          },
        },
      ),
    ]);

  student.xp = 0;
  student.streak = 0;
  student.lastPerformanceDateKey = "";
  student.streakBadgeUnlocked = false;
  student.subjectCompletionAwards = [];
  await student.save();

  console.log(
    [
      `Reset complete for ${student.name} (${email})`,
      `Session logs removed: ${sessionDeleteResult.deletedCount}`,
      `Missions reset: ${missionUpdateResult.modifiedCount}`,
      `Targets reset: ${targetUpdateResult.modifiedCount}`,
    ].join("\n"),
  );
}

resetStudentStats()
  .catch((error) => {
    console.error("Failed to reset student stats:", error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.connection.close();
  });
