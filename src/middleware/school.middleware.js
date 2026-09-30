/**
 * WHAT: Establishes the server-owned school for public authentication endpoints.
 * WHY: Existing school access codes belong only to today's school; real login
 * and password recovery must also work for accounts in future schools.
 * HOW: Resolve email identities only for credential endpoints, otherwise use
 * the migrated current school. Protected routes replace this with JWT identity
 * scope; callback middleware preserves that trusted scope across stream events.
 */
const { currentSchool, resolveIdentitySchool } = require('../services/school.service');
const { runInSchool, schoolId } = require('../utils/schoolScope');
async function publicSchool(req, res, next) {
  try {
    const credentialPaths = ['/auth/login', '/auth/password-reset/request', '/auth/password-reset/confirm'];
    if (!credentialPaths.includes(req.path) && req.path !== '/auth/demo-accounts') return next();
    const school = credentialPaths.includes(req.path) && typeof req.body?.email === 'string'
      ? await resolveIdentitySchool({ email: req.body.email.trim().toLowerCase() })
      : await currentSchool();
    return runInSchool(school._id, next);
  } catch (error) { next(error); }
}
// WHY: Multipart parsers finish from stream events created outside the auth
// scope. Capture only the authenticated server context, then restore it for
// downstream validation/controllers and error handling. Never read body IDs.
function schoolBoundMiddleware(middleware) {
  return (req, res, next) => {
    try {
      const trustedSchoolId = schoolId();
      return middleware(req, res, (error) => {
        return runInSchool(trustedSchoolId, () => next(error));
      });
    } catch (error) { return next(error); }
  };
}
module.exports = { publicSchool, schoolBoundMiddleware };
