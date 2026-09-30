/**
 * WHAT: Stores each student's Pong access and game-only progress.
 * WHY: Teacher permissions and game results must never alter academic records.
 * HOW: One school-scoped profile has an opaque public handle and a match lock.
 */
const mongoose = require('mongoose');
const { randomUUID } = require('node:crypto');
const schema = new mongoose.Schema({
  studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  handle: { type: String, default: () => randomUUID(), required: true, immutable: true },
  access: {
    enabled: { type: Boolean, default: false },
    computer: { type: Boolean, default: true },
    battles: { type: Boolean, default: false },
    lobbyVisible: { type: Boolean, default: true },
  },
  highestUnlocked: { type: Number, default: 1, min: 1, max: 15 },
  completedLevels: [{ type: Number, min: 1, max: 15 }],
  bestRally: { type: Number, default: 0 },
  computerWins: { type: Number, default: 0 },
  multiplayerWins: { type: Number, default: 0 },
  multiplayerLosses: { type: Number, default: 0 },
  matchesPlayed: { type: Number, default: 0 },
  activeMatchId: { type: mongoose.Schema.Types.ObjectId, ref: 'PongMatch', default: null },
  presenceAt: { type: Date, default: null },
  challengeAfter: { type: Date, default: null },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });
require('../utils/schoolScope').schoolScopedSchema(schema);
schema.index({ schoolId: 1, studentId: 1 }, { unique: true });
schema.index({ handle: 1 }, { unique: true });
schema.index({ schoolId: 1, 'access.enabled': 1, 'access.battles': 1, presenceAt: -1 });
module.exports = mongoose.model('PongProfile', schema);
