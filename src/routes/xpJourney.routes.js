/**
 * WHAT: Registers authenticated XP journey endpoints.
 * WHY: Rankings are school-owned data and individual journeys are self-only.
 * HOW: Reuse existing authentication and role middleware, then delegate.
 */
const router = require('express').Router();
const { protect, authorizeRoles } = require('../middleware/auth.middleware');
const controller = require('../controllers/xpJourney.controller');
router.use(protect);
router.get('/leaderboard', authorizeRoles('student', 'teacher', 'mentor'), controller.leaderboard);
router.get('/journey', authorizeRoles('student'), controller.journey);
module.exports = router;
