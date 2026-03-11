/**
 * WHAT:
 * resetAllStudentResults clears stored mission result evidence and derived XP
 * state for every student account without deleting users or timetable data.
 * WHY:
 * Live testing can leave old result packages, session logs, and award totals
 * that need a clean reset across the whole learner base.
 * HOW:
 * Load all student ids, delete student-owned result collections, reset mission
 * score links, reset target reward fields, and restore student XP/award fields
 * to their baseline values.
 */
require("dotenv").config();

const mongoose = require("mongoose");

const connectDB = require("../config/db");
const Mission = require("../models/Mission");
const ResultPackage = require("../models/ResultPackage");
const ResultScreenshot = require("../models/ResultScreenshot");
const SendLog = require("../models/SendLog");
const SessionLog = require("../models/SessionLog");
const Target = require("../models/Target");
const User = require("../models/User");

async function resetAllStudentResults() {
  await connectDB();

  const students = await User.find({ role: "student" }).select(
    "_id name email",
  );
  const studentIds = students.map((student) => student._id);

  if (studentIds.length === 0) {
    console.log("No student users found. Nothing was reset.");
    return;
  }

  const resultPackages = await ResultPackage.find({
    studentId: { $in: studentIds },
  }).select("_id");
  const resultPackageIds = resultPackages.map((resultPackage) => resultPackage._id);

  const deleteTasks = [
    SessionLog.deleteMany({ studentId: { $in: studentIds } }),
    ResultPackage.deleteMany({ studentId: { $in: studentIds } }),
    ResultScreenshot.deleteMany({
      $or: [
        { studentId: { $in: studentIds } },
        ...(resultPackageIds.length > 0
            ? [{ resultPackageId: { $in: resultPackageIds } }]
            : []),
      ],
    }),
    Mission.updateMany(
      { studentId: { $in: studentIds } },
      {
        $set: {
          latestScoreCorrect: 0,
          latestScoreTotal: 0,
          latestScorePercent: 0,
          latestXpEarned: 0,
          latestResultPackageId: null,
        },
      },
    ),
    Target.updateMany(
      { studentId: { $in: studentIds } },
      {
        $set: {
          stars: 0,
          xpAwarded: 0,
          awardedByStaffId: null,
          awardedAt: null,
        },
      },
    ),
    User.updateMany(
      { _id: { $in: studentIds } },
      {
        $set: {
          xp: 0,
          streak: 0,
          lastPerformanceDateKey: "",
          streakBadgeUnlocked: false,
          subjectCompletionAwards: [],
          subjectCertificationAwards: [],
        },
      },
    ),
  ];

  if (resultPackageIds.length > 0) {
    deleteTasks.push(
      SendLog.deleteMany({ resultPackageId: { $in: resultPackageIds } }),
    );
  }

  const [
    sessionDeleteResult,
    resultPackageDeleteResult,
    resultScreenshotDeleteResult,
    missionUpdateResult,
    targetUpdateResult,
    userUpdateResult,
    sendLogDeleteResult,
  ] = await Promise.all(deleteTasks);

  console.log(
    [
      `Reset complete for ${students.length} student users.`,
      `Session logs removed: ${sessionDeleteResult.deletedCount}`,
      `Result packages removed: ${resultPackageDeleteResult.deletedCount}`,
      `Result screenshots removed: ${resultScreenshotDeleteResult.deletedCount}`,
      `Send logs removed: ${sendLogDeleteResult?.deletedCount || 0}`,
      `Missions reset: ${missionUpdateResult.modifiedCount}`,
      `Targets reset: ${targetUpdateResult.modifiedCount}`,
      `Students reset: ${userUpdateResult.modifiedCount}`,
    ].join("\n"),
  );
}

resetAllStudentResults()
  .catch((error) => {
    console.error("Failed to reset all student results:", error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.connection.close();
  });
