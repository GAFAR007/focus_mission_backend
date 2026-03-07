/**
 * WHAT:
 * missionPassPolicy centralizes daily mission pass thresholds by question count.
 * WHY:
 * Student submission, certification tracking, and reporting must all reuse the
 * same mastery thresholds so pass/fail outcomes stay consistent and auditable.
 * HOW:
 * Expose the frozen question-count threshold table and a helper that resolves
 * how many correct answers are required for a mission to count as passed.
 */

const MISSION_REQUIRED_CORRECT_BY_TOTAL = Object.freeze({
  5: 4,
  8: 6,
  10: 7,
  15: 11,
  20: 14,
});

function calculateRequiredCorrectAnswers(totalCount) {
  const normalizedTotal = Math.max(0, Number(totalCount || 0));
  if (normalizedTotal === 0) {
    return 0;
  }

  return Number(
    MISSION_REQUIRED_CORRECT_BY_TOTAL[normalizedTotal] || 0,
  );
}

module.exports = {
  MISSION_REQUIRED_CORRECT_BY_TOTAL,
  calculateRequiredCorrectAnswers,
};
