'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { EVIDENCE, CAPABILITY_EVIDENCE } = require('../src/core/persistence/contracts/persistence-guarantee-evidence');
const { CORE_GUARANTEES } = require('../src/core/persistence/contracts/persistence-capability.constants');

const root = path.resolve(__dirname, '..');
const adapters = ['json', 'sqlite', 'postgres'];
const failures = [];
const fileResults = new Map();

function parseTapTests(output) {
  const tests = [];
  for (const line of String(output || '').split(/\r?\n/)) {
    const match = line.match(/^\s*(ok|not ok)\s+\d+\s+-\s+(.+?)\s*$/);
    if (!match) continue;
    const name = match[2].replace(/\s+#\s+(?:SKIP|TODO)\b.*$/i, '').trim();
    tests.push({ name, status: match[1] === 'ok' ? 'passed' : 'failed' });
  }
  return tests;
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


for (const [adapter, capabilities] of Object.entries(CAPABILITY_EVIDENCE)) {
  for (const [capability, guarantees] of Object.entries(capabilities)) {
    for (const [guarantee, cases] of Object.entries(guarantees)) {
      if (!Array.isArray(cases) || cases.length === 0) {
        failures.push({ adapter, capability, guarantee, reason: 'optional capability guarantee has no behavioral test evidence' });
        continue;
      }
      for (const item of cases) {
        const absolutePath = path.resolve(root, item.file);
        if (!absolutePath.startsWith(root + path.sep) || !fs.existsSync(absolutePath)) {
          failures.push({ adapter, capability, guarantee, file: item.file, reason: 'capability evidence file is missing or escapes repository root' });
          continue;
        }
        if (!fileResults.has(item.file)) fileResults.set(item.file, { absolutePath, expected: [] });
        fileResults.get(item.file).expected.push({ adapter, capability, guarantee, testName: item.testName });
      }
    }
  }
}

for (const [file, record] of fileResults) {
  // TAP is a built-in Node test reporter across the supported Node 22/24 CI matrix.
  const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', file], {
    cwd: root,
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: 10 * 60 * 1000
  });
  const tests = parseTapTests(run.stdout);
  const fileRecord = {
    file,
    sha256: sha256(record.absolutePath),
    exitCode: run.status,
    signal: run.signal || null,
    expected: [],
    stderr: (run.stderr || '').slice(-4000),
    reporter: 'tap'
  };

  for (const expected of record.expected) {
    const matches = tests.filter(test => test.name === expected.testName);
    const passed = matches.length === 1 && matches[0].status === 'passed' && run.status === 0;
    const result = {
      ...expected,
      status: passed ? 'passed' : 'failed',
      observedMatches: matches.length
    };
    fileRecord.expected.push(result);
    if (!passed) failures.push({
      ...result,
      file,
      reason: matches.length !== 1
        ? 'expected exactly one matching test in TAP reporter output'
        : 'test did not pass or its file process failed'
    });
  }
  if (run.error) failures.push({ file, reason: run.error.message });
  if (run.status !== 0 && !run.error) {
    failures.push({ file, reason: 'test file process exited unsuccessfully', exitCode: run.status });
  }
  fileResults.set(file, { ...record, result: fileRecord });
}

const results = [...fileResults.values()].map(item => item.result);
const testCount = results.reduce((sum, file) => sum + file.expected.length, 0);
const passedCount = results.reduce((sum, file) =>
  sum + file.expected.filter(item => item.status === 'passed').length, 0);
const failedCount = testCount - passedCount;
let commit = process.env.ORIENT_EVIDENCE_SOURCE_SHA || process.env.GITHUB_SHA || null;
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
    optionalCapabilities: Object.values(CAPABILITY_EVIDENCE).reduce((sum, capabilities) => sum + Object.keys(capabilities).length, 0),
    capabilityEvidenceCases: Object.values(CAPABILITY_EVIDENCE).reduce((sum, capabilities) =>
      sum + Object.values(capabilities).reduce((capabilitySum, guarantees) =>
        capabilitySum + Object.values(guarantees).reduce((guaranteeSum, cases) => guaranteeSum + cases.length, 0), 0), 0),
    evidenceCases: testCount,
    passed: passedCount,
    failed: failedCount,
    diagnosticFailures: failures.length
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
  capabilities: Object.fromEntries(Object.entries(CAPABILITY_EVIDENCE).map(([adapter, capabilities]) => [
    adapter,
    Object.fromEntries(Object.entries(capabilities).map(([capability, guarantees]) => [
      capability,
      Object.fromEntries(Object.entries(guarantees).map(([guarantee, cases]) => [
        guarantee,
        cases.map(item => {
          const file = results.find(entry => entry.file === item.file);
          return {
            file: item.file,
            testName: item.testName,
            fileSha256: file?.sha256 || null,
            status: file?.expected.find(test => test.testName === item.testName &&
              test.guarantee === guarantee && test.capability === capability &&
              test.adapter === adapter)?.status || 'missing'
          };
        })
      ]))
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
  failed: failedCount,
  diagnosticFailures: failures.length,
  output: path.relative(root, output)
}) + '\n');
if (attestation.status !== 'passed') process.exitCode = 1;
