/**
 * WHAT:
 * accessGate.controller handles school access-code verification requests.
 * WHY:
 * Request parsing and response shaping must stay separate from access-code
 * comparison, token signing, and failed-attempt business rules.
 * HOW:
 * Pass the validated code and proxy-aware client address to the access-gate
 * service, then return only the group, signed gate token, and expiry.
 */
const accessGateService = require("../services/accessGate.service");

async function verify(req, res, next) {
  try {
    const result = await accessGateService.verifyAccessCode({
      code: req.body.code,
      clientKey: req.ip,
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
}

module.exports = {
  verify,
};
