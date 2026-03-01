/**
 * WHAT:
 * xpPolicy centralizes deterministic XP and streak rules for daily performance,
 * target stars, and subject completion rewards.
 * WHY:
 * The XP economy is used by multiple services, so calculations must stay
 * consistent and auditable from one shared boundary.
 * HOW:
 * Export constants and pure helpers for caps, proportional score XP, date keys,
 * weekly keys, and streak multiplier thresholds.
 */

const PERFORMANCE_DAILY_CAP = 100;
const ATTENDANCE_XP = 20;
const DAILY_CHALLENGE_MAX_XP = 30;
const ASSESSMENT_MAX_XP = 50;

const TARGET_STAR_XP = 5;
const TARGET_MAX_STARS = 3;
const TARGET_DAILY_CAP = 100;
const TARGET_WEEKLY_CAP = 500;
const WEEKLY_TARGET_TOTAL = 7;
const CUSTOM_WEEKLY_TARGET_TOTAL = 5;

const TARGET_TYPE_FIXED_DAILY_MISSION = "fixed_daily_mission";
const TARGET_TYPE_FIXED_ASSESSMENT = "fixed_assessment";
const TARGET_TYPE_CUSTOM = "custom";

const STREAK_CONTINUE_THRESHOLD = 70;
const STREAK_BADGE_UNLOCK_DAYS = 10;

const SUBJECT_COMPLETION_BONUS_XP = 200;

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function roundNumber(value) {
  return Math.round(Number(value) || 0);
}

function getNow() {
  // WHY: Production progression and schedules must always follow real time.
  return new Date();
}

function getDateKey(dateValue = getNow()) {
  const date = new Date(dateValue);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function parseDateKey(dateKey) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey || "").trim());

  if (!match) {
    return null;
  }

  const [, year, month, day] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day));

  if (
    date.getFullYear() !== Number(year) ||
    date.getMonth() !== Number(month) - 1 ||
    date.getDate() !== Number(day)
  ) {
    return null;
  }

  return date;
}

function getCalendarDayDifference(laterDateKey, earlierDateKey) {
  const later = parseDateKey(laterDateKey);
  const earlier = parseDateKey(earlierDateKey);

  if (!later || !earlier) {
    return 0;
  }

  const msInDay = 1000 * 60 * 60 * 24;
  const laterStart = new Date(
    later.getFullYear(),
    later.getMonth(),
    later.getDate(),
  );
  const earlierStart = new Date(
    earlier.getFullYear(),
    earlier.getMonth(),
    earlier.getDate(),
  );

  return Math.round((laterStart - earlierStart) / msInDay);
}

function getWeekKey(dateValue = getNow()) {
  const date = new Date(dateValue);
  const utcDate = new Date(
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()),
  );
  const utcWeekday = utcDate.getUTCDay() || 7;
  utcDate.setUTCDate(utcDate.getUTCDate() + 4 - utcWeekday);
  const yearStart = new Date(Date.UTC(utcDate.getUTCFullYear(), 0, 1));
  const weekNumber = Math.ceil(((utcDate - yearStart) / 86400000 + 1) / 7);

  return `${utcDate.getUTCFullYear()}-W${String(weekNumber).padStart(2, "0")}`;
}

function getWeekBounds(dateValue = getNow()) {
  const date = new Date(dateValue);
  const day = date.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const monday = new Date(date);
  monday.setDate(date.getDate() + mondayOffset);
  monday.setHours(0, 0, 0, 0);

  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);

  return {
    start: monday,
    end: sunday,
  };
}

function isAssessmentQuestionCount(questionCount) {
  return Number(questionCount) >= 10;
}

function calculateChallengeXp(scorePercentage) {
  const score = clampNumber(scorePercentage, 0, 100);
  return roundNumber(DAILY_CHALLENGE_MAX_XP * (score / 100));
}

function calculateAssessmentXp(scorePercentage) {
  const score = clampNumber(scorePercentage, 0, 100);
  return roundNumber(ASSESSMENT_MAX_XP * (score / 100));
}

function calculateTargetStarXp(stars) {
  return clampNumber(stars, 0, TARGET_MAX_STARS) * TARGET_STAR_XP;
}

function resolvePerformanceStreakMultiplier(streakCount) {
  if (streakCount >= 5) {
    return 1.2;
  }

  if (streakCount >= 3) {
    return 1.1;
  }

  return 1;
}

function calculatePerformanceXpBeforeStreak({
  attendanceXp = 0,
  challengeXp = 0,
  assessmentXp = 0,
} = {}) {
  return clampNumber(
    Number(attendanceXp || 0) +
      Number(challengeXp || 0) +
      Number(assessmentXp || 0),
    0,
    PERFORMANCE_DAILY_CAP,
  );
}

function calculatePerformanceXpWithStreak({
  attendanceXp = 0,
  challengeXp = 0,
  assessmentXp = 0,
  streakCount = 0,
} = {}) {
  const baseXp = calculatePerformanceXpBeforeStreak({
    attendanceXp,
    challengeXp,
    assessmentXp,
  });
  const multiplier = resolvePerformanceStreakMultiplier(streakCount);

  return {
    baseXp,
    multiplier,
    finalXp: clampNumber(roundNumber(baseXp * multiplier), 0, PERFORMANCE_DAILY_CAP),
  };
}

function calculateTargetXpFromStars(stars) {
  return calculateTargetStarXp(stars);
}

function calculateCompletionPercentage({
  completedCount = 0,
  totalCount = 0,
} = {}) {
  const total = Math.max(0, Number(totalCount || 0));

  if (!total) {
    return 0;
  }

  const completed = clampNumber(completedCount, 0, total);
  return roundNumber((completed / total) * 100);
}

module.exports = {
  PERFORMANCE_DAILY_CAP,
  ATTENDANCE_XP,
  DAILY_CHALLENGE_MAX_XP,
  ASSESSMENT_MAX_XP,
  TARGET_STAR_XP,
  TARGET_MAX_STARS,
  TARGET_DAILY_CAP,
  TARGET_WEEKLY_CAP,
  WEEKLY_TARGET_TOTAL,
  CUSTOM_WEEKLY_TARGET_TOTAL,
  TARGET_TYPE_FIXED_DAILY_MISSION,
  TARGET_TYPE_FIXED_ASSESSMENT,
  TARGET_TYPE_CUSTOM,
  STREAK_CONTINUE_THRESHOLD,
  STREAK_BADGE_UNLOCK_DAYS,
  SUBJECT_COMPLETION_BONUS_XP,
  clampNumber,
  roundNumber,
  getNow,
  getDateKey,
  parseDateKey,
  getCalendarDayDifference,
  getWeekKey,
  getWeekBounds,
  isAssessmentQuestionCount,
  calculateChallengeXp,
  calculateAssessmentXp,
  calculateTargetStarXp,
  calculateTargetXpFromStars,
  calculatePerformanceXpBeforeStreak,
  calculatePerformanceXpWithStreak,
  calculateCompletionPercentage,
  resolvePerformanceStreakMultiplier,
};
