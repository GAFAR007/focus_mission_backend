/**
 * WHAT:
 * resetJourneyDay recalibrates a single student's journey counters to day one.
 * WHY:
 * Testing often advances login data; resetting keeps the UI showing day 1.
 * HOW:
 * Update first/last login and loginDayCount for the requested email and return data summary.
 */
require("dotenv").config();

const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");

const connectDB = require("../config/db");
const User = require("../models/User");
const { calculateDaysSinceFirstLogin } = require("../utils/userJourney");

async function resetJourneyDay() {
  await connectDB();

  const email = String(process.argv[2] || "student@focusmission.app")
    .trim()
    .toLowerCase();

  const user = await User.findOne({ email });
  if (!user) {
    throw new Error(`No user found for ${email}`);
  }

  const now = new Date();
  user.firstLoginAt = now;
  user.lastLoginAt = now;
  user.loginDayCount = 1;
  await user.save();

  console.log(
    `Journey reset for ${user.name} (${email}):`,
    `dayCount=1`,
    `daysSinceFirstLogin=${calculateDaysSinceFirstLogin(now, now)}`,
  );
}

resetJourneyDay().catch((error) => {
  console.error("Journey reset failed:", error.message);
  process.exitCode = 1;
}).finally(async () => {
  await mongoose.connection.close();
});
