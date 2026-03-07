/**
 * WHAT:
 * Subject is the top-level curriculum container for units and criteria.
 * WHY:
 * The frozen domain structure starts at Subject, so the model needs clear
 * documentation and stable validation at the top of the hierarchy.
 * HOW:
 * Store display metadata and default difficulty guidance that downstream units
 * and criteria can inherit without duplicating subject-level settings.
 */
const mongoose = require("mongoose");

const subjectSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    icon: {
      type: String,
      required: true,
      trim: true,
    },
    color: {
      type: String,
      default: "#7CC6FE",
    },
    difficultyDefaults: {
      type: [String],
      default: ["easy", "medium"],
      // WHY: Subject defaults provide safe starting difficulty guidance without
      // forcing every criterion to duplicate the same baseline options.
    },
    certificationEnabled: {
      type: Boolean,
      default: false,
      // WHY: Certification tracking is subject-specific and must remain
      // explicitly opt-in so existing assessment-only subjects stay unchanged.
    },
    requiredCertificationTaskCodes: {
      type: [String],
      default: [],
      validate: {
        validator(value) {
          return (
            Array.isArray(value) &&
            value.every((item) =>
              /^[PMD]\d+$/i.test(String(item || "").trim()),
            )
          );
        },
        message:
          "requiredCertificationTaskCodes must use task codes like P1, P2, M1, or D1.",
      },
      // WHY: Subject certification is unlocked by passing required task-focus
      // codes, so the template must persist the exact qualification targets.
    },
    certificationLabel: {
      type: String,
      default: "Course Certification",
      trim: true,
      // WHY: Subjects may expose a friendly certificate label in dashboards
      // without changing the underlying qualification rules.
    },
  },
  {
    timestamps: true,
  },
);

module.exports = mongoose.model("Subject", subjectSchema);
