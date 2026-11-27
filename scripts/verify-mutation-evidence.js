'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');

const reportPath = process.argv[2] || 'reports/mutation/mutation.json';
const allowlistPath = 'security/mutation-equivalence-allowlist.json';

function fail(message) {
  process.stderr.write(message + '\n');
  process.exitCode = 1;
}

function fingerprint(file, mutant) {
  const identity = {
    file: file.replaceAll('\\', '/'),
    mutatorName: mutant.mutatorName || null,
    location: mutant.location || null,
    replacement: mutant.replacement ?? null
  };
  return crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

if (!fs.existsSync(reportPath)) {
  fail('Mutation report is missing: ' + reportPath);
  process.exit();
}

const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
const allowlist = JSON.parse(fs.readFileSync(allowlistPath, 'utf8'));
if (!Array.isArray(allowlist)) {
  fail('Mutation equivalence allowlist must be a JSON array');
  process.exit();
}

const approved = new Map();
for (const item of allowlist) {
  if (!item || typeof item.fingerprint !== 'string' ||
      !/^[a-f0-9]{64}$/.test(item.fingerprint) ||
      typeof item.reason !== 'string' || item.reason.trim().length < 20 ||
      typeof item.owner !== 'string' || !item.owner.trim() ||
      typeof item.reviewedOn !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(item.reviewedOn)) {
    fail('Each allowlist entry requires fingerprint, substantive reason, owner, and reviewedOn');
    process.exit();
  }
  if (approved.has(item.fingerprint)) {
    fail('Duplicate allowlist fingerprint: ' + item.fingerprint);
    process.exit();
  }
  approved.set(item.fingerprint, item);
}

const unresolved = [];
const consumed = new Set();
const totals = { killed: 0, survived: 0, noCoverage: 0, timeout: 0, errors: 0, ignored: 0 };

for (const [file, entry] of Object.entries(report.files || {})) {
  for (const mutant of entry.mutants || []) {
    const status = mutant.status;
    if (status === 'Killed') { totals.killed += 1; continue; }
    if (status === 'Ignored') { totals.ignored += 1; continue; }
    if (status === 'Survived') totals.survived += 1;
    else if (status === 'NoCoverage') totals.noCoverage += 1;
    else if (status === 'Timeout') totals.timeout += 1;
    else totals.errors += 1;

    const key = fingerprint(file, mutant);
    if (approved.has(key)) consumed.add(key);
    else unresolved.push({
      file,
      id: mutant.id,
      status,
      mutatorName: mutant.mutatorName,
      location: mutant.location,
      replacement: mutant.replacement,
      fingerprint: key
    });
  }
}

const stale = [...approved.keys()].filter(key => !consumed.has(key));
process.stdout.write(JSON.stringify({ totals, unresolved, staleAllowlistEntries: stale }, null, 2) + '\n');

if (unresolved.length) fail('Found ' + unresolved.length + ' untriaged non-killed mutations; add behavioral tests or a reviewed equivalence rationale.');
if (stale.length) fail('Found ' + stale.length + ' stale equivalence allowlist entries; remove or revalidate them.');
