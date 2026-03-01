/**
 * WHAT:
 * system.routes exposes the public root and health endpoints.
 * WHY:
 * The API needs a tiny unauthenticated route group for monitoring and local
 * sanity checks before protected flows are exercised.
 * HOW:
 * Register the root and health controller handlers on the router.
 */
const express = require("express");

const systemController = require("../controllers/system.controller");

const router = express.Router();

router.get("/", systemController.getRoot);
router.get("/health", systemController.getHealth);

module.exports = router;
