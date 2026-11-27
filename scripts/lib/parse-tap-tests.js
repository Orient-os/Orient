'use strict';

function parseTapTests(output) {
  const tests = [];
  for (const line of String(output || '').split(/\r?\n/)) {
    const match = line.match(/^\s*(ok|not ok)\s+\d+\s+-\s+(.+?)\s*$/);
    if (!match) continue;
    const directive = match[2].match(/\s+#\s+(SKIP|TODO)\b/i);
    const name = match[2].replace(/\s+#\s+(?:SKIP|TODO)\b.*$/i, '').trim();
    const status = match[1] !== 'ok'
      ? 'failed'
      : directive
        ? directive[1].toUpperCase() === 'SKIP' ? 'skipped' : 'todo'
        : 'passed';
    tests.push({ name, status });
  }
  return tests;
}

module.exports = parseTapTests;
