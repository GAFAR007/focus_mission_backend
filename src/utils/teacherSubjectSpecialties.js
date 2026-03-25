/**
 * WHAT:
 * teacherSubjectSpecialties normalizes teacher subject lists for multi-subject
 * ownership checks and safe serialization.
 * WHY:
 * The product now supports one teacher teaching more than one canonical
 * subject, but older records still only store one primary subjectSpecialty.
 * HOW:
 * Build one deduplicated subject list from the primary specialty plus any
 * explicit additional specialties, then expose helpers for match checks.
 */
function normalizeTeacherSubjectSpecialties({
  primarySubjectSpecialty,
  subjectSpecialties,
} = {}) {
  const values = [
    String(primarySubjectSpecialty || "").trim(),
    ...(Array.isArray(subjectSpecialties) ? subjectSpecialties : []).map(
      (value) => String(value || "").trim(),
    ),
  ];
  const unique = [];

  for (const value of values) {
    if (!value || unique.includes(value)) {
      continue;
    }
    unique.push(value);
  }

  return unique;
}

function normalizeSubjectMatchValue(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function teacherCanTeachSubjectName({
  teacher,
  subjectName,
}) {
  const normalizedSubject = normalizeSubjectMatchValue(subjectName);
  if (!normalizedSubject) {
    return false;
  }

  return normalizeTeacherSubjectSpecialties({
    primarySubjectSpecialty: teacher?.subjectSpecialty,
    subjectSpecialties: teacher?.subjectSpecialties,
  }).some(
    (specialty) => normalizeSubjectMatchValue(specialty) === normalizedSubject,
  );
}

module.exports = {
  normalizeTeacherSubjectSpecialties,
  normalizeSubjectMatchValue,
  teacherCanTeachSubjectName,
};
