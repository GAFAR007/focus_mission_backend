/**
 * WHAT: Shared mission naming for API presentation, creation and result exports.
 * WHY: Titles identify structured work while custom titles and saved evidence
 * remain intact; neither question count nor a session determines mission type.
 * HOW: Pure formatting replaces exact defaults/canonical generated syntax only.
 */
function missionTypeLabel(type) {
  return { QUESTIONS: "Objective", OBJECTIVE: "Objective", THEORY: "Theory",
    ESSAY_BUILDER: "Essay", ESSAY: "Essay" }[String(type || "").trim().toUpperCase()] || "";
}

function isGeneratedMissionTitle(title, subject = "") {
  const normalize = (value) => String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
  const value = normalize(title);
  const subjectName = normalize(subject);
  const defaults = ["", "mission", "morning mission", "afternoon mission", "practice mission"];
  return defaults.includes(value) ||
    (subjectName && defaults.slice(1).some((suffix) => value === `${subjectName} ${suffix}`)) ||
    /^(?:(?:[pmd]\d+)(?: \+ [pmd]\d+)* )?(?:objective q\d+|theory q\d+|essay)$/.test(value);
}

function missionDisplayName({ title = "", type, taskCodes = [], questionCount, subject = "" }) {
  const label = missionTypeLabel(type);
  if (!label || !isGeneratedMissionTitle(title, subject)) return String(title || "").trim() || "Mission";
  const codes = [...new Set(taskCodes.map((code) => String(code).trim().toUpperCase()).filter(Boolean))];
  return [codes.join(" + "), label,
    label !== "Essay" && Number.isInteger(questionCount) && questionCount > 0 ? `Q${questionCount}` : "",
  ].filter(Boolean).join(" ");
}

function missionName(mission, subject = "") {
  return missionDisplayName({ title: mission?.title, type: mission?.draftFormat,
    taskCodes: mission?.taskCodes || [], questionCount: mission?.questions?.length,
    subject: subject || mission?.subjectId?.name || mission?.subject?.name || "" });
}

function resultMissionName(resultPackage) {
  const meta = resultPackage?.meta || {};
  if (resultPackage?.resultKind === "paper_assessment") return meta.missionTitle || "Assessment";
  return missionDisplayName({ title: meta.missionTitle, type: resultPackage?.missionType,
    taskCodes: meta.taskCodes || [], subject: meta.subject,
    questionCount: resultPackage?.evidence?.questions?.length });
}

module.exports = { missionDisplayName, missionName, resultMissionName, missionTypeLabel, isGeneratedMissionTitle };
