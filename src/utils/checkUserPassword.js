/**
 * WHAT:
 * checkUserPassword validates a user's password hash for quick login checks.
 * WHY:
 * Debugging 401s is faster with a direct hash comparison against MongoDB.
 * HOW:
 * Load the user by email, compare bcrypt hash, and print the result.
 */
require("dotenv").config();

const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");

const connectDB = require("../config/db");
const User = require("../models/User");

async function checkUserPassword() {
  await connectDB();

  const email = String(process.argv[2] || "").trim().toLowerCase();
  const password = String(process.argv[3] || "");

  if (!email || !password) {
    throw new Error(
      "Usage: node src/utils/checkUserPassword.js <email> <password>",
    );
  }

  const user = await User.findOne({ email }).select("+passwordHash");
  if (!user) {
    throw new Error(`User not found: ${email}`);
  }

  const ok = await bcrypt.compare(password, user.passwordHash);
  console.log(
    `Password match for ${email}: ${ok ? "YES" : "NO"} (role=${user.role})`,
  );
}

checkUserPassword()
  .catch((error) => {
    console.error("Check failed:", error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.connection.close();
  });
