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
  // WHY: Multer rejects oversized payloads before the controller runs. Map
  // that trusted limit failure to a stable client response rather than a 500.
  const isFileTooLarge = error?.name === "MulterError" &&
    error?.code === "LIMIT_FILE_SIZE";
  const statusCode = isFileTooLarge ? 413 : error.statusCode || 500;

  res.status(statusCode).json({
    message: isFileTooLarge
      ? "Evidence files must be 10 MB or smaller."
      : error.message || "Internal server error.",
    statusCode,
  });
}

module.exports = {
  notFoundHandler,
  errorHandler,
};
