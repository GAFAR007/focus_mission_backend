/**
 * WHAT: Applies auditable XP corrections and returns school-scoped rankings.
 * WHY: Existing balances are authoritative, rewards must be idempotent and
 * weekly history must never be fabricated from old results.
 * HOW: Source totals, balance deltas and first achievements share a transaction.
 * Rankings use current balances plus dated deltas and deterministic ID ties.
 */
const mongoose = require('mongoose');
const User = require('../models/User');
const School = require('../models/School');
const XpSource = require('../models/XpSource');
const XpTransaction = require('../models/XpTransaction');
const XpAchievement = require('../models/XpAchievement');
const { schoolId } = require('../utils/schoolScope');
const { getWeekBounds } = require('../utils/xpPolicy');
const MILESTONES = Object.freeze([500, 1000, 1500, 3000, 5000, 6000, 10000]);
// WHY: Existing service queries inside an award operation must participate in
// its transaction too, including reads used to calculate caps and score deltas.
mongoose.set('transactionAsyncLocalStorage', true);
function transactional(fn) {
  return async function(...args) {
    if (mongoose.connection.readyState !== 1) return fn(...args);
    if (mongoose.transactionAsyncLocalStorage?.getStore()?.session) return fn(...args);
    // WHY: Two concurrent first requests can race on a unique source/request
    // key before either sees a prior record. Retry the whole transaction so the
    // loser reads the committed record instead of repeating the award.
    for (let attempt = 0; ; attempt += 1) {
      try { return await mongoose.connection.transaction(() => fn(...args)); }
      catch (error) {
        const idempotencyConflict = error.code === 11000 && (error.keyPattern?.sourceId || error.keyPattern?.requestKey);
        if (!idempotencyConflict || attempt >= 2) throw error;
      }
    }
  };
}
async function applyXp({ studentId, sourceType, sourceId, total, previousTotal = 0, session = null, now = new Date() }) {
  session ||= mongoose.transactionAsyncLocalStorage?.getStore()?.session;
  if (!session?.inTransaction()) throw new Error('XP awards require an active transaction.');
  if (!Number.isFinite(total) || total < 0 || !sourceId) throw new Error('Invalid XP source total.');
  const student = await User.findOne({ _id: studentId, role: 'student' }).session(session);
  if (!student) throw Object.assign(new Error('Student not found.'), { statusCode: 404 });
  const key = { studentId: student._id, sourceType, sourceId: String(sourceId) };
  const source = await XpSource.findOne(key).session(session);
  // WHY: A pre-launch result may already be included in User.xp. Its previous
  // award is a baseline, never a newly earned transaction.
  const oldTotal = source ? source.total : previousTotal;
  const amount = Math.max(-Number(student.xp || 0), total - oldTotal);
  const revision = (source?.revision || 0) + 1;
  if (source && total === oldTotal) return student;
  await XpSource.updateOne(key, { $set: { total, revision } }, { upsert: true, session });
  if (amount !== 0) {
    await XpTransaction.create([{ ...key, amount, revision, earnedAt: now }], { session });
    student.xp = Number(student.xp || 0) + amount;
    await student.save({ session });
  }
  for (const threshold of MILESTONES) {
    if (student.xp < threshold) continue;
    await XpAchievement.updateOne({ studentId: student._id, threshold }, { $setOnInsert: {
      achievedAt: now, recordedAt: now, isLegacy: false,
    } }, { upsert: true, session });
  }
  return student;
}
function privateName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  return parts.length > 1 ? `${parts[0]} ${Array.from(parts.at(-1))[0]}.` : (parts[0] || 'Student');
}
async function journey(studentId) {
  const student = await User.findOne({ _id: studentId, role: 'student' }).select('xp').lean();
  if (!student) throw Object.assign(new Error('Student not found.'), { statusCode: 404 });
  const achievements = await XpAchievement.find({ studentId }).sort({ threshold: 1 }).select('threshold achievedAt recordedAt isLegacy -_id').lean();
  return { totalXp: student.xp, goalXp: 6000, achievements };
}
async function leaderboard({ userId, period = 'overall', now = new Date() }) {
  const actor = await User.findById(userId).lean();
  if (!actor || actor.isArchived) throw Object.assign(new Error('Access denied.'), { statusCode: 403 });
  const school = await School.findOne({ _id: schoolId(), active: true }).lean();
  if (!school) throw Object.assign(new Error('School not available.'), { statusCode: 403 });
  const { start, end } = getWeekBounds(now);
  const students = await User.find({ role: 'student', isArchived: { $ne: true }, isPlaceholder: { $ne: true } }).select('name xp').lean();
  const weekly = await XpTransaction.aggregate([
    { $match: { earnedAt: { $gte: start, $lte: end } } },
    { $group: { _id: '$studentId', xp: { $sum: '$amount' }, lastActivity: { $max: '$earnedAt' } } },
  ]);
  const weekById = new Map(weekly.map(row => [String(row._id), row]));
  const awards = await XpAchievement.find({ studentId: { $in: students.map(s => s._id) } }).select('studentId threshold').lean();
  const highest = new Map();
  for (const award of awards) highest.set(String(award.studentId), Math.max(highest.get(String(award.studentId)) || 0, award.threshold));
  const rows = students.map(student => {
    const id = String(student._id);
    // WHY: Teachers/mentors retain their assigned-student full-name boundary.
    const maySeeFullName = actor.role === 'management' || (['teacher', 'mentor'].includes(actor.role) && actor.assignedStudents?.some(value => String(value) === id));
    return { id, name: maySeeFullName ? student.name : privateName(student.name), totalXp: student.xp,
      weeklyXp: weekById.get(id)?.xp || 0, milestone: highest.get(id) || 0, isYou: id === String(userId) };
  });
  const field = period === 'weekly' ? 'weeklyXp' : 'totalXp';
  rows.sort((a, b) => b[field] - a[field] || a.id.localeCompare(b.id));
  // WHY: IDs are only used internally for deterministic ties; the response
  // exposes no peer identifiers, emails, scores, or contact/profile metadata.
  return { period, trackingStartedAt: school.xpTrackingStartedAt, weekStart: start, weekEnd: end,
    partialWeek: school.xpTrackingStartedAt > start,
    myRank: rows.findIndex(row => row.isYou) + 1 || null,
    entries: rows.map(({ id, ...row }, index) => ({ ...row, rank: index + 1 })) };
}
module.exports = { applyXp, transactional, journey, leaderboard, privateName, MILESTONES };
