/**
 * WHAT: Stores explicit, expiring student Pong invitations.
 * WHY: Acceptance and rematches need ownership checks and duplicate protection.
 * HOW: A partial unique pair key permits only one pending invitation per pair.
 */
const mongoose = require('mongoose');
const { randomUUID } = require('node:crypto');
const schema = new mongoose.Schema({
  handle: { type: String, default: () => randomUUID(), required: true, immutable: true },
  challengerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  opponentId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  pairKey: { type: String, required: true },
  status: { type: String, enum: ['pending', 'accepted', 'declined', 'cancelled', 'expired'], default: 'pending' },
  expiresAt: { type: Date, required: true },
  acceptedAt: { type: Date, default: null },
  matchId: { type: mongoose.Schema.Types.ObjectId, ref: 'PongMatch', default: null },
  rematchOf: { type: mongoose.Schema.Types.ObjectId, ref: 'PongMatch', default: null },
}, { timestamps: true });
require('../utils/schoolScope').schoolScopedSchema(schema);
schema.index({ handle: 1 }, { unique: true });
schema.index({ schoolId: 1, pairKey: 1 }, { unique: true, partialFilterExpression: { status: 'pending' } });
schema.index({ schoolId: 1, status: 1, expiresAt: 1 });
module.exports = mongoose.model('PongChallenge', schema);
