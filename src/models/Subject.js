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
  },
  {
    timestamps: true,
  },
);

module.exports = mongoose.model("Subject", subjectSchema);
