/**
 * WHAT: Persists authoritative Pong matches and recovery snapshots.
 * WHY: Reconnects, server restarts and result retries must not invent wins.
 * HOW: School-scoped participants, a server lease and an atomic result marker.
 */
const mongoose = require('mongoose');
const { randomUUID } = require('node:crypto');
const schema = new mongoose.Schema({
  handle: { type: String, default: () => randomUUID(), required: true, immutable: true },
  mode: { type: String, enum: ['computer', 'pvp'], required: true },
  level: { type: Number, min: 0, max: 15, required: true },
  player1Id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  player2Id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  status: { type: String, enum: ['active', 'complete', 'abandoned', 'disabled'], default: 'active' },
  state: { type: mongoose.Schema.Types.Mixed, required: true },
  engineOwner: { type: String, default: null },
  leaseUntil: { type: Date, default: null },
  resultApplied: { type: Boolean, default: false },
  endedAt: { type: Date, default: null },
  reason: { type: String, default: '' },
}, { timestamps: true });
require('../utils/schoolScope').schoolScopedSchema(schema);
schema.index({ handle: 1 }, { unique: true });
schema.index({ schoolId: 1, status: 1, leaseUntil: 1 });
module.exports = mongoose.model('PongMatch', schema);
