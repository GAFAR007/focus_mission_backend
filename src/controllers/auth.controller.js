/**
 * WHAT:
 * auth.controller exposes login and current-user profile handlers.
 * WHY:
 * Authentication and profile updates need a thin controller layer so request
 * parsing stays separate from credential and journey logic.
 * HOW:
 * Delegate to auth.service and return stable JSON payloads for login, me, and
 * avatar updates.
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

module.exports = {
  login,
  me,
  updateAvatar,
};
