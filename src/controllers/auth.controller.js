/**
 * WHAT:
 * auth.controller exposes login, public demo-account, and current-user profile
 * handlers.
 * WHY:
 * Authentication, quick-fill login helpers, and profile updates need a thin
 * controller layer so request parsing stays separate from credential and
 * journey logic.
 * HOW:
 * Delegate to auth.service and return stable JSON payloads for login,
 * demo-account lookup, me, and avatar updates.
 */
const authService = require("../services/auth.service");

async function login(req, res, next) {
  try {
    const result = await authService.login(req.body);
    res.json(result);
  } catch (error) {
    next(error);
  }
}

async function getDemoAccounts(req, res, next) {
  try {
    const accounts = await authService.listDemoAccounts({
      role: req.query.role,
    });
    res.json({ accounts });
  } catch (error) {
    next(error);
  }
}

async function me(req, res, next) {
  try {
    const user = await authService.getCurrentUser(req.user.id);
    res.json({ user });
  } catch (error) {
    next(error);
  }
}

async function updateAvatar(req, res, next) {
  try {
    const user = await authService.updateAvatar(req.user.id, req.body);
    res.json({ user });
  } catch (error) {
    next(error);
  }
}

async function requestPasswordResetCode(req, res, next) {
  try {
    const result = await authService.requestPasswordResetCode(req.body);
    res.json(result);
  } catch (error) {
    next(error);
  }
}

async function confirmPasswordReset(req, res, next) {
  try {
    const result = await authService.confirmPasswordReset(req.body);
    res.json(result);
  } catch (error) {
    next(error);
  }
}

module.exports = {
  login,
  getDemoAccounts,
  me,
  updateAvatar,
  requestPasswordResetCode,
  confirmPasswordReset,
};
