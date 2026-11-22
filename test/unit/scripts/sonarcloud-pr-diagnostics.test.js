'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../../..');
const script = fs.readFileSync(
  path.join(root, 'scripts/ci/export-sonarcloud-pr-diagnostics.sh'),
  'utf8'
);
const workflow = fs.readFileSync(
  path.join(root, '.github/workflows/sonarcloud-pr-diagnostics.yml'),
  'utf8'
);

test('SonarCloud diagnostics request the supported new-code violation metric', () => {
  assert.match(script, /new_violations/);
  assert.match(script, /new_reliability_rating/);
  assert.doesNotMatch(script, /new_issues/);
});

test('SonarCloud diagnostics use bearer token authentication without retrying all errors', () => {
  assert.match(script, /Authorization: Bearer/);
  assert.match(script, /--retry 3/);
  assert.doesNotMatch(script, /--retry-all-errors/);
});

test('workflow checks out the selected dispatch ref so branch fixes can be validated', () => {
  assert.match(workflow, /ref: \$\{\{ github\.ref \}\}/);
});
