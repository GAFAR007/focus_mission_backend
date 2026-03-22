/**
 * WHAT:
 * auth.service handles login validation, token issuance, journey-day tracking,
 * and avatar profile updates.
 * WHY:
 * Authentication is also where the app establishes the learner's ongoing
 * journey, so credential checks and login-day rules must stay centralized and
 * auditable.
 * HOW:
 * Validate credentials against stored hashes, issue JWT tokens, update the
 * first-login and journey fields, then serialize user-safe profile data.
 */
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const SessionLog = require("../models/SessionLog");
const User = require("../models/User");
const {
  getCalendarDayDifference,
  serializeJourney,
} = require("../utils/userJourney");
const {
  DAILY_LOGIN_XP,
  getDateKey,
} = require("../utils/xpPolicy");
const { normalizeStudentYearGroup } = require("../utils/studentYearGroup");

const PUBLIC_DEMO_ACCOUNT_LIMIT = 24;

function createError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function ensureDatabaseReady() {
  if (mongoose.connection.readyState !== 1) {
    // WHY: Login must fail fast when the database is offline so clients see a
    // clear service-unavailable response instead of waiting for query timeouts.
    throw createError(
      503,
      "Database is unavailable. Check MongoDB connection and try again.",
    );
  }
}

function serializeUser(user) {
  return {
    id: String(user._id),
    name: user.name,
    email: user.email,
    role: user.role,
    subjectSpecialty: user.subjectSpecialty,
    yearGroup: normalizeStudentYearGroup(user.yearGroup),
    isPlaceholder: user.isPlaceholder,
    avatar: user.avatar,
    avatarSeed: user.avatarSeed,
    xp: user.xp,
    streak: user.streak,
    streakBadgeUnlocked: Boolean(user.streakBadgeUnlocked),
    ...serializeJourney(user),
    preferredDifficulty: user.preferredDifficulty,
    assignedStudents: (user.assignedStudents || []).map((id) => String(id)),
  };
}

function serializeDemoAccount(user) {
  return {
    name: String(user.name || ""),
    email: String(user.email || ""),
    role: String(user.role || ""),
    subject: String(user.subjectSpecialty || ""),
    yearGroup: normalizeStudentYearGroup(user.yearGroup),
    isPlaceholder: Boolean(user.isPlaceholder),
  };
}

function normalizeRole(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();

  if (!["student", "teacher", "mentor", "management"].includes(normalized)) {
    throw createError(400, "role must be student, teacher, mentor, or management.");
  }

  return normalized;
}

function createToken(user) {
  return jwt.sign(
    { role: user.role, sub: String(user._id) },
    process.env.JWT_SECRET || "development-secret",
    // WHY: The token lifetime is long enough for classroom sessions without
    // forcing repeated logins during supported learning flow.
    { expiresIn: "7d" },
  );
}

async function login({ email, password }) {
  ensureDatabaseReady();

  const user = await User.findOne({ email: email.toLowerCase().trim() }).select(
    "+passwordHash",
  );

  if (!user) {
    // WHY: The service returns the same message for missing users and bad
    // passwords so the login boundary does not leak which emails exist.
    throw createError(401, "Invalid email or password.");
  }

  if (user.isArchived === true) {
    // WHY: Archived learners must not continue into the live app even if they
    // still know their password, otherwise archived result history would keep
    // behaving like an active student account.
    throw createError(403, "This account has been archived. Contact management.");
  }

  const isPasswordValid = await bcrypt.compare(password, user.passwordHash);

  if (!isPasswordValid) {
    // WHY: Matching the same generic failure message preserves account privacy
    // and reduces credential probing.
    throw createError(401, "Invalid email or password.");
  }

  const now = new Date();
  const dateKey = getDateKey(now);
  let shouldSave = false;
  let dailyLoginRewardGranted = false;
  let dailyLoginXpAwarded = 0;

  if (!user.firstLoginAt) {
    // WHY: The first successful login defines the start of the learner journey
    // so journey-day tracking reflects real platform entry, not seed time.
    user.firstLoginAt = now;
    user.lastLoginAt = now;
    user.loginDayCount = 1;
    shouldSave = true;
  } else {
    const previousLoginAt = user.lastLoginAt || user.firstLoginAt;
    const dayDifference = getCalendarDayDifference(now, previousLoginAt);

    if (!user.loginDayCount || user.loginDayCount < 1) {
      user.loginDayCount = 1;
      shouldSave = true;
    }

    if (dayDifference > 0) {
      // WHY: Journey day count is login-based, but streak is performance-based
      // and is updated only by session completion XP logic.
      user.loginDayCount += 1;
      shouldSave = true;
    }

    user.lastLoginAt = now;
    shouldSave = true;
  }

  if (
    user.role === "student" &&
    String(user.lastDailyLoginXpDateKey || "").trim() !== dateKey
  ) {
    const legacyAttendanceRewardExists = await SessionLog.exists({
      studentId: user._id,
      dateKey,
      attendanceXpAwarded: { $gt: 0 },
    });

    // WHY: The first successful student login of the day should immediately
    // grant the daily bonus so the dashboard reflects today's progress before
    // any mission is started.
    if (!legacyAttendanceRewardExists) {
      user.xp = Math.max(0, Number(user.xp || 0) + DAILY_LOGIN_XP);
      dailyLoginRewardGranted = true;
      dailyLoginXpAwarded = DAILY_LOGIN_XP;
      user.lastDailyLoginXpAwardedAt = now;
    }
    user.lastDailyLoginXpDateKey = dateKey;
    shouldSave = true;
  }

  if (shouldSave) {
    await user.save();
  }

  const token = createToken(user);
  if (String(process.env.LOG_LOGIN_TOKEN || "").trim().toLowerCase() === "true") {
    // WHY: Temporary debugging support can print the issued token so manual
    // API testing is possible without separate login tooling.
    console.log("[auth] login token issued", {
      userId: String(user._id),
      email: user.email,
      role: user.role,
      token,
    });
  }

  return {
    token,
    user: serializeUser(user),
    loginMeta: {
      dailyLoginRewardGranted,
      dailyLoginXpAwarded,
      dateKey,
    },
  };
}

async function listDemoAccounts({ role }) {
  ensureDatabaseReady();

  const normalizedRole = normalizeRole(role);
  const users = await User.find({
    role: normalizedRole,
    isArchived: { $ne: true },
  })
    .sort({ isPlaceholder: 1, name: 1, email: 1 })
    .limit(PUBLIC_DEMO_ACCOUNT_LIMIT)
    .select("name email role subjectSpecialty isPlaceholder")
    .lean();

  // WHY: The public quick-fill list should expose only the safe fields needed
  // for login chips, never password hashes or assignment relationships.
  return users.map(serializeDemoAccount);
}

async function getCurrentUser(userId) {
  ensureDatabaseReady();

  const user = await User.findById(userId);

  if (!user) {
    throw createError(404, "User not found.");
  }

  return serializeUser(user);
}

async function updateAvatar(userId, { avatar, avatarSeed }) {
  ensureDatabaseReady();

  const user = await User.findByIdAndUpdate(
    userId,
    {
      avatar: avatar.trim(),
      avatarSeed: avatarSeed.trim(),
    },
    { new: true },
  );

  if (!user) {
    throw createError(404, "User not found.");
  }

  return serializeUser(user);
}

module.exports = {
  login,
  listDemoAccounts,
  getCurrentUser,
  updateAvatar,
};
