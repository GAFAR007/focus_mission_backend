/**
 * WHAT:
 * updateStaffPassword rotates teacher and mentor passwords in the live DB.
 * WHY:
 * Existing seeded accounts may still have older hashes, so staff sign-in needs
 * one explicit update utility without reseeding all data.
 * HOW:
 * Hash the provided password once, update all teacher/mentor users, and print
 * how many accounts were changed.
 */
require("dotenv").config();

const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");

const connectDB = require("../config/db");
const User = require("../models/User");

async function updateStaffPassword() {
  await connectDB();

  const nextPassword = String(process.argv[2] || "").trim();
  if (!nextPassword) {
    throw new Error(
      "Usage: node src/utils/updateStaffPassword.js <new-password>",
    );
  }

  const passwordHash = await bcrypt.hash(nextPassword, 10);
  const result = await User.updateMany(
    { role: { $in: ["teacher", "mentor"] } },
    { $set: { passwordHash } },
  );

  console.log(
    `Updated staff passwords for ${result.modifiedCount} account(s).`,
  );
}

updateStaffPassword()
  .catch((error) => {
    console.error("Failed to update staff passwords:", error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.connection.close();
  });
