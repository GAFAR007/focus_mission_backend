/**
 * WHAT:
 * system.controller serves the public root and health endpoints.
 * WHY:
 * Operations and local development need a tiny unauthenticated boundary to
 * confirm the API and database state before deeper flows are exercised.
 * HOW:
 * Return static app metadata from the root route and current connection state
 * from the health route.
 */
const mongoose = require("mongoose");

const READY_STATE_LABELS = {
  0: "disconnected",
  1: "connected",
  2: "connecting",
  3: "disconnecting",
};

function getRoot(_req, res) {
  res.json({
    name: "Focus Mission API",
    version: "v1",
    docsHint: "Use /api/health to confirm the server status.",
  });
}

function getHealth(_req, res) {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    database: READY_STATE_LABELS[mongoose.connection.readyState] || "unknown",
  });
}

module.exports = {
  getRoot,
  getHealth,
};
