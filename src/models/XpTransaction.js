/**
 * WHAT: Stores immutable XP deltas recorded after tracking starts.
 * WHY: Weekly rankings need dated, auditable events, including score corrections.
 * HOW: Each source revision is unique; opening balances never become weekly XP.
 */
const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  amount: { type: Number, required: true },
  sourceType: { type: String, required: true },
  sourceId: { type: String, required: true },
  revision: { type: Number, required: true },
  earnedAt: { type: Date, required: true },
}, { timestamps: true });
require('../utils/schoolScope').schoolScopedSchema(schema);
schema.index({ schoolId: 1, studentId: 1, sourceType: 1, sourceId: 1, revision: 1 }, { unique: true });
schema.index({ schoolId: 1, earnedAt: 1, studentId: 1 });
module.exports = mongoose.model('XpTransaction', schema);
