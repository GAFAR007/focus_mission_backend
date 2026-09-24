/**
 * WHAT:
 * accessGate.service verifies school access codes, issues short-lived gate
 * tokens, enforces group-to-role boundaries, and limits failed attempts.
 * WHY:
 * Anonymous visitors must prove school-group access before account metadata is
 * returned, without treating the gate token as a real user login.
 * HOW:
 * Prefer constant-time HMAC digest lookup for migrated groups, retain bcrypt as
 * a safe per-group migration fallback, sign an eight-hour JWT, and track failed
 * attempts per client in memory.
 */
const crypto = require("node:crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const ACCESS_GROUPS = Object.freeze(["student", "staff", "management"]);
const ACCESS_GROUP_ROLES = Object.freeze({
  student: Object.freeze(["student"]),
  staff: Object.freeze(["teacher", "mentor"]),
  management: Object.freeze(["management"]),
});
const ACCESS_CODE_HASH_ENV_BY_GROUP = Object.freeze({
  student: "FOCUS_MISSION_STUDENT_ACCESS_CODE_HASH",
  staff: "FOCUS_MISSION_STAFF_ACCESS_CODE_HASH",
  management: "FOCUS_MISSION_MANAGEMENT_ACCESS_CODE_HASH",
});
const ACCESS_CODE_HMAC_ENV_BY_GROUP = Object.freeze({
  student: "FOCUS_MISSION_STUDENT_ACCESS_CODE_HMAC",
  staff: "FOCUS_MISSION_STAFF_ACCESS_CODE_HMAC",
  management: "FOCUS_MISSION_MANAGEMENT_ACCESS_CODE_HMAC",
});
const ACCESS_CODE_HMAC_SECRET_ENV = "FOCUS_MISSION_ACCESS_CODE_HMAC_SECRET";
const HMAC_DIGEST_HEX_LENGTH = 64;
const MIN_HMAC_SECRET_LENGTH = 32;
const GATE_TOKEN_TTL_SECONDS = 8 * 60 * 60;
const FAILED_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILED_ATTEMPTS = 5;
const MAX_TRACKED_CLIENTS = 10000;
const GENERIC_REJECTION_MESSAGE = "That access code wasn't recognised.";
const failedAttemptsByClient = new Map();

function createError(statusCode, message, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function gateTokenSecret() {
  const secret = String(process.env.JWT_SECRET || "").trim();
  if (!secret) {
    // WHY: A publicly forgeable development fallback would defeat the account
    // directory boundary, so the gate requires the existing backend secret.
    throw createError(
      503,
      "School access is not configured right now.",
      "ACCESS_GATE_NOT_CONFIGURED",
    );
  }
  return secret;
}

function configuredHashes() {
  const entries = ACCESS_GROUPS.map((accessGroup) => ({
    accessGroup,
    hash: String(
      process.env[ACCESS_CODE_HASH_ENV_BY_GROUP[accessGroup]] || "",
    ).trim(),
  }));

  if (entries.some((entry) => entry.hash.length === 0)) {
    // WHY: All three groups must be configured together so deployment cannot
    // silently expose a partial or misleading school-access surface.
    throw createError(
      503,
      "School access is not configured right now.",
      "ACCESS_GATE_NOT_CONFIGURED",
    );
  }

  return entries;
}

function configuredKeyedDigests() {
  const entries = ACCESS_GROUPS.map((accessGroup) => ({
    accessGroup,
    digestHex: String(
      process.env[ACCESS_CODE_HMAC_ENV_BY_GROUP[accessGroup]] || "",
    ).trim(),
  })).filter((entry) => entry.digestHex.length > 0);

  if (entries.length === 0) {
    // WHY: Empty keyed configuration means the deployment has not started the
    // additive migration yet, so the existing bcrypt path remains authoritative.
    return { entries: [], secret: null };
  }

  const secret = String(process.env[ACCESS_CODE_HMAC_SECRET_ENV] || "").trim();
  if (secret.length < MIN_HMAC_SECRET_LENGTH) {
    // WHY: A missing or weak server-only key must fail closed instead of
    // silently downgrading a group that operators intended to migrate.
    throw createError(
      503,
      "School access is not configured right now.",
      "ACCESS_GATE_NOT_CONFIGURED",
    );
  }

  const invalidDigest = entries.some(
    ({ digestHex }) =>
      digestHex.length !== HMAC_DIGEST_HEX_LENGTH ||
      !/^[0-9a-f]+$/i.test(digestHex),
  );
  if (invalidDigest) {
    // WHY: Strict digest validation prevents malformed secret configuration
    // from producing ambiguous comparisons or an accidental authorization path.
    throw createError(
      503,
      "School access is not configured right now.",
      "ACCESS_GATE_NOT_CONFIGURED",
    );
  }

  return {
    secret,
    entries: entries.map(({ accessGroup, digestHex }) => ({
      accessGroup,
      digest: Buffer.from(digestHex, "hex"),
    })),
  };
}

function findKeyedAccessGroup(submittedCode, keyedConfiguration) {
  if (keyedConfiguration.entries.length === 0) {
    return null;
  }

  const submittedDigest = crypto
    .createHmac("sha256", keyedConfiguration.secret)
    .update(submittedCode, "utf8")
    .digest();
  let matchingAccessGroup = null;

  for (const entry of keyedConfiguration.entries) {
    // WHY: Every configured digest is compared even after a match so lookup
    // work does not reveal the configured group order through early exit.
    const matches = crypto.timingSafeEqual(submittedDigest, entry.digest);
    if (matches && matchingAccessGroup === null) {
      matchingAccessGroup = entry.accessGroup;
    }
  }

  return matchingAccessGroup;
}

function normalizedClientKey(value) {
  const key = String(value || "unknown").trim();
  return key || "unknown";
}

function activeAttemptState(clientKey, nowMs) {
  const key = normalizedClientKey(clientKey);
  const current = failedAttemptsByClient.get(key);
  if (!current || nowMs - current.startedAt >= FAILED_ATTEMPT_WINDOW_MS) {
    failedAttemptsByClient.delete(key);
    return null;
  }
  return current;
}

function assertAttemptAllowed(clientKey, nowMs) {
  const state = activeAttemptState(clientKey, nowMs);
  if (state && state.failures >= MAX_FAILED_ATTEMPTS) {
    // WHY: Rate limiting is checked before any bcrypt work so a blocked client
    // cannot keep consuming expensive comparisons or guessing group codes.
    throw createError(
      429,
      "Too many access attempts. Try again later.",
      "ACCESS_GATE_RATE_LIMITED",
    );
  }
}

function recordFailedAttempt(clientKey, nowMs) {
  const key = normalizedClientKey(clientKey);
  const current = activeAttemptState(key, nowMs);
  for (const [trackedKey, state] of failedAttemptsByClient) {
    if (nowMs - state.startedAt >= FAILED_ATTEMPT_WINDOW_MS) {
      failedAttemptsByClient.delete(trackedKey);
    }
  }
  if (!current && failedAttemptsByClient.size >= MAX_TRACKED_CLIENTS) {
    // WHY: A flood of unique client addresses must not grow process memory
    // without bound while the rate limiter protects code verification.
    const oldestKey = failedAttemptsByClient.keys().next().value;
    failedAttemptsByClient.delete(oldestKey);
  }
  failedAttemptsByClient.set(key, {
    failures: (current?.failures || 0) + 1,
    startedAt: current?.startedAt || nowMs,
  });
}

function clearFailedAttempts(clientKey) {
  failedAttemptsByClient.delete(normalizedClientKey(clientKey));
}

async function verifyAccessCode({ code, clientKey, now = new Date() }) {
  const submittedCode = String(code || "").trim();
  const nowMs = now.getTime();
  assertAttemptAllowed(clientKey, nowMs);

  const hashes = configuredHashes();
  const keyedConfiguration = configuredKeyedDigests();
  let accessGroup = findKeyedAccessGroup(submittedCode, keyedConfiguration);

  if (accessGroup === null) {
    const migratedGroups = new Set(
      keyedConfiguration.entries.map((entry) => entry.accessGroup),
    );
    const legacyHashes = hashes.filter(
      ({ accessGroup: legacyGroup }) => !migratedGroups.has(legacyGroup),
    );
    const matches = await Promise.all(
      legacyHashes.map(({ hash }) => bcrypt.compare(submittedCode, hash)),
    );
    const matchingIndex = matches.findIndex(Boolean);
    accessGroup = matchingIndex < 0
      ? null
      : legacyHashes[matchingIndex].accessGroup;
  }

  if (accessGroup === null) {
    // WHY: Failed attempts share one generic outcome and never log the supplied
    // value, its length, comparison details, or a nearly matching group.
    recordFailedAttempt(clientKey, nowMs);
    throw createError(401, GENERIC_REJECTION_MESSAGE, "ACCESS_GATE_REJECTED");
  }

  clearFailedAttempts(clientKey);
  const gateToken = jwt.sign(
    {
      scope: "school_access",
      accessGroup,
    },
    gateTokenSecret(),
    {
      expiresIn: GATE_TOKEN_TTL_SECONDS,
      issuer: "focus-mission",
      audience: "school-access",
    },
  );
  const payload = jwt.decode(gateToken);

  return {
    success: true,
    accessGroup,
    gateToken,
    expiresAt: new Date(Number(payload.exp) * 1000).toISOString(),
  };
}

function verifyGateToken(token) {
  try {
    const payload = jwt.verify(String(token || "").trim(), gateTokenSecret(), {
      issuer: "focus-mission",
      audience: "school-access",
    });
    const accessGroup = String(payload.accessGroup || "").trim().toLowerCase();

    if (payload.scope !== "school_access" || !ACCESS_GROUPS.includes(accessGroup)) {
      throw new Error("Invalid school access token scope.");
    }

    return { accessGroup };
  } catch (_error) {
    throw createError(
      401,
      "School access is required.",
      "ACCESS_GATE_REQUIRED",
    );
  }
}

function assertRoleAllowed({ accessGroup, role }) {
  const normalizedGroup = String(accessGroup || "").trim().toLowerCase();
  const normalizedRole = String(role || "").trim().toLowerCase();
  const allowedRoles = ACCESS_GROUP_ROLES[normalizedGroup] || [];

  if (!allowedRoles.includes(normalizedRole)) {
    // WHY: The backend enforces the group boundary even if a visitor manually
    // changes the requested role query instead of using the Flutter controls.
    throw createError(
      403,
      "This school access session does not allow that account group.",
      "ACCESS_GATE_ROLE_FORBIDDEN",
    );
  }

  return normalizedRole;
}

function resetRateLimitForTests() {
  failedAttemptsByClient.clear();
}

module.exports = {
  verifyAccessCode,
  verifyGateToken,
  assertRoleAllowed,
  resetRateLimitForTests,
};
