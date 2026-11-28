'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const WorkspaceMutationLock = require('../../../../src/infrastructure/execution/workspace-mutation-lock');
const ProjectOperationReceiptStore = require('../../../../src/infrastructure/execution/project-operation-receipt-store');

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
      process.stdout.write(JSON.stringify({ acquired: true, metadata: lease.metadata }) + '\n');
      if (process.argv[4] === 'hold') {
        process.stdin.resume();
      } else {
        await lease.release();
      }
    })().catch(error => {
      process.stdout.write(JSON.stringify({ acquired: false, code: error.code || null, message: error.message }) + '\n');
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

test('release atomically removes the active lock without retaining one tombstone per mutation', async () => {
  const f = await fixture();
  try {
    const lock = new WorkspaceMutationLock({ workspaceRoot: f.workspaceRoot, lockDirectory: f.lockDirectory });
    const lease = await lock.acquire();

    await lease.release();

    await assert.rejects(fs.stat(lock.lockPath), { code: 'ENOENT' });
    assert.deepEqual(await fs.readdir(f.lockDirectory), []);
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

    const lock = new WorkspaceMutationLock({ workspaceRoot: f.workspaceRoot, lockDirectory: f.lockDirectory });
    const classification = lock.classify();
    assert.equal(classification.state, 'recovery_required');
    assert.equal(classification.reason, 'owner_process_missing');
    assert.equal(classification.owner.token, first.metadata.token);
    assert.equal(classification.recoveryRequired, true);

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

test('a reused PID is classified as a dead recorded owner, not as the current owner', async () => {
  const f = await fixture();
  let lease;
  try {
    const lock = new WorkspaceMutationLock({ workspaceRoot: f.workspaceRoot, lockDirectory: f.lockDirectory });
    lease = await lock.acquire();
    const ownerPath = path.join(lock.lockPath, 'owner.json');
    const owner = JSON.parse(await fs.readFile(ownerPath, 'utf8'));
    owner.processStartIdentity = '0';
    await fs.writeFile(ownerPath, JSON.stringify(owner) + '\n', { mode: 0o600 });

    const classification = lock.classify();
    assert.equal(classification.state, 'recovery_required');
    assert.equal(classification.reason, 'owner_process_replaced');
    assert.equal(classification.owner.token, lease.metadata.token);
    assert.equal(classification.recoveryRequired, true);
  } finally {
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

test('recovery refuses to release a dead-owner lock without an operation before-image journal', async () => {
  const f = await fixture();
  let worker;
  try {
    worker = spawnLockWorker({ workspaceRoot: f.workspaceRoot, lockDirectory: f.lockDirectory, hold: true });
    const first = await readFirstLine(worker);
    assert.equal(first.acquired, true);
    worker.kill('SIGKILL');
    await waitForExit(worker);

    const lock = new WorkspaceMutationLock({ workspaceRoot: f.workspaceRoot, lockDirectory: f.lockDirectory });
    const receiptStore = new ProjectOperationReceiptStore({ directory: path.join(f.root, 'receipts') });
    assert.throws(() => lock.recover({
      expectedToken: first.metadata.token,
      operatorId: 'incident-operator',
      reason: 'no durable before-image journal exists',
      receiptStore
    }), { code: 'PROJECT_OPERATION_INTENT_REQUIRED' });
    assert.equal(lock.classify().state, 'recovery_required');
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
      () => lock.classify(),
      { code: 'PROJECT_WORKSPACE_LOCK_OWNER_UNKNOWN' }
    );
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

test('a staged recovery decision cannot release a lock without its durable before-image journal', async () => {
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
    const receiptStore = new ProjectOperationReceiptStore({ directory: path.join(f.root, 'receipts') });

    assert.throws(() => lock.recover({
      expectedToken: first.metadata.token,
      operatorId: staged.operatorId,
      reason: staged.reason,
      receiptStore
    }), { code: 'PROJECT_OPERATION_INTENT_REQUIRED' });
    const durable = JSON.parse(await fs.readFile(path.join(lock.lockPath, 'recovery.json'), 'utf8'));
    assert.equal(durable.recoveredAt, staged.recoveredAt);
    assert.equal(lock.classify().state, 'recovery_required');
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



function assertExistingCorruptionContract(lock) {
  assert.throws(() => lock.inspect(), { code: 'PROJECT_WORKSPACE_LOCK_CORRUPT' });
  // classify() deliberately throws for corrupt states; recovery_required is
  // reserved for recognized incomplete or abandoned lock states only.
  assert.throws(() => lock.classify(), { code: 'PROJECT_WORKSPACE_LOCK_CORRUPT' });
}

async function stopAndReap(child) {
  if (!child) return;
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
  }
  await waitForExit(child);
}

test('inspection preserves the unlocked and valid-owner legacy contracts', async () => {
  const f = await fixture();
  let lease;
  try {
    const lock = new WorkspaceMutationLock({ workspaceRoot: f.workspaceRoot, lockDirectory: f.lockDirectory });
    assert.equal(lock.inspect(), null);

    const unlocked = lock.classify();
    assert.equal(unlocked.state, 'unlocked');
    assert.equal(unlocked.reason, 'lock_absent');
    assert.equal(unlocked.owner, null);
    assert.equal(unlocked.recoveryRequired, false);

    lease = await lock.acquire();
    assert.deepEqual(lock.inspect(), lease.metadata);

    const active = lock.classify();
    assert.equal(active.state, 'locked');
    assert.equal(active.recoveryRequired, false);
    assert.deepEqual(active.owner, lease.metadata);
  } finally {
    if (lease) await lease.release();
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('inspection classifies a lock directory without owner.json as recovery_required after an early crash', async () => {
  const f = await fixture();
  let contender;
  try {
    const lock = new WorkspaceMutationLock({ workspaceRoot: f.workspaceRoot, lockDirectory: f.lockDirectory });
    await fs.mkdir(lock.lockPath, { mode: 0o700 });
    const before = await fs.lstat(lock.lockPath);
    assert.equal(before.isDirectory(), true);
    assert.equal(before.isSymbolicLink(), false);

    const classification = lock.classify();
    assert.equal(classification.state, 'recovery_required');
    assert.equal(classification.reason, 'owner_metadata_missing');
    assert.equal(classification.owner, null);
    assert.equal(classification.recoveryRequired, true);

    // inspect() deliberately retains its pre-existing corruption behavior;
    // callers needing recovery classification use classify().
    assert.throws(() => lock.inspect(), { code: 'PROJECT_WORKSPACE_LOCK_CORRUPT' });

    contender = spawnLockWorker({ workspaceRoot: f.workspaceRoot, lockDirectory: f.lockDirectory });
    const result = await readFirstLine(contender);
    assert.equal(result.acquired, false);
    assert.equal(result.code, 'PROJECT_WORKSPACE_MUTATION_LOCKED');
    await waitForExit(contender);

    const after = await fs.lstat(lock.lockPath);
    assert.equal(after.isDirectory(), true);
    assert.equal(after.isSymbolicLink(), false);
    assert.equal(after.dev, before.dev);
    assert.equal(after.ino, before.ino);
  } finally {
    await stopAndReap(contender);
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('operator inspection reports ownerless locks as locked and recovery_required', async () => {
  const f = await fixture();
  try {
    const lock = new WorkspaceMutationLock({ workspaceRoot: f.workspaceRoot, lockDirectory: f.lockDirectory });
    await fs.mkdir(lock.lockPath, { mode: 0o700 });
    const script = path.resolve(__dirname, '../../../../scripts/recover-project-workspace-lock.js');
    const result = spawnSync(process.execPath, [
      script,
      '--workspace', f.workspaceRoot,
      '--lock-directory', f.lockDirectory,
      '--inspect'
    ], { encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.locked, true);
    assert.equal(output.classification.state, 'recovery_required');
    assert.equal(output.classification.reason, 'owner_metadata_missing');
    assert.equal(output.owner, null);
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('an empty owner.json is classified as incomplete initialization, not malformed JSON', async () => {
  const f = await fixture();
  try {
    const lock = new WorkspaceMutationLock({ workspaceRoot: f.workspaceRoot, lockDirectory: f.lockDirectory });
    await fs.mkdir(lock.lockPath, { mode: 0o700 });
    const ownerPath = path.join(lock.lockPath, 'owner.json');
    await fs.writeFile(ownerPath, '', { mode: 0o600 });

    const classification = lock.classify();
    assert.equal(classification.state, 'recovery_required');
    assert.equal(classification.reason, 'owner_metadata_incomplete');
    assert.equal(classification.owner, null);
    assert.equal(classification.recoveryRequired, true);
    assert.throws(() => lock.inspect(), { code: 'PROJECT_WORKSPACE_LOCK_CORRUPT' });
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('malformed non-empty owner JSON remains corruption', async () => {
  const f = await fixture();
  try {
    const lock = new WorkspaceMutationLock({ workspaceRoot: f.workspaceRoot, lockDirectory: f.lockDirectory });
    await fs.mkdir(lock.lockPath, { mode: 0o700 });
    await fs.writeFile(path.join(lock.lockPath, 'owner.json'), '{"version":', { mode: 0o600 });
    assertExistingCorruptionContract(lock);
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('a symlinked owner.json remains corruption', async () => {
  const f = await fixture();
  try {
    const lock = new WorkspaceMutationLock({ workspaceRoot: f.workspaceRoot, lockDirectory: f.lockDirectory });
    await fs.mkdir(lock.lockPath, { mode: 0o700 });
    const target = path.join(f.root, 'owner-target.json');
    await fs.writeFile(target, '{}', { mode: 0o600 });
    await fs.symlink(target, path.join(lock.lockPath, 'owner.json'));
    assertExistingCorruptionContract(lock);
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('an owner.json with unsafe permissions remains corruption', async () => {
  const f = await fixture();
  try {
    const lock = new WorkspaceMutationLock({ workspaceRoot: f.workspaceRoot, lockDirectory: f.lockDirectory });
    await fs.mkdir(lock.lockPath, { mode: 0o700 });
    const ownerPath = path.join(lock.lockPath, 'owner.json');
    await fs.writeFile(ownerPath, '{}', { mode: 0o600 });
    await fs.chmod(ownerPath, 0o644);
    assertExistingCorruptionContract(lock);
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('a valid owner record bound to another workspace remains a recovery conflict', async () => {
  const f = await fixture();
  try {
    const lock = new WorkspaceMutationLock({ workspaceRoot: f.workspaceRoot, lockDirectory: f.lockDirectory });
    const lease = await lock.acquire();
    const ownerPath = path.join(lock.lockPath, 'owner.json');
    const owner = JSON.parse(await fs.readFile(ownerPath, 'utf8'));
    owner.workspaceId = '0'.repeat(64);
    await fs.writeFile(ownerPath, JSON.stringify(owner) + '\n', { mode: 0o600 });

    assert.throws(() => lock.inspect(), { code: 'PROJECT_WORKSPACE_LOCK_RECOVERY_CONFLICT' });
    assert.throws(() => lock.classify(), { code: 'PROJECT_WORKSPACE_LOCK_RECOVERY_CONFLICT' });
    assert.equal(lease.metadata.workspaceId, lock.workspaceId);
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('a lock directory with unsafe permissions remains corruption', async () => {
  const f = await fixture();
  try {
    const lock = new WorkspaceMutationLock({ workspaceRoot: f.workspaceRoot, lockDirectory: f.lockDirectory });
    await fs.mkdir(lock.lockPath, { mode: 0o700 });
    await fs.chmod(lock.lockPath, 0o755);
    assertExistingCorruptionContract(lock);
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});
