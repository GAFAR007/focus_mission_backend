/**
 * WHAT:
 * validate.middleware converts express-validator failures into one structured
 * API error.
 * WHY:
 * Validation is a core boundary across auth, AI authoring, and progression
 * routes, so request rejection must be consistent and auditable.
 * HOW:
 * Read validationResult, short-circuit clean requests, and forward a 422 error
 * with the collected field details when input is invalid.
 */
const { validationResult } = require("express-validator");

function validateRequest(req, _res, next) {
  const errors = validationResult(req);

  if (errors.isEmpty()) {
    return next();
  }

  // WHY: A single 422 payload gives the frontend one predictable format for
  // field-level errors instead of scattering validation logic across screens.
  const error = new Error("Validation failed.");
  error.statusCode = 422;
  error.details = errors.array();

  return next(error);
}

module.exports = {
  validateRequest,
};
