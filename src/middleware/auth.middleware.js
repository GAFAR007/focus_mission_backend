/**
 * WHAT:
 * auth.middleware authenticates bearer tokens and enforces role access checks.
 * WHY:
 * Progression, review, and mission authoring rules depend on trustworthy user
 * identity, so auth and authorization must stay explicit and centralized.
 * HOW:
 * Verify the JWT, load the user, attach a minimal request user object, then
 * reject requests whose role is outside the allowed set.
 */
const jwt = require("jsonwebtoken");

const User = require("../models/User");

function createError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function resolveAccessRole(role) {
  const normalized = String(
    role || "",
  )
    .trim()
    .toLowerCase();
  if (
    normalized === "management"
  ) {
    // WHY: Management uses the mentor workspace and permissions in MVP.
    return "mentor";
  }
  return normalized;
}

async function protect(req, _res, next) {
  try {
    const authorization = req.headers.authorization || "";

    if (!authorization.startsWith("Bearer ")) {
      // WHY: Protected routes must fail fast when the token boundary is absent,
      // otherwise unauthenticated requests could drift into progression logic.
      throw createError(401, "Authentication required.");
    }

    const token = authorization.replace("Bearer ", "").trim();
    const payload = jwt.verify(token, process.env.JWT_SECRET || "development-secret");
    const user = await User.findById(payload.sub).lean();

    if (!user) {
      throw createError(401, "User not found for this token.");
    }

    if (user.isArchived === true) {
      // WHY: Archive state must cut off active access immediately so archived
      // students cannot keep using a still-valid token after management hides
      // the account from staff and login flows.
      throw createError(403, "This account has been archived.");
    }

    req.user = {
      id: String(user._id),
      role: resolveAccessRole(
        user.role,
      ),
      sourceRole: String(
        user.role || "",
      ),
      name: user.name,
    };

    next();
  } catch (error) {
    next(createError(error.statusCode || 401, error.message || "Invalid token."));
  }
}

function authorizeRoles(...allowedRoles) {
  return (req, _res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      // WHY: Role checks protect teacher-only review and AI authoring actions
      // from being triggered by students or mentors.
      return next(createError(403, "You do not have access to this resource."));
    }

    return next();
  };
}

function authorizeSourceRoles(...allowedSourceRoles) {
  return (req, _res, next) => {
    if (
      !req.user ||
      !allowedSourceRoles.includes(
        String(req.user.sourceRole || ""),
      )
    ) {
      // WHY: Management-only routes must not become available to mentors just
      // because management is aliased to mentor for legacy MVP access checks.
      return next(
        createError(
          403,
          "You do not have access to this resource.",
        ),
      );
    }

    return next();
  };
}

module.exports = {
  protect,
  authorizeRoles,
  authorizeSourceRoles,
};
