/**
 * WHAT: Exposes journey and leaderboard responses for authenticated users.
 * WHY: Requesters may choose a period, never a school or peer identity.
 * HOW: Validate the period and pass only the authenticated user to services.
 */
const service = require('../services/xpJourney.service');
async function leaderboard(req, res, next) {
  try {
    const period = req.query.period || 'overall';
    if (!['overall', 'weekly'].includes(period)) throw Object.assign(new Error('Invalid leaderboard period.'), { statusCode: 400 });
    res.json(await service.leaderboard({ userId: req.user.id, period }));
  } catch (error) { next(error); }
}
async function journey(req, res, next) {
  try { res.json(await service.journey(req.user.id)); } catch (error) { next(error); }
}
module.exports = { leaderboard, journey };
