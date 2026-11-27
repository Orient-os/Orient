'use strict';

const path = require('node:path');
const WorkspaceMutationLock = require('../src/infrastructure/execution/workspace-mutation-lock');

function parseArgs(argv) {
  const values = new Map();
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) throw new Error('Unexpected argument: ' + argument);
    if (argument === '--inspect' || argument === '--recover') {
      if (flags.has(argument)) throw new Error('Duplicate flag: ' + argument);
      flags.add(argument);
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error('Missing value for ' + argument);
    if (values.has(argument)) throw new Error('Duplicate option: ' + argument);
    values.set(argument, value);
    index += 1;
  }
  return { values, flags };
}

function required(values, name) {
  const value = values.get(name);
  if (!value || !value.trim()) throw new Error(name + ' is required');
  return value;
}

async function main() {
  const { values, flags } = parseArgs(process.argv.slice(2));
  if (flags.size !== 1) throw new Error('Specify exactly one of --inspect or --recover');
  const workspaceRoot = path.resolve(required(values, '--workspace'));
  const lockDirectory = path.resolve(required(values, '--lock-directory'));
  const lock = new WorkspaceMutationLock({ workspaceRoot, lockDirectory });

  if (flags.has('--inspect')) {
    const owner = lock.inspect();
    process.stdout.write(JSON.stringify({ locked: Boolean(owner), owner }, null, 2) + '\n');
    return;
  }

  if (required(values, '--confirm-recovery') !== 'RECOVER-WORKSPACE-LOCK') {
    throw new Error('Recovery requires --confirm-recovery RECOVER-WORKSPACE-LOCK');
  }
  const result = lock.recover({
    expectedToken: required(values, '--expected-token'),
    operatorId: required(values, '--operator'),
    reason: required(values, '--reason')
  });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

main().catch(error => {
  process.stderr.write(JSON.stringify({
    error: error.message,
    code: error.code || 'PROJECT_WORKSPACE_LOCK_RECOVERY_FAILED'
  }) + '\n');
  process.exitCode = 1;
});
