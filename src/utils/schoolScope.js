/**
 * WHAT: Supplies school-scoped persistence and asynchronous request context.
 * WHY: Every tenant-owned query, population and write needs the same boundary.
 * HOW: Services establish a trusted school; schema hooks add immutable schoolId
 * filters. Raw collection access is reserved for migration/identity resolution.
 */
const { AsyncLocalStorage } = require('node:async_hooks');
const mongoose = require('mongoose');
const context = new AsyncLocalStorage();
function scopeError(message = 'A valid school context is required.') {
  return Object.assign(new Error(message), { statusCode: 403, code: 'SCHOOL_SCOPE_REQUIRED' });
}
function schoolId() {
  const id = context.getStore()?.schoolId;
  if (!id) throw scopeError();
  return new mongoose.Types.ObjectId(String(id));
}
function runInSchool(id, fn) {
  if (!mongoose.isValidObjectId(id)) throw scopeError();
  return context.run({ schoolId: String(id) }, async () => await fn());
}
function scopedFilter(filter = {}) { return { $and: [filter, { schoolId: schoolId() }] }; }
function assertSchool(value) {
  const id = schoolId();
  if (value && String(value) !== String(id)) throw scopeError('Cross-school writes are not permitted.');
  return id;
}
function scopeUpdate(update, upsert) {
  if (Array.isArray(update)) throw scopeError('Pipeline updates require a school-aware service.');
  for (const [key, value] of Object.entries(update || {})) {
    if (key === 'schoolId') assertSchool(value);
    if (key.startsWith('$')) for (const field of Object.keys(value || {})) {
      if (field === 'schoolId' || field.startsWith('schoolId.')) {
        if (!['$set', '$setOnInsert'].includes(key)) throw scopeError();
        assertSchool(value[field]);
      }
      if (key === '$rename' && value[field] === 'schoolId') throw scopeError();
    }
  }
  if (upsert) {
    update.$setOnInsert = { ...update.$setOnInsert, schoolId: schoolId() };
    if (update.$set?.schoolId) delete update.$setOnInsert.schoolId;
    if (update.schoolId) delete update.$setOnInsert.schoolId;
  }
  return update;
}
async function validateReferences(schema, values, session, changed = () => true) {
  session ||= mongoose.transactionAsyncLocalStorage?.getStore()?.session;
  function read(object, path) {
    if (Object.prototype.hasOwnProperty.call(object, path)) return object[path];
    return path.split('.').reduce((value, key) => value?.[key], object);
  }
  for (const [path, type] of Object.entries(schema.paths)) {
    if (path === 'schoolId' || !changed(path)) continue;
    const value = read(values, path);
    if (value == null) continue;
    if (type.schema) {
      for (const child of Array.isArray(value) ? value : [value]) {
        await validateReferences(type.schema, child, session);
      }
      continue;
    }
    const ref = type.options?.ref || type.embeddedSchemaType?.options?.ref || type.$embeddedSchemaType?.options?.ref || type.caster?.options?.ref;
    if (!ref || ref === 'School') continue;
    const input = value?.$each || value;
    const ids = (Array.isArray(input) ? input : [input]).filter(Boolean).map(item => item._id || item);
    const unique = [...new Set(ids.map(String))];
    if (!unique.length) continue;
    const model = mongoose.models[ref];
    if (!model) throw scopeError('Referenced model is not available.');
    const count = await model.collection.countDocuments({
      _id: { $in: unique.map(id => new mongoose.Types.ObjectId(id)) }, schoolId: schoolId(),
    }, { session });
    if (count !== unique.length) throw scopeError('Referenced records must belong to your school.');
  }
}
async function validateUpdateReferences(schema, update, session) {
  for (const values of [update, update?.$set, update?.$setOnInsert, update?.$push, update?.$addToSet]) {
    if (values) await validateReferences(schema, values, session);
  }
}
function schoolScopedSchema(schema) {
  schema.add({ schoolId: { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true, immutable: true, index: true } });
  schema.pre(['find', 'findOne', 'countDocuments', 'distinct', 'deleteMany', 'deleteOne', 'findOneAndDelete', 'findOneAndUpdate', 'updateOne', 'updateMany', 'replaceOne', 'findOneAndReplace'], async function() {
    this.setQuery(scopedFilter(this.getFilter()));
    const update = this.getUpdate();
    if (update) {
      if (['replaceOne', 'findOneAndReplace'].includes(this.op)) update.schoolId = assertSchool(update.schoolId);
      else scopeUpdate(update, this.getOptions().upsert);
      await validateUpdateReferences(schema, update, this.getOptions().session);
    }
  });
  schema.pre('estimatedDocumentCount', function() { throw scopeError('Use a school-scoped countDocuments query.'); });
  schema.pre('aggregate', function() {
    // WHY: Joins and write stages can bypass a top-level match; require explicit
    // service implementations before introducing any such aggregation.
    const forbidden = ['$lookup', '$unionWith', '$graphLookup', '$out', '$merge'];
    const serialized = JSON.stringify(this.pipeline());
    if (forbidden.some(stage => serialized.includes(`"${stage}"`))) throw scopeError('Cross-collection aggregation is not enabled.');
    this.pipeline().unshift({ $match: { schoolId: schoolId() } });
  });
  schema.pre('validate', function() { this.schoolId = assertSchool(this.schoolId); });
  schema.pre('save', async function() {
    this.schoolId = assertSchool(this.schoolId);
    // WHY: A hydrated document saved in another request must retain its boundary.
    this.$where = { ...this.$where, schoolId: schoolId() };
    await validateReferences(schema, this.toObject(), this.$session(), path => this.isNew || this.isModified(path));
  });
  schema.pre('deleteOne', { document: true, query: false }, function() { assertSchool(this.schoolId); });
  schema.pre('insertMany', async function(docs, options) {
    for (const doc of docs) {
      doc.schoolId = assertSchool(doc.schoolId);
      await validateReferences(schema, doc, options?.session);
    }
  });
  schema.pre('bulkWrite', async function(operations, options) {
    for (const op of operations) {
      if (op.insertOne) {
        op.insertOne.document.schoolId = assertSchool(op.insertOne.document.schoolId);
        await validateReferences(schema, op.insertOne.document, options?.session);
      }
      for (const key of ['updateOne', 'updateMany', 'deleteOne', 'deleteMany', 'replaceOne']) {
        if (!op[key]) continue;
        op[key].filter = scopedFilter(op[key].filter);
        if (op[key].update) {
          scopeUpdate(op[key].update, op[key].upsert);
          await validateUpdateReferences(schema, op[key].update, options?.session);
        }
        if (op[key].replacement) {
          op[key].replacement.schoolId = assertSchool(op[key].replacement.schoolId);
          await validateReferences(schema, op[key].replacement, options?.session);
        }
      }
    }
  });
}
module.exports = { runInSchool, schoolId, schoolScopedSchema, scopeError };
