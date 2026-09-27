/**
 * WHAT: Persists school identity and the start of accurate XP tracking.
 * WHY: Account boundaries and history coverage must survive deployments.
 * HOW: A unique migration key identifies today's school without conflating future schools.
 */
const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  active: { type: Boolean, default: true },
  migrationKey: { type: String },
  xpTrackingStartedAt: { type: Date, required: true },
  migrationCompletedAt: Date,
}, { timestamps: true });
schema.index({ migrationKey: 1 }, { unique: true, sparse: true });
module.exports = mongoose.model('School', schema);
