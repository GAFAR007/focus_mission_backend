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
const crypto = require("crypto");
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
const {
  normalizeTeacherSubjectSpecialties,
} = require("../utils/teacherSubjectSpecialties");

const PUBLIC_DEMO_ACCOUNT_LIMIT = 24;
const PASSWORD_RESET_CODE_LENGTH = 6;
const PASSWORD_RESET_CODE_TTL_MINUTES = 15;
const PASSWORD_RESET_MIN_FAILED_ATTEMPTS = 3;
const AUTH_GENERIC_FAILURE_MESSAGE = "Invalid email or password.";
const AUTH_RESET_AVAILABLE_MESSAGE =
  "Invalid email or password. You can request a reset code now.";
const PASSWORD_RESET_REQUEST_SUCCESS_MESSAGE =
  "If the account is eligible, a reset code has been sent.";
const PASSWORD_RESET_CONFIRM_FAILURE_MESSAGE =
  "Reset code is invalid or has expired.";

function createError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizeEmail(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(value));
}

function generatePasswordResetCode() {
  return crypto
    .randomInt(0, 10 ** PASSWORD_RESET_CODE_LENGTH)
    .toString()
    .padStart(PASSWORD_RESET_CODE_LENGTH, "0");
}

function hashPasswordResetCode({ email, code }) {
  return crypto
    .createHash("sha256")
    .update(`${normalizeEmail(email)}:${String(code || "").trim()}`)
    .digest("hex");
}

function passwordResetCodeMatches({
  email,
  code,
  storedHash,
}) {
  const expectedHash = hashPasswordResetCode({
    email,
    code,
  });
  if (
    expectedHash.length !== storedHash.length
  ) {
    return false;
  }

  return crypto.timingSafeEqual(
    Buffer.from(expectedHash, "hex"),
    Buffer.from(storedHash, "hex"),
  );
}

function buildPasswordResetExpiry(now) {
  return new Date(
    now.getTime() +
      PASSWORD_RESET_CODE_TTL_MINUTES * 60 * 1000,
  );
}

async function sendPasswordResetCodeEmail({
  recipientEmail,
  recipientName,
  resetCode,
  expiresAt,
}) {
  const brevoApiKey = String(
    process.env.BREVO_API_KEY || "",
  ).trim();
  if (!brevoApiKey) {
    // WHY: Password reset email is a live recovery boundary, so the backend
    // must fail clearly when Brevo is not configured instead of pretending the
    // code was sent.
    throw createError(
      503,
      "Password reset email is not configured right now.",
    );
  }

  const senderEmail = normalizeEmail(
    process.env.BREVO_SENDER_EMAIL,
  );
  const senderName = String(
    process.env.BREVO_SENDER_NAME ||
      "Focus Mission",
  ).trim();
  if (!isValidEmail(senderEmail)) {
    throw createError(
      503,
      "BREVO_SENDER_EMAIL is missing or invalid.",
    );
  }

  const expiryLabel = expiresAt.toLocaleTimeString(
    "en-GB",
    {
      hour: "2-digit",
      minute: "2-digit",
    },
  );
  const textContent = [
    `Hi ${recipientName || "there"},`,
    "",
    "You asked to reset your Focus Mission password.",
    `Your 6-digit reset code is: ${resetCode}`,
    `The code expires at ${expiryLabel}.`,
    "",
    "If this was not you, you can ignore this email.",
  ].join("\n");
  const htmlContent = `
    <div style="font-family: Arial, Helvetica, sans-serif; color: #183153;">
      <p>Hi ${String(recipientName || "there").trim()},</p>
      <p>You asked to reset your Focus Mission password.</p>
      <p style="font-size: 28px; font-weight: 700; letter-spacing: 6px; margin: 20px 0;">${resetCode}</p>
      <p>The code expires at ${expiryLabel}.</p>
      <p>If this was not you, you can ignore this email.</p>
    </div>
  `;

  const response = await fetch(
    "https://api.brevo.com/v3/smtp/email",
    {
      method: "POST",
      headers: {
        "Content-Type":
          "application/json",
        accept: "application/json",
        "api-key": brevoApiKey,
      },
      body: JSON.stringify({
        sender: {
          email: senderEmail,
          name: senderName,
        },
        to: [
          {
            email: recipientEmail,
            name: recipientName,
          },
        ],
        subject:
          "Focus Mission password reset code",
        textContent,
        htmlContent,
      }),
    },
  );

  if (!response.ok) {
    const responseText =
      await response.text();
    throw createError(
      502,
      `Brevo returned ${response.status}: ${responseText || "empty response"}`,
    );
  }
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
  const subjectSpecialties = normalizeTeacherSubjectSpecialties({
    primarySubjectSpecialty: user?.subjectSpecialty,
    subjectSpecialties: user?.subjectSpecialties,
  });

  return {
    id: String(user._id),
    name: user.name,
    email: user.email,
    role: user.role,
    subjectSpecialty: subjectSpecialties.length === 0
      ? ""
      : subjectSpecialties[0],
    subjectSpecialties,
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
  const subjectSpecialties = normalizeTeacherSubjectSpecialties({
    primarySubjectSpecialty: user?.subjectSpecialty,
    subjectSpecialties: user?.subjectSpecialties,
  });

  return {
    name: String(user.name || ""),
    email: String(user.email || ""),
    role: String(user.role || ""),
    subject: subjectSpecialties.length === 0 ? "" : subjectSpecialties[0],
    subjectSpecialties,
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

function serializeAuthSession(
  user,
  {
    dailyLoginRewardGranted = false,
    dailyLoginXpAwarded = 0,
    dateKey = "",
  } = {},
) {
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

async function login({ email, password }) {
  ensureDatabaseReady();
  const normalizedEmail = normalizeEmail(email);

  const user = await User.findOne({ email: normalizedEmail }).select(
    "+passwordHash +passwordResetCodeHash +passwordResetCodeExpiresAt",
  );

  if (!user) {
    // WHY: The service returns the same message for missing users and bad
    // passwords so the login boundary does not leak which emails exist.
    throw createError(401, AUTH_GENERIC_FAILURE_MESSAGE);
  }

  if (user.isArchived === true) {
    // WHY: Archived learners must not continue into the live app even if they
    // still know their password, otherwise archived result history would keep
    // behaving like an active student account.
    throw createError(403, "This account has been archived. Contact management.");
  }

  const isPasswordValid = await bcrypt.compare(password, user.passwordHash);

  if (!isPasswordValid) {
    user.failedLoginAttempts =
      Math.max(0, Number(user.failedLoginAttempts || 0)) + 1;
    user.lastFailedLoginAt = new Date();
    // WHY: The failed-attempt counter gates password-reset access, so it must
    // be persisted before the client is told whether recovery is available.
    await user.save();
    throw createError(
      401,
      user.failedLoginAttempts >= PASSWORD_RESET_MIN_FAILED_ATTEMPTS
        ? AUTH_RESET_AVAILABLE_MESSAGE
        : AUTH_GENERIC_FAILURE_MESSAGE,
    );
  }

  const now = new Date();
  const dateKey = getDateKey(now);
  let shouldSave = false;
  let dailyLoginRewardGranted = false;
  let dailyLoginXpAwarded = 0;

  if (
    Number(user.failedLoginAttempts || 0) > 0 ||
    user.lastFailedLoginAt ||
    String(user.passwordResetCodeHash || "").trim().isNotEmpty ||
    user.passwordResetCodeExpiresAt
  ) {
    // WHY: A successful password proves account ownership again, so any
    // previous failed-attempt lockout state and reset code must be cleared.
    user.failedLoginAttempts = 0;
    user.lastFailedLoginAt = null;
    user.passwordResetCodeHash = "";
    user.passwordResetCodeExpiresAt = null;
    shouldSave = true;
  }

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

  return serializeAuthSession(user, {
    dailyLoginRewardGranted,
    dailyLoginXpAwarded,
    dateKey,
  });
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
    .select("name email role subjectSpecialty subjectSpecialties isPlaceholder")
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

async function requestPasswordResetCode({
  email,
}) {
  ensureDatabaseReady();
  const normalizedEmail = normalizeEmail(
    email,
  );
  if (!isValidEmail(normalizedEmail)) {
    throw createError(
      400,
      "A valid email is required.",
    );
  }

  const user = await User.findOne({
    email: normalizedEmail,
    isArchived: { $ne: true },
  }).select(
    "+passwordResetCodeHash +passwordResetCodeExpiresAt",
  );

  if (
    !user ||
    Number(user.failedLoginAttempts || 0) <
      PASSWORD_RESET_MIN_FAILED_ATTEMPTS
  ) {
    // WHY: Recovery requests must not reveal whether an email exists, so the
    // response stays generic when the account is missing or not yet eligible.
    return {
      message:
        PASSWORD_RESET_REQUEST_SUCCESS_MESSAGE,
    };
  }

  const now = new Date();
  const resetCode =
    generatePasswordResetCode();
  const expiresAt =
    buildPasswordResetExpiry(now);

  user.passwordResetCodeHash =
    hashPasswordResetCode({
      email: user.email,
      code: resetCode,
    });
  user.passwordResetCodeExpiresAt =
    expiresAt;
  user.passwordResetLastSentAt =
    now;
  await user.save();

  try {
    await sendPasswordResetCodeEmail({
      recipientEmail: user.email,
      recipientName: user.name,
      resetCode,
      expiresAt,
    });
  } catch (error) {
    user.passwordResetCodeHash = "";
    user.passwordResetCodeExpiresAt = null;
    await user.save();
    throw error;
  }

  return {
    message:
      PASSWORD_RESET_REQUEST_SUCCESS_MESSAGE,
  };
}

async function confirmPasswordReset({
  email,
  code,
  newPassword,
}) {
  ensureDatabaseReady();
  const normalizedEmail = normalizeEmail(
    email,
  );
  const normalizedCode = String(
    code || "",
  ).trim();

  const user = await User.findOne({
    email: normalizedEmail,
    isArchived: { $ne: true },
  }).select(
    "+passwordHash +passwordResetCodeHash +passwordResetCodeExpiresAt",
  );

  if (!user) {
    throw createError(
      400,
      PASSWORD_RESET_CONFIRM_FAILURE_MESSAGE,
    );
  }

  if (
    !user.passwordResetCodeHash ||
    !user.passwordResetCodeExpiresAt
  ) {
    throw createError(
      400,
      PASSWORD_RESET_CONFIRM_FAILURE_MESSAGE,
    );
  }

  if (
    user.passwordResetCodeExpiresAt.getTime() <
    Date.now()
  ) {
    user.passwordResetCodeHash = "";
    user.passwordResetCodeExpiresAt = null;
    await user.save();
    throw createError(
      400,
      PASSWORD_RESET_CONFIRM_FAILURE_MESSAGE,
    );
  }

  if (
    !passwordResetCodeMatches({
      email: user.email,
      code: normalizedCode,
      storedHash:
        user.passwordResetCodeHash,
    })
  ) {
    throw createError(
      400,
      PASSWORD_RESET_CONFIRM_FAILURE_MESSAGE,
    );
  }

  user.passwordHash =
    await bcrypt.hash(newPassword, 10);
  user.failedLoginAttempts = 0;
  user.lastFailedLoginAt = null;
  user.passwordResetCodeHash = "";
  user.passwordResetCodeExpiresAt = null;
  await user.save();

  // WHY: Returning a fresh authenticated session after a valid reset removes
  // the need for a second login step and keeps the reset boundary predictable.
  return login({
    email: user.email,
    password: newPassword,
  });
}

module.exports = {
  login,
  listDemoAccounts,
  getCurrentUser,
  updateAvatar,
  requestPasswordResetCode,
  confirmPasswordReset,
};
