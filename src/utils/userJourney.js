/**
 * WHAT:
 * userJourney centralizes day-based learner journey calculations.
 * WHY:
 * Login-day count and days-since-first-login should be calculated one way
 * everywhere so student progress cards stay consistent and auditable.
 * HOW:
 * Normalize dates to start-of-day values, compute calendar differences, and
 * serialize the journey fields used by the API.
 */
const MILLISECONDS_IN_DAY = 1000 * 60 * 60 * 24;

function startOfDay(dateValue) {
  const date = new Date(dateValue);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function getCalendarDayDifference(laterDateValue, earlierDateValue) {
  const laterDate = startOfDay(laterDateValue);
  const earlierDate = startOfDay(earlierDateValue);

  return Math.round((laterDate - earlierDate) / MILLISECONDS_IN_DAY);
}

function calculateDaysSinceFirstLogin(firstLoginAt, referenceDate = new Date()) {
  if (!firstLoginAt) {
    return 0;
  }

  // WHY: The first login day counts as day one of the learner journey, not day
  // zero, so the UI reflects real onboarding progress immediately.
  return getCalendarDayDifference(referenceDate, firstLoginAt) + 1;
}

function serializeJourney(user) {
  return {
    firstLoginAt: user.firstLoginAt ? user.firstLoginAt.toISOString() : null,
    lastLoginAt: user.lastLoginAt ? user.lastLoginAt.toISOString() : null,
    loginDayCount: user.loginDayCount || 0,
    daysSinceFirstLogin: calculateDaysSinceFirstLogin(user.firstLoginAt),
  };
}

module.exports = {
  calculateDaysSinceFirstLogin,
  getCalendarDayDifference,
  serializeJourney,
};
