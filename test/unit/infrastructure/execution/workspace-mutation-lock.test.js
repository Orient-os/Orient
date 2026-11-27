'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const WorkspaceMutationLock = require('../../../../src/infrastructure/execution/workspace-mutation-lock');

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orient-workspace-lock-'));
  const workspaceRoot = path.join(root, 'workspace');
  const lockDirectory = path.join(root, 'locks');
  await fs.mkdir(workspaceRoot);
  await fs.mkdir(lockDirectory, { mode: 0o700 });
  return { root, workspaceRoot, lockDirectory };
}

function spawnLockWorker({ workspaceRoot, lockDirectory, hold = false }) {
  const modulePath = path.resolve(__dirname, '../../../../src/infrastructure/execution/workspace-mutation-lock');
  const source = `
    const Lock = require(process.argv[1]);
    (async () => {
      const lock = new Lock({ workspaceRoot: process.argv[2], lockDirectory: process.argv[3] });
      const lease = await lock.acquire();
      process.stdout.write(JSON.stringify({ acquired: true, metadata: lease.metadata }) + '\\n');
      if (process.argv[4] === 'hold') {
        process.stdin.resume();
      } else {
        await lease.release();
      }
    })().catch(error => {
      process.stdout.write(JSON.stringify({ acquired: false, code: error.code || null, message: error.message }) + '\\n');
      process.exitCode = 2;
    });
  `;
  return spawn(process.execPath, ['-e', source, modulePath, workspaceRoot, lockDirectory, hold ? 'hold' : 'release'], {
    stdio: ['pipe', 'pipe', 'pipe']
  });
}

function readFirstLine(child) {
  return new Promise((resolve, reject) => {
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      output += chunk;
      const newline = output.indexOf('\\n');
      if (newline !== -1) {
        child.stdout.removeAllListeners('data');
        resolve(JSON.parse(output.slice(0, newline)));
      }
    });
    child.once('error', reject);
    child.once('exit', code => {
      if (!output.includes('\\n')) reject(new Error('worker exited without a result; code=' + code));
    });
  });
}

test('independent OS processes cannot own the same workspace mutation lock concurrently', async () => {
  const f = await fixture();
  let lease;
  let worker;
  try {
    const lock = new WorkspaceMutationLock({ workspaceRoot: f.workspaceRoot, lockDirectory: f.lockDirectory });
    lease = await lock.acquire();
    worker = spawnLockWorker({ workspaceRoot: f.workspaceRoot, lockDirectory: f.lockDirectory });
    const result = await readFirstLine(worker);
    assert.equal(result.acquired, false);
    assert.equal(result.code, 'PROJECT_WORKSPACE_MUTATION_LOCKED');
  } finally {
    if (worker && worker.exitCode === null) worker.kill('SIGKILL');
    if (lease) await lease.release();
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('a crashed owner leaves a fail-closed lock for explicit operator recovery', async () => {
  const f = await fixture();
  let worker;
  try {
    worker = spawnLockWorker({ workspaceRoot: f.workspaceRoot, lockDirectory: f.lockDirectory, hold: true });
    const first = await readFirstLine(worker);
    assert.equal(first.acquired, true);
    assert.equal(typeof first.metadata.token, 'string');
    assert.equal(typeof first.metadata.hostname, 'string');
    assert.equal(typeof first.metadata.bootId, 'string');
    assert.equal(Number.isInteger(first.metadata.pid), true);
    assert.equal(typeof first.metadata.processStartIdentity, 'string');
    worker.kill('SIGKILL');
    await new Promise(resolve => worker.once('exit', resolve));

    const contender = spawnLockWorker({ workspaceRoot: f.workspaceRoot, lockDirectory: f.lockDirectory });
    const second = await readFirstLine(contender);
    assert.equal(second.acquired, false);
    assert.equal(second.code, 'PROJECT_WORKSPACE_MUTATION_LOCKED');
    await new Promise(resolve => contender.once('exit', resolve));
  } finally {
    if (worker && worker.exitCode === null) worker.kill('SIGKILL');
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('different workspace identities are isolated even when they share lock storage', async () => {
  const f = await fixture();
  const otherWorkspace = path.join(f.root, 'other-workspace');
  await fs.mkdir(otherWorkspace);
  let first;
  let second;
  try {
    first = await new WorkspaceMutationLock({ workspaceRoot: f.workspaceRoot, lockDirectory: f.lockDirectory }).acquire();
    second = await new WorkspaceMutationLock({ workspaceRoot: otherWorkspace, lockDirectory: f.lockDirectory }).acquire();
    assert.notEqual(first.metadata.workspaceId, second.metadata.workspaceId);
  } finally {
    if (second) await second.release();
    if (first) await first.release();
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('release is ownership-bound and cannot remove a replacement lock', async () => {
  const f = await fixture();
  const lock = new WorkspaceMutationLock({ workspaceRoot: f.workspaceRoot, lockDirectory: f.lockDirectory });
  const lease = await lock.acquire();
  try {
    assert.equal(typeof lease.release, 'function');
    await lease.release();
    await assert.rejects(
      () => fs.access(lock.lockPath),
      { code: 'ENOENT' }
    );
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});
