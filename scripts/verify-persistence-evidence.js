'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { EVIDENCE } = require('../src/core/persistence/contracts/persistence-guarantee-evidence');
const { CORE_GUARANTEES } = require('../src/core/persistence/contracts/persistence-capability.constants');

const root = path.resolve(__dirname, '..');
const adapters = ['json', 'sqlite', 'postgres'];
const failures = [];
const fileResults = new Map();

function collectTests(value, output = []) {
  if (!value || typeof value !== 'object') return output;
  if (!Array.isArray(value) && typeof value.name === 'string' &&
      (value.type === 'test' || Object.prototype.hasOwnProperty.call(value, 'ok') ||
       Object.prototype.hasOwnProperty.call(value, 'status'))) {
    output.push(value);
  }
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') collectTests(child, output);
  }
  return output;
}

function isPassed(test) {
  return test.ok === true || test.status === 'passed' || test.status === 'success';
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

for (const adapter of adapters) {
  const guarantees = EVIDENCE[adapter];
  if (!guarantees) {
    failures.push({ adapter, reason: 'adapter evidence map is missing' });
    continue;
  }
  for (const guarantee of CORE_GUARANTEES) {
    const cases = guarantees[guarantee];
    if (!Array.isArray(cases) || cases.length === 0) {
      failures.push({ adapter, guarantee, reason: 'required guarantee has no behavioral test evidence' });
      continue;
    }
    for (const item of cases) {
      const absolutePath = path.resolve(root, item.file);
      if (!absolutePath.startsWith(root + path.sep) || !fs.existsSync(absolutePath)) {
        failures.push({ adapter, guarantee, file: item.file, reason: 'evidence file is missing or escapes repository root' });
        continue;
      }
      if (!fileResults.has(item.file)) fileResults.set(item.file, { absolutePath, expected: [] });
      fileResults.get(item.file).expected.push({ adapter, guarantee, testName: item.testName });
    }
  }
}

for (const [file, record] of fileResults) {
  const run = spawnSync(process.execPath, ['--test', '--test-reporter=json', file], {
    cwd: root,
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: 10 * 60 * 1000
  });
  let report = null;
  let parseError = null;
  try {
    report = JSON.parse(run.stdout || '');
  } catch (error) {
    parseError = error.message;
  }
  const tests = report ? collectTests(report) : [];
  const fileRecord = {
    file,
    sha256: sha256(record.absolutePath),
    exitCode: run.status,
    signal: run.signal || null,
    expected: [],
    stderr: (run.stderr || '').slice(-4000),
    parseError
  };

  for (const expected of record.expected) {
    const matches = tests.filter(test => test.name === expected.testName);
    const passed = matches.length === 1 && isPassed(matches[0]) && run.status === 0;
    const result = {
      ...expected,
      status: passed ? 'passed' : 'failed',
      observedMatches: matches.length
    };
    fileRecord.expected.push(result);
    if (!passed) failures.push({ ...result, file, reason: matches.length !== 1
      ? 'expected exactly one matching test in JSON reporter output'
      : 'test did not pass or its file process failed' });
  }
  if (run.error) failures.push({ file, reason: run.error.message });
  if (run.status !== 0 && !run.error) failures.push({ file, reason: 'test file process exited unsuccessfully', exitCode: run.status });
  fileResults.set(file, { ...record, result: fileRecord });
}

const results = [...fileResults.values()].map(item => item.result);
const testCount = results.reduce((sum, file) => sum + file.expected.length, 0);
const passedCount = results.reduce((sum, file) => sum + file.expected.filter(item => item.status === 'passed').length, 0);
let commit = process.env.GITHUB_SHA || null;
if (!commit) {
  const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  if (git.status === 0) commit = git.stdout.trim();
}
const attestation = {
  schemaVersion: 1,
  kind: 'orient.persistence.behavioral-conformance',
  status: failures.length === 0 && passedCount === testCount ? 'passed' : 'failed',
  subject: { repository: process.env.GITHUB_REPOSITORY || 'local', commit },
  execution: {
    workflow: process.env.GITHUB_WORKFLOW || null,
    runId: process.env.GITHUB_RUN_ID || null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT || null,
    node: process.version,
    databaseConfigured: Boolean(process.env.DATABASE_URL),
    generatedAt: new Date().toISOString()
  },
  summary: {
    adapters: adapters.length,
    guaranteesPerAdapter: CORE_GUARANTEES.length,
    evidenceCases: testCount,
    passed: passedCount,
    failed: failures.length
  },
  guarantees: Object.fromEntries(adapters.map(adapter => [
    adapter,
    Object.fromEntries(CORE_GUARANTEES.map(guarantee => [
      guarantee,
      (EVIDENCE[adapter]?.[guarantee] || []).map(item => {
        const file = results.find(entry => entry.file === item.file);
        return {
          file: item.file,
          testName: item.testName,
          fileSha256: file?.sha256 || null,
          status: file?.expected.find(test => test.testName === item.testName &&
            test.guarantee === guarantee && test.adapter === adapter)?.status || 'missing'
        };
      })
    ]))
  ])),
  files: results,
  failures
};

const output = path.resolve(root, process.env.ORIENT_PERSISTENCE_EVIDENCE_OUTPUT ||
  'artifacts/persistence-behavioral-evidence.json');
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify(attestation, null, 2) + '\n', { mode: 0o600 });
process.stdout.write(JSON.stringify({
  status: attestation.status,
  evidenceCases: testCount,
  passed: passedCount,
  failed: failures.length,
  output: path.relative(root, output)
}) + '\n');
if (attestation.status !== 'passed') process.exitCode = 1;
