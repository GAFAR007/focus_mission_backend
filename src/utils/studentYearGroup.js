/**
 * WHAT:
 * studentYearGroup centralizes the allowed classroom year-group values for
 * learner accounts.
 * WHY:
 * Teacher and management flows both need the same normalized student year
 * labels so profile, roster, and bulk Test/Exam assignment stay consistent.
 * HOW:
 * Expose a shared option list plus a normalizer that accepts loose user input
 * like "year6" or "Year 6" and persists the canonical "Year 6" label.
 */
const STUDENT_YEAR_GROUP_OPTIONS = Object.freeze(
  Array.from({ length: 13 }, (_, index) => `Year ${index + 1}`),
);

function createYearGroupError() {
  return new Error(
    `yearGroup must be one of: ${STUDENT_YEAR_GROUP_OPTIONS.join(", ")}.`,
  );
}

function normalizeStudentYearGroup(value, { required = false } = {}) {
  const trimmed = String(value || "").trim();

  if (!trimmed) {
    if (required) {
      throw createYearGroupError();
    }

    return "";
  }

  const match = /^year\s*(\d{1,2})$/i.exec(trimmed);
  if (!match) {
    throw createYearGroupError();
  }

  const parsedYear = Number(match[1]);
  if (!Number.isInteger(parsedYear) || parsedYear < 1 || parsedYear > 13) {
    throw createYearGroupError();
  }

  return `Year ${parsedYear}`;
}

module.exports = {
  STUDENT_YEAR_GROUP_OPTIONS,
  normalizeStudentYearGroup,
};
