/**
 * WHAT: Reproduces stream callback context loss and checks per-request isolation.
 * WHY: All upload-based mission and evidence flows must retain authenticated scope.
 * HOW: Send real multipart requests through Multer with two synthetic schools;
 * assert completion and error callbacks retain only their original server scope.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const multer = require('multer');
const { runInSchool, schoolId } = require('../src/utils/schoolScope');
const { schoolBoundMiddleware } = require('../src/middleware/school.middleware');

test('multipart completion and errors retain independent authenticated school contexts', async () => {
  const schools = ['000000000000000000000001', '000000000000000000000002'];
  const app = express();
  // These paths stand in for two already-authenticated identities in this fixture.
  app.use((req, res, next) => runInSchool(schools[req.path === '/a' ? 0 : 1], next));
  app.post(['/a', '/b'], schoolBoundMiddleware(multer({ storage: multer.memoryStorage(), limits: { fileSize: 32 } }).single('sourceFile')),
    (req, res) => res.json({ schoolId: String(schoolId()), text: req.file.buffer.toString() }));
  app.use((err, req, res, next) => res.status(400).json({ schoolId: String(schoolId()), code: err.code }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    async function upload(path, text) {
      const form = new FormData();
      form.set('schoolId', schools[1]); // A client cannot switch the trusted scope.
      form.set('sourceFile', new Blob([text]), 'lesson.txt');
      const res = await fetch(`http://127.0.0.1:${server.address().port}/${path}`, { method: 'POST', body: form });
      return { status: res.status, body: await res.json() };
    }
    const replies = await Promise.all(Array.from({ length: 12 }, (_, i) => upload(i % 2 ? 'b' : 'a', `lesson-${i}`)));
    replies.forEach((reply, i) => { assert.equal(reply.status, 200); assert.equal(reply.body.schoolId, schools[i % 2]); });
    const error = await upload('a', 'x'.repeat(40));
    assert.equal(error.status, 400); assert.equal(error.body.code, 'LIMIT_FILE_SIZE'); assert.equal(error.body.schoolId, schools[0]);
    assert.throws(schoolId, /school context/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
