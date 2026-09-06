/**
 * WHAT:
 * accessGate.middleware protects pre-login account-directory requests.
 * WHY:
 * Quick Fill metadata must be available only after a valid school access code
 * has established the visitor's permitted group.
 * HOW:
 * Verify the dedicated school-access header and attach its narrow group claim
 * without creating or changing an authenticated user identity.
 */
const accessGateService = require("../services/accessGate.service");

function requireSchoolAccess(req, _res, next) {
  try {
    const gateToken = req.get("X-School-Access-Token") || "";
    req.schoolAccess = accessGateService.verifyGateToken(gateToken);
    next();
  } catch (error) {
    next(error);
  }
}

module.exports = {
  requireSchoolAccess,
};
