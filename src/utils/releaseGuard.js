/**
 * WHAT: Rejects production startup when source and release evidence disagree.
 * WHY: Render must not serve unversioned or unvalidated application changes.
 * HOW: Verify the generated release record against every recorded source file;
 * the frontend Release Agent owns the canonical version and creates this copy.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

function normalized(file, content) {
  if (file === 'package.json' || file === 'package-lock.json') {
    const data = JSON.parse(content);
    delete data.version;
    if (data.packages?.['']) delete data.packages[''].version;
    return JSON.stringify(data);
  }
  return content;
}
function digest(file, content) {
  return crypto.createHash('sha256').update(normalized(file, content)).digest('hex');
}
function checkRelease(root = path.resolve(__dirname, '../..')) {
  const record = JSON.parse(fs.readFileSync(path.join(root, 'release.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+$/.test(record.version) || record.validation?.status !== 'passed') {
    throw new Error('A validated release record is required.');
  }
  const files = Object.keys(record.source.files);
  if (!files.includes('server.js') || !files.includes('src/utils/releaseGuard.js')) {
    throw new Error('The release source inventory is incomplete.');
  }
  for (const file of files) {
    if (file.includes('..') || path.isAbsolute(file) ||
        digest(file, fs.readFileSync(path.join(root, file))) !== record.source.files[file]) {
      throw new Error(`Unreleased application changes detected: ${file}`);
    }
  }
  // Render has a Git checkout; this also catches newly tracked source files.
  if (fs.existsSync(path.join(root, '.git'))) {
    const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
      .split('\0').filter(file => file && file !== 'release.json').sort();
    if (JSON.stringify(tracked) !== JSON.stringify(files.sort())) {
      throw new Error('Unreleased source files detected.');
    }
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (pkg.version !== record.version) throw new Error('Build version differs from the release.');
  return record;
}
if (require.main === module) {
  // Local development and hot reload do not prepare or increment releases.
  if (!process.argv.includes('--production') || process.env.NODE_ENV === 'production' || process.env.RENDER) {
    try {
      console.log(`Validated Focus Mission release v${checkRelease().version}`);
    } catch (error) {
      console.error(`Production deployment blocked: ${error.message}\nRun the Release Agent before deploying.`);
      process.exitCode = 1;
    }
  }
}
function releaseStatus() {
  const file = path.resolve(__dirname, '../../release.json');
  if (!fs.existsSync(file)) return null;
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (record.validation?.status !== 'passed') return null;
  return { version: record.version, sourceDigest: record.source.digest, commit: process.env.RENDER_GIT_COMMIT || null };
}
module.exports = { checkRelease, digest, releaseStatus };
