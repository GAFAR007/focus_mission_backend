/**
 * WHAT: Validates optional client request IDs for XP-bearing create operations.
 * WHY: Retrying a creation must recover its original record instead of awarding twice.
 * HOW: Bind a bounded opaque key to staff identity; never interpret it as a school.
 */
const { createHash } = require('node:crypto');
function xpRequestKey(value, actorId) {
  if (value == null || value === '') return undefined;
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{16,128}$/.test(value)) {
    throw Object.assign(new Error('Invalid idempotency key.'), { statusCode: 400 });
  }
  return createHash('sha256').update(`${actorId}:${value}`).digest('hex');
}
module.exports = { xpRequestKey };
