'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const WorkspaceMutationLock = require('../../../../src/infrastructure/execution/workspace-mutation-lock');
const ProjectOperationReceiptStore = require('../../../../src/infrastructure/execution/project-operation-receipt-store');

const OPERATION_ID = 'pr3b2-recovery-operation';
const TENANT_ID = 'pr3b2-recovery-tenant';
const sha256 = value => crypto.createHash('sha256').update(value, 'utf8').digest('hex');

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orient-pr3b2-recovery-'));
  const workspaceRoot = path.join(root, 'workspace');
  const dataDirectory = path.join(root, 'data');
  const lockDirectory = path.join(dataDirectory, 'locks');
  await fs.mkdir(workspaceRoot, { mode: 0o700 });
  await fs.mkdir(dataDirectory, { mode: 0o700 });
  await fs.mkdir(lockDirectory, { mode: 0o700 });
  return { root, workspaceRoot, lockDirectory, receiptStore: new ProjectOperationReceiptStore({ directory: dataDirectory }) };
}

function spawnLockOwner({ workspaceRoot, lockDirectory }) {
  const modulePath = path.resolve(__dirname, '../../../../src/infrastructure/execution/workspace-mutation-lock');
  const source = [
    "const Lock = require(process.argv[1]);",
    "(async () => {",
    "  const lock = new Lock({ workspaceRoot: process.argv[2], lockDirectory: process.argv[3], operationId: process.argv[4], tenantId: process.argv[5] });",
    "  const lease = await lock.acquire();",
    "  process.stdout.write(JSON.stringify({ acquired: true, owner: lease.metadata }) + '\\n');",
    "  process.stdin.resume();",
    "})().catch(error => {",
    "  process.stdout.write(JSON.stringify({ acquired: false, code: error.code || null, message: error.message }) + '\\n');",
    "  process.exitCode = 2;",
    "});"
  ].join('\n');
  return spawn(process.execPath, ['-e', source, modulePath, workspaceRoot, lockDirectory, OPERATION_ID, TENANT_ID], { stdio: ['pipe', 'pipe', 'pipe'] });
}

function readFirstLine(child) {
  return new Promise((resolve, reject) => {
    let output = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      output += chunk;
      const newline = output.indexOf('\n');
      if (newline !== -1) {
        child.stdout.removeAllListeners('data');
        resolve(JSON.parse(output.slice(0, newline)));
      }
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', code => {
      if (!output.includes('\n')) reject(new Error('Lock owner exited without metadata; code=' + code + '; stderr=' + stderr));
    });
  });
}

async function killOwner(child) {
  if (!child) return;
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  if (child.exitCode === null && child.signalCode === null) await new Promise(resolve => child.once('exit', resolve));
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise(resolve => child.once('exit', resolve));
}

function lockFor(f) {
  return new WorkspaceMutationLock({ workspaceRoot: f.workspaceRoot, lockDirectory: f.lockDirectory });
}

async function createAbandonedLock(f) {
  const child = spawnLockOwner(f);
  const result = await readFirstLine(child);
  assert.equal(result.acquired, true);
  await killOwner(child);
  return result.owner;
}

function updateChange(pathname, beforeContent, afterContent, beforeMode) {
  return {
    action: 'update', path: pathname, beforeExists: true, beforeType: 'regular', beforeMode,
    beforeContent, beforeContentSha256: sha256(beforeContent), afterContentSha256: sha256(afterContent)
  };
}

function createChange(pathname, afterContent) {
  return {
    action: 'create', path: pathname, beforeExists: false, beforeType: 'absent', beforeMode: null,
    beforeContent: null, beforeContentSha256: null, afterContentSha256: sha256(afterContent)
  };
}

async function persistIntent(f, changes) {
  return f.receiptStore.beginIntent({
    operationId: OPERATION_ID,
    tenantId: TENANT_ID,
    workspaceId: sha256(fsSync.realpathSync(f.workspaceRoot)),
    changeSetHash: sha256(JSON.stringify(changes.map(change => ({
      action: change.action, path: change.path, content: change.afterContent, expectedContentSha256: change.expectedContentSha256
    })))),
    changes
  });
}


function spawnRecoveryWorker({ workspaceRoot, lockDirectory, dataDirectory, expectedToken, mode }) {
  const lockModule = path.resolve(__dirname, '../../../../src/infrastructure/execution/workspace-mutation-lock');
  const recoveryModule = path.resolve(__dirname, '../../../../src/infrastructure/execution/project-workspace-recovery');
  const storeModule = path.resolve(__dirname, '../../../../src/infrastructure/execution/project-operation-receipt-store');
  const source = [
    "const fs = require('node:fs');",
    "const Lock = require(process.argv[1]);",
    "const Recovery = require(process.argv[2]);",
    "const Store = require(process.argv[3]);",
    "if (process.argv[8] === 'pause-after-claim') {",
    "  const original = Recovery.prototype.restore;",
    "  Recovery.prototype.restore = function(input) {",
    "    process.stdout.write('CLAIMED\\n');",
    "    const byte = Buffer.alloc(1);",
    "    fs.readSync(0, byte, 0, 1, null);",
    "    return original.call(this, input);",
    "  };",
    "}",
    "if (process.argv[8] === 'crash-before-receipt') {",
    "  Store.prototype.write = function() {",
    "    process.stdout.write('RESTORED\\n');",
    "    process.kill(process.pid, 'SIGKILL');",
    "  };",
    "}",
    "try {",
    "  const lock = new Lock({ workspaceRoot: process.argv[4], lockDirectory: process.argv[5] });",
    "  const receiptStore = new Store({ directory: process.argv[6] });",
    "  lock.recover({ expectedToken: process.argv[7], operatorId: 'owner', reason: 'restartable recovery test', receiptStore });",
    "  process.stdout.write('DONE\\n');",
    "} catch (error) {",
    "  process.stderr.write(JSON.stringify({ code: error.code || null, message: error.message }) + '\\n');",
    "  process.exitCode = 2;",
    "}"
  ].join('\n');
  return spawn(process.execPath, [
    '-e', source, lockModule, recoveryModule, storeModule,
    workspaceRoot, lockDirectory, dataDirectory, expectedToken, mode
  ], { stdio: ['pipe', 'pipe', 'pipe'] });
}

function waitForMarker(child, marker) {
  return new Promise((resolve, reject) => {
    let output = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.includes(marker)) resolve(output);
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (!output.includes(marker)) {
        reject(new Error('Recovery worker exited before marker ' + marker + '; code=' + code + '; signal=' + signal + '; stderr=' + stderr));
      }
    });
  });
}

test('recovery restores before-images, preserves file modes, receipts rollback, then releases the lock', async () => {
  const f = await fixture();
  try {
    const originalPath = path.join(f.workspaceRoot, 'existing.txt');
    const createdPath = path.join(f.workspaceRoot, 'created.txt');
    await fs.writeFile(originalPath, 'before image\n', { mode: 0o640 });
    const changes = [
      updateChange('existing.txt', 'before image\n', 'after image\n', 0o640),
      createChange('created.txt', 'created by operation\n')
    ];
    await persistIntent(f, changes);
    await fs.writeFile(originalPath, 'after image\n', { mode: 0o640 });
    await fs.writeFile(createdPath, 'created by operation\n', { mode: 0o600 });
    await createAbandonedLock(f);

    const lock = lockFor(f);
    const owner = JSON.parse(await fs.readFile(path.join(lock.lockPath, 'owner.json'), 'utf8'));
    const recovered = lock.recover({
      expectedToken: owner.token, operatorId: 'owner', reason: 'restore interrupted project operation', receiptStore: f.receiptStore
    });

    assert.equal(recovered.recovered, true);
    assert.equal(await fs.readFile(originalPath, 'utf8'), 'before image\n');
    assert.equal((await fs.stat(originalPath)).mode & 0o777, 0o640);
    await assert.rejects(fs.access(createdPath), { code: 'ENOENT' });
    const receipt = f.receiptStore.read({ operationId: OPERATION_ID, tenantId: TENANT_ID });
    assert.equal(receipt.outcome, 'rolled_back');
    assert.equal(receipt.result.rollback.rolledBack, true);
    assert.deepEqual(receipt.result.rollback.restored, [
      { path: 'existing.txt', existed: true, contentSha256: sha256('before image\n') },
      { path: 'created.txt', existed: false, contentSha256: null }
    ]);
    assert.equal(lock.classify().state, 'unlocked');
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});


test('independent recovery processes cannot enter the same live recovery claim', async () => {
  const f = await fixture();
  let owner;
  let worker;
  try {
    const target = path.join(f.workspaceRoot, 'concurrent.txt');
    await fs.writeFile(target, 'before\\n', { mode: 0o600 });
    await persistIntent(f, [updateChange('concurrent.txt', 'before\\n', 'after\\n', 0o600)]);
    await fs.writeFile(target, 'after\\n', { mode: 0o600 });
    owner = await createAbandonedLock(f);
    worker = spawnRecoveryWorker({
      workspaceRoot: f.workspaceRoot,
      lockDirectory: f.lockDirectory,
      dataDirectory: path.dirname(f.lockDirectory),
      expectedToken: owner.token,
      mode: 'pause-after-claim'
    });
    await waitForMarker(worker, 'CLAIMED\n');

    const lock = lockFor(f);
    assert.throws(() => lock.recover({
      expectedToken: owner.token,
      operatorId: 'owner',
      reason: 'restartable recovery test',
      receiptStore: f.receiptStore
    }), { code: 'PROJECT_WORKSPACE_LOCK_RECOVERY_IN_PROGRESS' });

    worker.stdin.write('continue');
    worker.stdin.end();
    await waitForExit(worker);
    assert.equal(worker.exitCode, 0);
    assert.equal(await fs.readFile(target, 'utf8'), 'before\\n');
    assert.equal(lock.classify().state, 'unlocked');
  } finally {
    if (worker && worker.exitCode === null) worker.kill('SIGKILL');
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('recovery resumes after a process crash between before-image restoration and receipt commit', async () => {
  const f = await fixture();
  let worker;
  try {
    const target = path.join(f.workspaceRoot, 'restart.txt');
    await fs.writeFile(target, 'before\\n', { mode: 0o640 });
    await persistIntent(f, [updateChange('restart.txt', 'before\\n', 'after\\n', 0o640)]);
    await fs.writeFile(target, 'after\\n', { mode: 0o640 });
    const owner = await createAbandonedLock(f);

    worker = spawnRecoveryWorker({
      workspaceRoot: f.workspaceRoot,
      lockDirectory: f.lockDirectory,
      dataDirectory: path.dirname(f.lockDirectory),
      expectedToken: owner.token,
      mode: 'crash-before-receipt'
    });
    await waitForExit(worker);
    assert.equal(worker.signalCode, 'SIGKILL');
    assert.equal(await fs.readFile(target, 'utf8'), 'before\\n');
    assert.equal(f.receiptStore.read({ operationId: OPERATION_ID, tenantId: TENANT_ID }), null);

    const lock = lockFor(f);
    const resumed = lock.recover({
      expectedToken: owner.token,
      operatorId: 'owner',
      reason: 'restartable recovery test',
      receiptStore: f.receiptStore
    });
    assert.equal(resumed.outcome, 'rolled_back');
    assert.equal(f.receiptStore.read({ operationId: OPERATION_ID, tenantId: TENANT_ID }).outcome, 'rolled_back');
    assert.equal(lock.classify().state, 'unlocked');
  } finally {
    if (worker && worker.exitCode === null) worker.kill('SIGKILL');
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('recovery refuses a third-party before/after mismatch and leaves the lock held', async () => {
  const f = await fixture();
  try {
    const target = path.join(f.workspaceRoot, 'conflict.txt');
    await fs.writeFile(target, 'before\n', { mode: 0o600 });
    await persistIntent(f, [updateChange('conflict.txt', 'before\n', 'operation after\n', 0o600)]);
    await fs.writeFile(target, 'external writer\n', { mode: 0o600 });
    await createAbandonedLock(f);
    const lock = lockFor(f);
    const owner = JSON.parse(await fs.readFile(path.join(lock.lockPath, 'owner.json'), 'utf8'));
    assert.throws(() => lock.recover({
      expectedToken: owner.token, operatorId: 'owner', reason: 'must not overwrite external change', receiptStore: f.receiptStore
    }), { code: 'PROJECT_WORKSPACE_LOCK_RECOVERY_CONFLICT' });
    assert.equal(await fs.readFile(target, 'utf8'), 'external writer\n');
    assert.equal(lock.classify().state, 'recovery_required');
    assert.equal(f.receiptStore.read({ operationId: OPERATION_ID, tenantId: TENANT_ID }), null);
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('recovery deletes a newly created file only when it still matches the operation after-image', async () => {
  const f = await fixture();
  try {
    const target = path.join(f.workspaceRoot, 'created.txt');
    await persistIntent(f, [createChange('created.txt', 'operation content\n')]);
    await fs.writeFile(target, 'changed externally\n', { mode: 0o600 });
    await createAbandonedLock(f);
    const lock = lockFor(f);
    const owner = JSON.parse(await fs.readFile(path.join(lock.lockPath, 'owner.json'), 'utf8'));
    assert.throws(() => lock.recover({
      expectedToken: owner.token, operatorId: 'owner', reason: 'do not delete externally changed file', receiptStore: f.receiptStore
    }), { code: 'PROJECT_WORKSPACE_LOCK_RECOVERY_CONFLICT' });
    assert.equal(await fs.readFile(target, 'utf8'), 'changed externally\n');
    assert.equal(lock.classify().state, 'recovery_required');
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});
