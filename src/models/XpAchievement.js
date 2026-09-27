/**
 * WHAT: Records a student's first observed milestone achievement.
 * WHY: Refreshes and later score corrections must not erase or duplicate badges.
 * HOW: A unique student/threshold key stores crossing dates, or an explicitly
 * unknown achievedAt for pre-launch milestones with an observation timestamp.
 */
const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  threshold: { type: Number, enum: [500, 1000, 1500, 3000, 5000, 6000, 10000], required: true },
  achievedAt: { type: Date, default: null },
  recordedAt: { type: Date, required: true },
  isLegacy: { type: Boolean, default: false },
}, { timestamps: true });
require('../utils/schoolScope').schoolScopedSchema(schema);
schema.index({ studentId: 1, threshold: 1 }, { unique: true });
module.exports = mongoose.model('XpAchievement', schema);
