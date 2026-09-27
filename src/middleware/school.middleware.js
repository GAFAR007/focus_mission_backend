/**
 * WHAT: Establishes the server-owned school for public authentication endpoints.
 * WHY: Existing school access codes belong only to today's school; real login
 * and password recovery must also work for accounts in future schools.
 * HOW: Resolve email identities only for credential endpoints, otherwise use
 * the migrated current school. Protected routes replace this with JWT identity scope.
 */
const { currentSchool, resolveIdentitySchool } = require('../services/school.service');
const { runInSchool } = require('../utils/schoolScope');
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
module.exports = { publicSchool };
