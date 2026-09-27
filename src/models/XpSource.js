/**
 * WHAT: Tracks the last applied total for one XP source.
 * WHY: Retries must not re-award a result; reviews apply only their correction.
 * HOW: Transactions serialize revisions against a unique student/source key.
 */
const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  sourceType: { type: String, required: true },
  sourceId: { type: String, required: true },
  total: { type: Number, required: true },
  revision: { type: Number, default: 0 },
}, { timestamps: true });
require('../utils/schoolScope').schoolScopedSchema(schema);
schema.index({ schoolId: 1, studentId: 1, sourceType: 1, sourceId: 1 }, { unique: true });
module.exports = mongoose.model('XpSource', schema);
