'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const parseTapTests = require('../../../scripts/lib/parse-tap-tests');

test('TAP parser distinguishes passed, skipped, TODO, and failed evidence cases', () => {
  const parsed = parseTapTests([
    'ok 1 - core guarantee holds',
    'ok 2 - optional integration # SKIP database unavailable',
    'not ok 3 - terminal transition is safe',
    'ok 4 - future behavior # TODO implement after migration'
  ].join('\n'));

  assert.deepEqual(parsed, [
    { name: 'core guarantee holds', status: 'passed' },
    { name: 'optional integration', status: 'skipped' },
    { name: 'terminal transition is safe', status: 'failed' },
    { name: 'future behavior', status: 'todo' }
  ]);
});
