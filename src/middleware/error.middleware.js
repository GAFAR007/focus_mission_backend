/**
 * WHAT:
 * error.middleware translates route misses and thrown errors into stable JSON
 * API responses.
 * WHY:
 * The frontend and automated tests need predictable error payloads instead of
 * unstructured Express defaults.
 * HOW:
 * Build a 404 error for unknown routes, then serialize all downstream errors
 * into a `{ message, statusCode }` response.
 */
function notFoundHandler(req, _res, next) {
  const error = new Error(`Route not found: ${req.method} ${req.originalUrl}`);
  error.statusCode = 404;
  next(error);
}

function errorHandler(error, _req, res, _next) {
  const statusCode = error.statusCode || 500;

  res.status(statusCode).json({
    message: error.message || "Internal server error.",
    statusCode,
  });
}

module.exports = {
  notFoundHandler,
  errorHandler,
};
