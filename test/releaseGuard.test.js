/**
 * WHAT: Checks the production guard against changed, added and missing source.
 * WHY: Compilation alone cannot authorize a production release.
 * HOW: Validate a synthetic manifest in an isolated temporary Git repository.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { checkRelease, digest } = require('../src/utils/releaseGuard');

test('production guard requires validated matching version and complete source', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-guard-'));
  const sources = { 'server.js': '// fixture', 'src/utils/releaseGuard.js': '// fixture guard', 'package.json': '{"name":"fixture","version":"2.1.0"}' };
  const record = { version: '2.1.0', validation: { status: 'passed' }, source: { files: Object.fromEntries(Object.entries(sources).map(([file, content]) => [file, digest(file, content)])) } };
  const save = () => fs.writeFileSync(path.join(root, 'release.json'), JSON.stringify(record));
  try {
    for (const [file, content] of Object.entries(sources)) { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), content); }
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['add', '.'], { cwd: root });
    save(); assert.equal(checkRelease(root).version, '2.1.0');
    fs.writeFileSync(path.join(root, 'server.js'), '// changed');
    assert.throws(() => checkRelease(root), /Unreleased/);
    fs.writeFileSync(path.join(root, 'server.js'), sources['server.js']);
    record.validation.status = 'pending'; save();
    assert.throws(() => checkRelease(root), /validated release/);
    record.validation.status = 'passed'; save();
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"fixture","version":"2.2.0"}');
    assert.throws(() => checkRelease(root), /Build version/);
    fs.writeFileSync(path.join(root, 'package.json'), sources['package.json']);
    fs.writeFileSync(path.join(root, 'new.js'), '// new source'); execFileSync('git', ['add', 'new.js'], { cwd: root });
    assert.throws(() => checkRelease(root), /Unreleased source files/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
