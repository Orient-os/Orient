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

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise(resolve => child.once('exit', resolve));
}

function readFirstLine(child) {
  return new Promise((resolve, reject) => {
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      output += chunk;
      const newline = output.indexOf('\n');
      if (newline !== -1) {
        child.stdout.removeAllListeners('data');
        resolve(JSON.parse(output.slice(0, newline)));
      }
    });
    child.once('error', reject);
    child.once('exit', code => {
      if (!output.includes('\n')) reject(new Error('worker exited without a result; code=' + code));
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

test('release atomically retires the lock while preserving owner evidence', async () => {
  const f = await fixture();
  try {
    const lock = new WorkspaceMutationLock({ workspaceRoot: f.workspaceRoot, lockDirectory: f.lockDirectory });
    const lease = await lock.acquire();
    const retiredPath = lock.lockPath + '.released.' + lease.metadata.token;

    await lease.release();

    await assert.rejects(fs.stat(lock.lockPath), { code: 'ENOENT' });
    const retiredOwner = JSON.parse(await fs.readFile(path.join(retiredPath, 'owner.json'), 'utf8'));
    assert.equal(retiredOwner.token, lease.metadata.token);
    const nextLease = await lock.acquire();
    await nextLease.release();
  } finally {
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
    assert.equal(typeof first.metadata.pidNamespace, 'string');
    assert.equal(Number.isInteger(first.metadata.pid), true);
    assert.equal(typeof first.metadata.processStartIdentity, 'string');
    worker.kill('SIGKILL');
    await waitForExit(worker);

    const contender = spawnLockWorker({ workspaceRoot: f.workspaceRoot, lockDirectory: f.lockDirectory });
    const second = await readFirstLine(contender);
    assert.equal(second.acquired, false);
    assert.equal(second.code, 'PROJECT_WORKSPACE_MUTATION_LOCKED');
    await waitForExit(contender);
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

test('recovery refuses a live owner and requires an explicit operator decision', async () => {
  const f = await fixture();
  const lock = new WorkspaceMutationLock({ workspaceRoot: f.workspaceRoot, lockDirectory: f.lockDirectory });
  let lease;
  try {
    lease = await lock.acquire();
    assert.throws(
      () => lock.recover({
        expectedToken: lease.metadata.token,
        operatorId: 'test-operator',
        reason: 'verify active owner is never reclaimed'
      }),
      { code: 'PROJECT_WORKSPACE_LOCK_OWNER_ACTIVE' }
    );
  } finally {
    if (lease) await lease.release();
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('recovery quarantines a confirmed dead process and preserves an operator receipt', async () => {
  const f = await fixture();
  let worker;
  try {
    worker = spawnLockWorker({ workspaceRoot: f.workspaceRoot, lockDirectory: f.lockDirectory, hold: true });
    const first = await readFirstLine(worker);
    assert.equal(first.acquired, true);
    worker.kill('SIGKILL');
    await new Promise(resolve => worker.once('exit', resolve));

    const lock = new WorkspaceMutationLock({ workspaceRoot: f.workspaceRoot, lockDirectory: f.lockDirectory });
    const recovered = lock.recover({
      expectedToken: first.metadata.token,
      operatorId: 'incident-operator',
      reason: 'worker process was terminated and workspace was reviewed'
    });
    assert.equal(recovered.recovered, true);
    const record = JSON.parse(await fs.readFile(path.join(recovered.quarantinePath, 'recovery.json'), 'utf8'));
    assert.equal(record.operatorId, 'incident-operator');
    assert.equal(record.owner.token, first.metadata.token);

    const nextLease = await lock.acquire();
    await nextLease.release();
  } finally {
    if (worker && worker.exitCode === null) worker.kill('SIGKILL');
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('recovery refuses an owner recorded in a different PID namespace', async () => {
  const f = await fixture();
  let worker;
  try {
    worker = spawnLockWorker({ workspaceRoot: f.workspaceRoot, lockDirectory: f.lockDirectory, hold: true });
    const first = await readFirstLine(worker);
    worker.kill('SIGKILL');
    await waitForExit(worker);

    const lock = new WorkspaceMutationLock({ workspaceRoot: f.workspaceRoot, lockDirectory: f.lockDirectory });
    const ownerPath = path.join(lock.lockPath, 'owner.json');
    const owner = JSON.parse(await fs.readFile(ownerPath, 'utf8'));
    owner.pidNamespace = 'pid:[999999]';
    await fs.writeFile(ownerPath, JSON.stringify(owner) + '\n', { mode: 0o600 });

    assert.throws(
      () => lock.recover({
        expectedToken: first.metadata.token,
        operatorId: 'test-operator',
        reason: 'must not inspect a PID in another namespace'
      }),
      { code: 'PROJECT_WORKSPACE_LOCK_OWNER_UNKNOWN' }
    );
  } finally {
    if (worker && worker.exitCode === null) worker.kill('SIGKILL');
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('recovery resumes an identical durable decision staged before a process crash', async () => {
  const f = await fixture();
  let worker;
  try {
    worker = spawnLockWorker({ workspaceRoot: f.workspaceRoot, lockDirectory: f.lockDirectory, hold: true });
    const first = await readFirstLine(worker);
    worker.kill('SIGKILL');
    await waitForExit(worker);

    const lock = new WorkspaceMutationLock({ workspaceRoot: f.workspaceRoot, lockDirectory: f.lockDirectory });
    const staged = {
      version: 1,
      operatorId: 'test-operator',
      reason: 'resume staged recovery',
      recoveredAt: '2026-11-28T00:00:00.000Z',
      owner: first.metadata
    };
    await fs.writeFile(path.join(lock.lockPath, 'recovery.json'), JSON.stringify(staged) + '\n', { mode: 0o600 });

    const recovered = lock.recover({
      expectedToken: first.metadata.token,
      operatorId: staged.operatorId,
      reason: staged.reason
    });
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.recovery.recoveredAt, staged.recoveredAt);
    const durable = JSON.parse(await fs.readFile(path.join(recovered.quarantinePath, 'recovery.json'), 'utf8'));
    assert.equal(durable.owner.token, first.metadata.token);
  } finally {
    if (worker && worker.exitCode === null) worker.kill('SIGKILL');
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('release refuses to remove a lock whose ownership token changed', async () => {
  const f = await fixture();
  const lock = new WorkspaceMutationLock({ workspaceRoot: f.workspaceRoot, lockDirectory: f.lockDirectory });
  const lease = await lock.acquire();
  try {
    const ownerPath = path.join(lock.lockPath, 'owner.json');
    const owner = JSON.parse(await fs.readFile(ownerPath, 'utf8'));
    owner.token = '00000000-0000-4000-8000-000000000000';
    await fs.writeFile(ownerPath, JSON.stringify(owner) + '\n', { mode: 0o600 });
    await assert.rejects(
      () => lease.release(),
      { code: 'PROJECT_WORKSPACE_LOCK_OWNERSHIP_LOST' }
    );
    await fs.access(lock.lockPath);
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});
