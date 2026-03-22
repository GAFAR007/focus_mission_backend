/**
 * WHAT:
 * teacher.routes registers teacher-only endpoints for timetable work, mission
 * authoring, and criterion AI drafts.
 * WHY:
 * Stage 7 requires explicit teacher-only routes so AI-generated criterion drafts
 * cannot bypass the teacher approval boundary.
 * HOW:
 * Protect the routes, validate the incoming payload shape, and delegate to
 * teacher.controller.
 */
const express = require("express");
const multer = require("multer");
const {
  body,
  param,
  query,
} = require("express-validator");

const teacherController = require("../controllers/teacher.controller");
const {
  authorizeRoles,
  protect,
} = require("../middleware/auth.middleware");
const {
  validateRequest,
} = require("../middleware/validate.middleware");

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
  },
});

router.use(
  protect,
  authorizeRoles("teacher"),
);

router.get(
  "/students",
  teacherController.getStudents,
);

router.post(
  "/students",
  [
    body("name")
      .notEmpty()
      .withMessage("Name is required."),
    body("email")
      .isEmail()
      .withMessage("Valid email is required."),
    body("password")
      .isLength({ min: 8 })
      .withMessage("Password must be at least 8 characters."),
    body("yearGroup")
      .optional()
      .isString()
      .withMessage("yearGroup must be text."),
    validateRequest,
  ],
  teacherController.createStudent,
);

router.patch(
  "/students/:id/year-group",
  [
    param("id")
      .isMongoId()
      .withMessage("Valid student id is required."),
    body("yearGroup")
      .optional()
      .isString()
      .withMessage("yearGroup must be text."),
    validateRequest,
  ],
  teacherController.updateStudentYearGroup,
);

router.get(
  "/subjects",
  teacherController.getSubjects,
);

router.get(
  "/students/:id/daily-trend",
  [
    param("id")
      .isMongoId()
      .withMessage("Valid student id is required."),
    query("from")
      .optional()
      .matches(/^\d{4}-\d{2}-\d{2}$/)
      .withMessage("from must use YYYY-MM-DD format."),
    query("to")
      .optional()
      .matches(/^\d{4}-\d{2}-\d{2}$/)
      .withMessage("to must use YYYY-MM-DD format."),
    validateRequest,
  ],
  teacherController.getStudentDailyTrend,
);

router.get(
  "/students/:id/session-breakdown",
  [
    param("id")
      .isMongoId()
      .withMessage("Valid student id is required."),
    query("from")
      .optional()
      .matches(/^\d{4}-\d{2}-\d{2}$/)
      .withMessage("from must use YYYY-MM-DD format."),
    query("to")
      .optional()
      .matches(/^\d{4}-\d{2}-\d{2}$/)
      .withMessage("to must use YYYY-MM-DD format."),
    validateRequest,
  ],
  teacherController.getStudentSessionBreakdown,
);

router.get(
  "/students/:id/subjects",
  [
    param("id")
      .isMongoId()
      .withMessage("Valid student id is required."),
    query("from")
      .optional()
      .matches(/^\d{4}-\d{2}-\d{2}$/)
      .withMessage("from must use YYYY-MM-DD format."),
    query("to")
      .optional()
      .matches(/^\d{4}-\d{2}-\d{2}$/)
      .withMessage("to must use YYYY-MM-DD format."),
    validateRequest,
  ],
  teacherController.getStudentSubjectAnalytics,
);

router.get(
  "/students/:id/certification",
  [
    param("id")
      .isMongoId()
      .withMessage("Valid student id is required."),
    validateRequest,
  ],
  teacherController.getStudentCertification,
);

router.get(
  "/students/:id/results",
  [
    param("id")
      .isMongoId()
      .withMessage("Valid student id is required."),
    validateRequest,
  ],
  teacherController.getStudentResults,
);

router.patch(
  "/students/:id/subjects/:subjectId/certification-plan",
  [
    param("id")
      .isMongoId()
      .withMessage("Valid student id is required."),
    param("subjectId")
      .isMongoId()
      .withMessage("Valid subject id is required."),
    body("requiredTaskCodes")
      .isArray({ min: 1 })
      .withMessage("requiredTaskCodes must be a non-empty array."),
    body("requiredTaskCodes.*")
      .matches(/^[PMD]\d+$/i)
      .withMessage("Task codes must be like P1, P2, M1, or D1."),
    body("certificationLabel")
      .optional()
      .isString()
      .withMessage("certificationLabel must be text."),
    body("changeReason")
      .isString()
      .trim()
      .isLength({ min: 3, max: 240 })
      .withMessage("changeReason must be between 3 and 240 characters."),
    validateRequest,
  ],
  teacherController.updateStudentCertificationPlan,
);

router.get(
  "/students/:id/behaviour-trend",
  [
    param("id")
      .isMongoId()
      .withMessage("Valid student id is required."),
    query("from")
      .optional()
      .matches(/^\d{4}-\d{2}-\d{2}$/)
      .withMessage("from must use YYYY-MM-DD format."),
    query("to")
      .optional()
      .matches(/^\d{4}-\d{2}-\d{2}$/)
      .withMessage("to must use YYYY-MM-DD format."),
    validateRequest,
  ],
  teacherController.getStudentBehaviourTrend,
);

router.get(
  "/missions/drafts/:studentId",
  [
    param("studentId")
      .isMongoId()
      .withMessage(
        "Valid studentId is required.",
      ),
    validateRequest,
  ],
  teacherController.getDraftMissions,
);

router.get(
  "/missions/recent/:studentId",
  [
    param("studentId")
      .isMongoId()
      .withMessage(
        "Valid studentId is required.",
      ),
    validateRequest,
  ],
  teacherController.getRecentMissions,
);

router.post(
  "/timetable",
  [
    body("studentId")
      .isMongoId()
      .withMessage(
        "Valid studentId is required.",
      ),
    body("day")
      .notEmpty()
      .withMessage("Day is required."),
    body("morningSubject")
      .isMongoId()
      .withMessage(
        "Valid morningSubject is required.",
      ),
    body("afternoonSubject")
      .isMongoId()
      .withMessage(
        "Valid afternoonSubject is required.",
      ),
    body("morningTeacherId")
      .optional()
      .isMongoId()
      .withMessage(
        "Valid morningTeacherId is required.",
      ),
    body("afternoonTeacherId")
      .optional()
      .isMongoId()
      .withMessage(
        "Valid afternoonTeacherId is required.",
      ),
    validateRequest,
  ],
  teacherController.createTimetable,
);

router.put(
  "/students/:id/timetable-slot",
  [
    param("id")
      .isMongoId()
      .withMessage("Valid student id is required."),
    body("day")
      .isIn(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"])
      .withMessage("day must be Monday to Friday."),
    body("sessionType")
      .isIn(["morning", "afternoon"])
      .withMessage("sessionType must be morning or afternoon."),
    body("subjectId")
      .isMongoId()
      .withMessage("Valid subjectId is required."),
    body("room")
      .isString()
      .trim()
      .isLength({ min: 1, max: 120 })
      .withMessage("room must be between 1 and 120 characters."),
    validateRequest,
  ],
  teacherController.updateTimetableSlot,
);

router.post(
  "/session-log",
  [
    body("studentId")
      .isMongoId()
      .withMessage(
        "Valid studentId is required.",
      ),
    body("subjectId")
      .isMongoId()
      .withMessage(
        "Valid subjectId is required.",
      ),
    body("sessionType")
      .isIn(["morning", "afternoon"])
      .withMessage(
        "Session type must be morning or afternoon.",
      ),
    body("focusScore")
      .optional()
      .isInt({ min: 0, max: 100 })
      .withMessage(
        "Focus score must be between 0 and 100.",
      ),
    validateRequest,
  ],
  teacherController.createSessionLog,
);

router.post(
  "/ai/extract-source",
  upload.single("sourceFile"),
  [
    body("subjectId")
      .isMongoId()
      .withMessage(
        "Valid subjectId is required.",
      ),
    body("sessionType")
      .isIn(["morning", "afternoon"])
      .withMessage(
        "Session type must be morning or afternoon.",
      ),
    body("studentId")
      .optional()
      .isMongoId()
      .withMessage("Valid studentId is required."),
    body("targetDate")
      .optional()
      .matches(/^\d{4}-\d{2}-\d{2}$/)
      .withMessage("targetDate must use YYYY-MM-DD format."),
    body("title")
      .optional()
      .isString()
      .withMessage("title must be text."),
    body("draftFormat")
      .optional()
      .isIn(["QUESTIONS", "THEORY", "ESSAY_BUILDER"])
      .withMessage(
        "draftFormat must be QUESTIONS, THEORY, or ESSAY_BUILDER.",
      ),
    body("essayMode")
      .optional()
      .isIn(["NORMAL", "STRETCH_15", "STRETCH_20"])
      .withMessage(
        "essayMode must be NORMAL, STRETCH_15, or STRETCH_20.",
      ),
    body("difficulty")
      .optional()
      .isIn(["easy", "medium", "hard"])
      .withMessage("difficulty must be easy, medium, or hard."),
    body("questionCount")
      .optional()
      .isInt({ min: 2, max: 10 })
      .withMessage("questionCount must be between 2 and 10."),
    body("taskCodes")
      .optional()
      .isString()
      .withMessage("taskCodes must be a JSON string array."),
    body("missionDraftId")
      .optional()
      .isString()
      .withMessage("missionDraftId must be text."),
    body("uploadMode")
      .optional()
      .isIn(["ai_draft", "populate_draft"])
      .withMessage("uploadMode must be ai_draft or populate_draft."),
    validateRequest,
  ],
  teacherController.extractSourcePlan,
);

router.post(
  "/ai/extract-unit-source",
  upload.single("sourceFile"),
  [
    body("criterionId")
      .isMongoId()
      .withMessage(
        "Valid criterionId is required.",
      ),
    validateRequest,
  ],
  teacherController.extractCriterionSourcePlan,
);

router.post(
  "/ai/generate-learning-and-blocks",
  [
    body("criterionId")
      .isMongoId()
      .withMessage(
        "Valid criterionId is required.",
      ),
    body("unitText")
      .trim()
      .isLength({ min: 120 })
      .withMessage(
        "Unit text must be at least 120 characters long.",
      ),
    validateRequest,
  ],
  teacherController.generateLearningAndBlocksDraft,
);

router.post(
  "/approve-learning-and-blocks",
  [
    body("criterionId")
      .isMongoId()
      .withMessage(
        "Valid criterionId is required.",
      ),
    body("learningContent")
      .isObject()
      .withMessage(
        "learningContent is required.",
      ),
    body("learningContent.title")
      .trim()
      .notEmpty()
      .withMessage(
        "Learning content title is required.",
      ),
    body("learningContent.summary")
      .optional()
      .isString(),
    body("learningContent.sections")
      .isArray({ min: 2 })
      .withMessage(
        "Learning content must include at least two sections.",
      ),
    body("learningCheckBlocks")
      .isArray({ min: 3 })
      .withMessage(
        "learningCheckBlocks must include at least three items.",
      ),
    body("essayBuilderBlocks")
      .isArray({ min: 3 })
      .withMessage(
        "essayBuilderBlocks must include at least three items.",
      ),
    validateRequest,
  ],
  teacherController.approveLearningAndBlocks,
);

router.post(
  "/missions/preview",
  [
    body("studentId")
      .isMongoId()
      .withMessage(
        "Valid studentId is required.",
      ),
    body("subjectId")
      .isMongoId()
      .withMessage(
        "Valid subjectId is required.",
      ),
    body("sessionType")
      .isIn(["morning", "afternoon"])
      .withMessage(
        "Session type must be morning or afternoon.",
      ),
    body("targetDate")
      .trim()
      .isISO8601({
        strict: true,
        strictSeparator: true,
      })
      .withMessage(
        "targetDate must be a valid YYYY-MM-DD date.",
      ),
    body("title")
      .trim()
      .notEmpty()
      .withMessage(
        "Mission title is required.",
      ),
    body("unitText")
      .trim()
      .isLength({ min: 80 })
      .withMessage(
        "Unit text must be at least 80 characters long.",
      ),
    body("sourceRawText")
      .optional()
      .isString()
      .withMessage(
        "sourceRawText must be a string.",
      ),
    body("difficulty")
      .optional()
      .isIn(["easy", "medium", "hard"])
      .withMessage(
        "Difficulty must be easy, medium, or hard.",
      ),
    body("draftFormat")
      .optional()
      .isIn(["QUESTIONS", "THEORY", "ESSAY_BUILDER"])
      .withMessage(
        "draftFormat must be QUESTIONS, THEORY, or ESSAY_BUILDER.",
      ),
    body("essayMode")
      .optional()
      .isIn(["NORMAL", "STRETCH_15", "STRETCH_20"])
      .withMessage(
        "essayMode must be NORMAL, STRETCH_15, or STRETCH_20.",
      ),
    body("essayMode")
      .custom((value, { req }) => {
        const format = String(req.body?.draftFormat || "QUESTIONS")
          .trim()
          .toUpperCase();
        if (format === "ESSAY_BUILDER" && !String(value || "").trim()) {
          throw new Error(
            "essayMode is required when draftFormat is ESSAY_BUILDER.",
          );
        }
        return true;
      }),
    body("questionCount")
      .optional()
      .custom((value, { req }) => {
        const parsed = Number(value);
        const format = String(req.body?.draftFormat || "QUESTIONS")
          .trim()
          .toUpperCase();

        if (!Number.isInteger(parsed)) {
          return false;
        }

        if (format === "ESSAY_BUILDER") {
          return parsed > 0;
        }

        if (format === "THEORY") {
          return parsed >= 2 && parsed <= 5;
        }

        return [5, 8, 10].includes(parsed);
      })
      .withMessage(
        "Question count is invalid for the selected draft format.",
      ),
    body("taskCodes")
      .optional()
      .isArray({ max: 8 })
      .withMessage(
        "taskCodes must include up to 8 items.",
      ),
    body("taskCodes.*")
      .optional()
      .isString()
      .matches(/^[PMD]\d+$/i)
      .withMessage(
        "Task codes must look like P1, P2, M1, or D1.",
      ),
    body("xpReward")
      .optional()
      .custom((value) => {
        const parsed = Number(value);
        return (
          Number.isInteger(parsed) &&
          parsed >= 10 &&
          parsed <= 50 &&
          parsed % 5 === 0
        );
      })
      .withMessage(
        "XP reward must be between 10 and 50 in steps of 5.",
      ),
    validateRequest,
  ],
  teacherController.previewMission,
);

router.post(
  "/missions/generate",
  [
    body("studentId")
      .isMongoId()
      .withMessage(
        "Valid studentId is required.",
      ),
    body("subjectId")
      .isMongoId()
      .withMessage(
        "Valid subjectId is required.",
      ),
    body("sessionType")
      .isIn(["morning", "afternoon"])
      .withMessage(
        "Session type must be morning or afternoon.",
      ),
    body("targetDate")
      .trim()
      .isISO8601({
        strict: true,
        strictSeparator: true,
      })
      .withMessage(
        "targetDate must be a valid YYYY-MM-DD date.",
      ),
    body("title")
      .trim()
      .notEmpty()
      .withMessage(
        "Mission title is required.",
      ),
    body("unitText")
      .trim()
      .isLength({ min: 80 })
      .withMessage(
        "Unit text must be at least 80 characters long.",
      ),
    body("sourceRawText")
      .optional()
      .isString()
      .withMessage(
        "sourceRawText must be a string.",
      ),
    body("difficulty")
      .optional()
      .isIn(["easy", "medium", "hard"])
      .withMessage(
        "Difficulty must be easy, medium, or hard.",
      ),
    body("draftFormat")
      .optional()
      .isIn(["QUESTIONS", "THEORY", "ESSAY_BUILDER"])
      .withMessage(
        "draftFormat must be QUESTIONS, THEORY, or ESSAY_BUILDER.",
      ),
    body("essayMode")
      .optional()
      .isIn(["NORMAL", "STRETCH_15", "STRETCH_20"])
      .withMessage(
        "essayMode must be NORMAL, STRETCH_15, or STRETCH_20.",
      ),
    body("essayMode")
      .custom((value, { req }) => {
        const format = String(req.body?.draftFormat || "QUESTIONS")
          .trim()
          .toUpperCase();
        if (format === "ESSAY_BUILDER" && !String(value || "").trim()) {
          throw new Error(
            "essayMode is required when draftFormat is ESSAY_BUILDER.",
          );
        }
        return true;
      }),
    body("questionCount")
      .optional()
      .custom((value, { req }) => {
        const parsed = Number(value);
        const format = String(req.body?.draftFormat || "QUESTIONS")
          .trim()
          .toUpperCase();

        if (!Number.isInteger(parsed)) {
          return false;
        }

        if (format === "ESSAY_BUILDER") {
          return parsed > 0;
        }

        if (format === "THEORY") {
          return parsed >= 2 && parsed <= 5;
        }

        return [5, 8, 10].includes(parsed);
      })
      .withMessage(
        "Question count is invalid for the selected draft format.",
      ),
    body("taskCodes")
      .optional()
      .isArray({ max: 8 })
      .withMessage(
        "taskCodes must include up to 8 items.",
      ),
    body("taskCodes.*")
      .optional()
      .isString()
      .matches(/^[PMD]\d+$/i)
      .withMessage(
        "Task codes must look like P1, P2, M1, or D1.",
      ),
    body("xpReward")
      .optional()
      .custom((value) => {
        const parsed = Number(value);
        return (
          Number.isInteger(parsed) &&
          parsed >= 10 &&
          parsed <= 50 &&
          parsed % 5 === 0
        );
      })
      .withMessage(
        "XP reward must be between 10 and 50 in steps of 5.",
      ),
    validateRequest,
  ],
  teacherController.generateMission,
);

router.post(
  "/missions/:missionId/reextract-source",
  [
    param("missionId")
      .isMongoId()
      .withMessage(
        "Valid missionId is required.",
      ),
    validateRequest,
  ],
  teacherController.reextractMissionSource,
);

router.patch(
  "/missions/:missionId",
  [
    param("missionId")
      .isMongoId()
      .withMessage(
        "Valid missionId is required.",
      ),
    body("title")
      .optional()
      .trim()
      .notEmpty()
      .withMessage(
        "Mission title cannot be empty.",
      ),
    body("teacherNote")
      .optional()
      .isString(),
    body("sourceUnitText")
      .optional()
      .isString(),
    body("sourceRawText")
      .optional()
      .isString()
      .withMessage(
        "sourceRawText must be a string.",
      ),
    body("sessionType")
      .optional()
      .isIn(["morning", "afternoon"])
      .withMessage(
        "Session type must be morning or afternoon.",
      ),
    body("targetDate")
      .optional()
      .trim()
      .isISO8601({
        strict: true,
        strictSeparator: true,
      })
      .withMessage(
        "targetDate must be a valid YYYY-MM-DD date.",
      ),
    body("difficulty")
      .optional()
      .isIn(["easy", "medium", "hard"])
      .withMessage(
        "Difficulty must be easy, medium, or hard.",
      ),
    body("draftFormat")
      .optional()
      .isIn(["QUESTIONS", "THEORY", "ESSAY_BUILDER"])
      .withMessage(
        "draftFormat must be QUESTIONS, THEORY, or ESSAY_BUILDER.",
      ),
    body("essayMode")
      .optional()
      .isIn(["NORMAL", "STRETCH_15", "STRETCH_20"])
      .withMessage(
        "essayMode must be NORMAL, STRETCH_15, or STRETCH_20.",
      ),
    body("essayMode")
      .custom((value, { req }) => {
        const format = String(req.body?.draftFormat || "")
          .trim()
          .toUpperCase();
        if (format === "ESSAY_BUILDER" && !String(value || "").trim()) {
          throw new Error(
            "essayMode is required when draftFormat is ESSAY_BUILDER.",
          );
        }
        return true;
      }),
    body("taskCodes")
      .optional()
      .isArray({ max: 8 })
      .withMessage(
        "taskCodes must include up to 8 items.",
      ),
    body("taskCodes.*")
      .optional()
      .isString()
      .matches(/^[PMD]\d+$/i)
      .withMessage(
        "Task codes must look like P1, P2, M1, or D1.",
      ),
    body("xpReward")
      .optional()
      .custom((value) => {
        const parsed = Number(value);
        return (
          Number.isInteger(parsed) &&
          parsed >= 10 &&
          parsed <= 50 &&
          parsed % 5 === 0
        );
      })
      .withMessage(
        "XP reward must be between 10 and 50 in steps of 5.",
      ),
    body("status")
      .optional()
      .isIn(["draft", "published"])
      .withMessage(
        "Status must be draft or published.",
      ),
    body("questions")
      .optional()
      // WHY: Essay builder drafts store questions as an empty array.
      .isArray({ min: 0, max: 10 })
      .withMessage(
        "Questions must include between 0 and 10 items.",
      ),
    validateRequest,
  ],
  teacherController.updateMission,
);

router.delete(
  "/missions/:missionId",
  [
    param("missionId")
      .isMongoId()
      .withMessage(
        "Valid missionId is required.",
      ),
    validateRequest,
  ],
  teacherController.deleteMission,
);

router.get(
  "/standalone-papers/:studentId",
  [
    param("studentId")
      .isMongoId()
      .withMessage("Valid studentId is required."),
    query("paperKind")
      .optional()
      .isIn(["TEST", "EXAM", "test", "exam"])
      .withMessage("paperKind must be TEST or EXAM."),
    validateRequest,
  ],
  teacherController.getStandalonePapers,
);

router.post(
  "/standalone-papers/import",
  upload.single("sourceFile"),
  [
    body("studentId")
      .isMongoId()
      .withMessage("Valid studentId is required."),
    body("subjectId")
      .isMongoId()
      .withMessage("Valid subjectId is required."),
    body("paperKind")
      .isIn(["TEST", "EXAM", "test", "exam"])
      .withMessage("paperKind must be TEST or EXAM."),
    body("sessionType")
      .isIn(["morning", "afternoon"])
      .withMessage("sessionType must be morning or afternoon."),
    body("title")
      .optional()
      .isString()
      .withMessage("title must be a string."),
    body("targetDate")
      .optional()
      .trim()
      .isISO8601({
        strict: true,
        strictSeparator: true,
      })
      .withMessage("targetDate must be a valid YYYY-MM-DD date."),
    validateRequest,
  ],
  teacherController.uploadStandalonePaperSourceDraft,
);

router.post(
  "/standalone-papers",
  [
    body("studentId")
      .isMongoId()
      .withMessage("Valid studentId is required."),
    body("subjectId")
      .isMongoId()
      .withMessage("Valid subjectId is required."),
    body("paperKind")
      .isIn(["TEST", "EXAM"])
      .withMessage("paperKind must be TEST or EXAM."),
    body("sessionType")
      .isIn(["morning", "afternoon"])
      .withMessage("sessionType must be morning or afternoon."),
    body("title")
      .trim()
      .notEmpty()
      .withMessage("Standalone paper title is required."),
    body("teacherNote")
      .optional()
      .isString()
      .withMessage("teacherNote must be a string."),
    body("sourceUnitText")
      .optional()
      .isString()
      .withMessage("sourceUnitText must be a string."),
    body("sourceRawText")
      .optional()
      .isString()
      .withMessage("sourceRawText must be a string."),
    body("sourceFileName")
      .optional()
      .isString()
      .withMessage("sourceFileName must be a string."),
    body("sourceFileType")
      .optional()
      .isString()
      .withMessage("sourceFileType must be a string."),
    body("targetDate")
      .optional()
      .trim()
      .isISO8601({
        strict: true,
        strictSeparator: true,
      })
      .withMessage("targetDate must be a valid YYYY-MM-DD date."),
    body("durationMinutes")
      .optional()
      .isInt({ min: 0, max: 600 })
      .withMessage("durationMinutes must be between 0 and 600."),
    body("items")
      .isArray({ min: 1, max: 60 })
      .withMessage("items must include between 1 and 60 entries."),
    validateRequest,
  ],
  teacherController.createStandalonePaper,
);

router.patch(
  "/standalone-papers/:paperId",
  [
    param("paperId")
      .isMongoId()
      .withMessage("Valid paperId is required."),
    body("paperKind")
      .optional()
      .isIn(["TEST", "EXAM"])
      .withMessage("paperKind must be TEST or EXAM."),
    body("sessionType")
      .optional()
      .isIn(["morning", "afternoon"])
      .withMessage("sessionType must be morning or afternoon."),
    body("title")
      .optional()
      .trim()
      .notEmpty()
      .withMessage("Standalone paper title must not be empty."),
    body("teacherNote")
      .optional()
      .isString()
      .withMessage("teacherNote must be a string."),
    body("sourceUnitText")
      .optional()
      .isString()
      .withMessage("sourceUnitText must be a string."),
    body("sourceRawText")
      .optional()
      .isString()
      .withMessage("sourceRawText must be a string."),
    body("sourceFileName")
      .optional()
      .isString()
      .withMessage("sourceFileName must be a string."),
    body("sourceFileType")
      .optional()
      .isString()
      .withMessage("sourceFileType must be a string."),
    body("targetDate")
      .optional()
      .trim()
      .isISO8601({
        strict: true,
        strictSeparator: true,
      })
      .withMessage("targetDate must be a valid YYYY-MM-DD date."),
    body("durationMinutes")
      .optional()
      .isInt({ min: 0, max: 600 })
      .withMessage("durationMinutes must be between 0 and 600."),
    body("items")
      .optional()
      .isArray({ min: 1, max: 60 })
      .withMessage("items must include between 1 and 60 entries."),
    validateRequest,
  ],
  teacherController.updateStandalonePaper,
);

router.delete(
  "/standalone-papers/:paperId",
  [
    param("paperId")
      .isMongoId()
      .withMessage("Valid paperId is required."),
    validateRequest,
  ],
  teacherController.deleteStandalonePaper,
);

router.post(
  "/standalone-papers/:paperId/publish",
  [
    param("paperId")
      .isMongoId()
      .withMessage("Valid paperId is required."),
    validateRequest,
  ],
  teacherController.publishStandalonePaper,
);

router.post(
  "/standalone-papers/:paperId/unpublish",
  [
    param("paperId")
      .isMongoId()
      .withMessage("Valid paperId is required."),
    validateRequest,
  ],
  teacherController.unpublishStandalonePaper,
);

router.get(
  "/standalone-papers/:paperId/session",
  [
    param("paperId")
      .isMongoId()
      .withMessage("Valid paperId is required."),
    validateRequest,
  ],
  teacherController.getLatestStandalonePaperSession,
);

router.post(
  "/standalone-paper-sessions/:sessionId/reset",
  [
    param("sessionId")
      .isMongoId()
      .withMessage("Valid sessionId is required."),
    validateRequest,
  ],
  teacherController.resetStandalonePaperSession,
);

router.post(
  "/standalone-paper-sessions/:sessionId/review",
  [
    param("sessionId")
      .isMongoId()
      .withMessage("Valid sessionId is required."),
    body("reviews")
      .isArray({ min: 1, max: 60 })
      .withMessage("reviews must include between 1 and 60 theory scores."),
    body("reviews.*.itemIndex")
      .isInt({ min: 0, max: 59 })
      .withMessage("review itemIndex must be between 0 and 59."),
    body("reviews.*.scorePercent")
      .isInt({ min: 0, max: 100 })
      .withMessage("review scorePercent must be between 0 and 100."),
    body("reviews.*.feedback")
      .optional()
      .isString()
      .withMessage("review feedback must be a string."),
    validateRequest,
  ],
  teacherController.scoreStandalonePaperSession,
);

router.get(
  "/results/:resultPackageId",
  [
    param("resultPackageId")
      .isMongoId()
      .withMessage(
        "Valid resultPackageId is required.",
      ),
    validateRequest,
  ],
  teacherController.getResultPackage,
);

router.post(
  "/missions/:missionId/manual-result",
  upload.single("resultFile"),
  [
    param("missionId")
      .isMongoId()
      .withMessage(
        "Valid missionId is required.",
      ),
    validateRequest,
  ],
  teacherController.createManualResultPackage,
);

router.post(
  "/results/manual-upload",
  upload.single("resultFile"),
  [
    body("studentId")
      .isMongoId()
      .withMessage(
        "Valid studentId is required.",
      ),
    body("subjectId")
      .isMongoId()
      .withMessage(
        "Valid subjectId is required.",
      ),
    body("sessionType")
      .isIn(["morning", "afternoon"])
      .withMessage(
        "sessionType must be morning or afternoon.",
      ),
    body("targetDate")
      .matches(/^\d{4}-\d{2}-\d{2}$/)
      .withMessage(
        "targetDate must use YYYY-MM-DD format.",
      ),
    validateRequest,
  ],
  teacherController.createLessonManualResultPackage,
);

router.post(
  "/results/:resultPackageId/score-theory",
  [
    param("resultPackageId")
      .isMongoId()
      .withMessage(
        "Valid resultPackageId is required.",
      ),
    body("questions")
      .isArray({ min: 1, max: 5 })
      .withMessage(
        "questions must include between 1 and 5 theory score entries.",
      ),
    body("questions.*.questionIndex")
      .isInt({ min: 0, max: 9 })
      .withMessage(
        "questionIndex must be between 0 and 9.",
      ),
    body("questions.*.teacherScorePercent")
      .isInt({ min: 0, max: 100 })
      .withMessage(
        "teacherScorePercent must be an integer between 0 and 100.",
      ),
    body("questions.*.teacherFeedback")
      .optional()
      .isString()
      .withMessage(
        "teacherFeedback must be a string.",
      ),
    validateRequest,
  ],
  teacherController.scoreTheoryResultPackage,
);

router.post(
  "/results/:resultPackageId/score-manual",
  [
    param("resultPackageId")
      .isMongoId()
      .withMessage(
        "Valid resultPackageId is required.",
      ),
    body("scoreCorrect")
      .isInt({ min: 0, max: 100 })
      .withMessage(
        "scoreCorrect must be an integer between 0 and 100.",
      ),
    body("scoreTotal")
      .isIn([10, 30, 50, 100])
      .withMessage(
        "scoreTotal must be 10, 30, 50, or 100.",
      ),
    body("scoreCorrect")
      .custom((value, { req }) => Number(value) <= Number(req.body?.scoreTotal || 0))
      .withMessage(
        "scoreCorrect cannot be greater than scoreTotal.",
      ),
    body("teacherFeedback")
      .optional()
      .isString()
      .withMessage(
        "teacherFeedback must be a string.",
      ),
    validateRequest,
  ],
  teacherController.scoreManualResultPackage,
);

router.post(
  "/results/:resultPackageId/send",
  [
    param("resultPackageId")
      .isMongoId()
      .withMessage(
        "Valid resultPackageId is required.",
      ),
    body("recipients")
      .optional()
      .isArray({ max: 10 })
      .withMessage(
        "recipients must include up to 10 emails.",
      ),
    body("recipients.*")
      .optional()
      .isEmail()
      .withMessage(
        "Each recipient must be a valid email.",
      ),
    body("channels")
      .isObject()
      .withMessage(
        "channels object is required.",
      ),
    body("channels.inApp")
      .isBoolean()
      .withMessage(
        "channels.inApp must be true or false.",
      ),
    body("channels.email")
      .isBoolean()
      .withMessage(
        "channels.email must be true or false.",
      ),
    body("screenshotUrl")
      .optional()
      .isString()
      .withMessage(
        "screenshotUrl must be a string.",
      ),
    validateRequest,
  ],
  teacherController.sendResultPackage,
);

router.post(
  "/results/:resultPackageId/screenshot",
  upload.single("screenshotFile"),
  [
    param("resultPackageId")
      .isMongoId()
      .withMessage(
        "Valid resultPackageId is required.",
      ),
    validateRequest,
  ],
  teacherController.uploadResultScreenshot,
);

router.get(
  "/results/screenshots/:screenshotId",
  [
    param("screenshotId")
      .isMongoId()
      .withMessage(
        "Valid screenshotId is required.",
      ),
    validateRequest,
  ],
  teacherController.getResultScreenshot,
);

module.exports = router;
