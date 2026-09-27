/**
 * WHAT: Migrates the existing school and resolves trusted authentication scope.
 * WHY: Existing IDs/balances must survive while every new account has a tenant.
 * HOW: Run an idempotent startup migration before listening; resolve school from
 * persisted identity, never a client-provided school or role. Owns migration access.
 */
const mongoose = require('mongoose');
const fs = require('node:fs');
const path = require('node:path');
const School = require('../models/School');
const { runInSchool, scopeError } = require('../utils/schoolScope');
const DEFAULT_KEY = 'legacy-current-school-v1';
async function currentSchool() {
  const school = await School.findOne({ migrationKey: DEFAULT_KEY, active: true }).lean();
  if (!school?.migrationCompletedAt) throw scopeError('School migration is not ready.');
  return school;
}
async function resolveIdentitySchool(filter) {
  // WHY: Only authentication may resolve an identity before its school is known.
  // No account details from this lookup are returned to a client.
  const identity = await mongoose.model('User').collection.findOne(filter, { projection: { schoolId: 1 } });
  if (!identity) return currentSchool();
  const school = await School.findOne({ _id: identity.schoolId, active: true }).lean();
  if (!school) throw scopeError('This account has no active school.');
  return school;
}
async function migrateCurrentSchool() {
  for (const name of fs.readdirSync(path.join(__dirname, '../models')).filter(name => name.endsWith('.js'))) require(`../models/${name}`);
  // WHY: Indexes exist before concurrent servers can create the singleton school.
  for (const model of Object.values(mongoose.models)) await model.init();
  const school = await School.findOneAndUpdate({ migrationKey: DEFAULT_KEY }, { $setOnInsert: {
    name: 'Current School', active: true, xpTrackingStartedAt: new Date(),
  } }, { upsert: true, new: true });
  if (school.migrationCompletedAt) return school;
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      for (const model of Object.values(mongoose.models)) {
        if (!model.schema.path('schoolId')) continue;
        await model.collection.updateMany({ schoolId: null }, { $set: { schoolId: school._id } }, { session });
      }
      const User = mongoose.model('User');
      await User.collection.updateMany({ xpOpeningBalance: { $exists: false } }, [{ $set: {
        xpOpeningBalance: { $ifNull: ['$xp', 0] }, xpTrackingStartedAt: school.xpTrackingStartedAt,
      } }], { session });
      // WHY: Existing milestone dates are unknown: record observation, not a
      // fabricated historical crossing date. These records never award XP.
      const students = User.collection.find({ role: 'student', schoolId: school._id }, { session });
      for await (const student of students) {
        for (const threshold of [500, 1000, 1500, 3000, 5000, 6000, 10000]) {
          if (Number(student.xp || 0) < threshold) continue;
          await mongoose.model('XpAchievement').collection.updateOne({ studentId: student._id, threshold }, { $setOnInsert: {
            schoolId: school._id, studentId: student._id, threshold, achievedAt: null,
            recordedAt: school.xpTrackingStartedAt, isLegacy: true,
          } }, { upsert: true, session });
        }
      }
      await School.updateOne({ _id: school._id }, { $set: { migrationCompletedAt: new Date() } }, { session });
    });
  } finally { await session.endSession(); }
  console.info('[school] Current school migration complete; identities and balances preserved.');
  return school;
}
async function forEachActiveSchool(fn) {
  const schools = await School.find({ active: true }).lean();
  for (const school of schools) await runInSchool(school._id, fn);
}
module.exports = { migrateCurrentSchool, currentSchool, resolveIdentitySchool, forEachActiveSchool };
