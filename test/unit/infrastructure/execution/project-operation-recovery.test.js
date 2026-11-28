'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const WorkspaceMutationLock = require('../../../../src/infrastructure/execution/workspace-mutation-lock');
const ProjectOperationReceiptStore = require('../../../../src/infrastructure/execution/project-operation-receipt-store');

function hash(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

async function fixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'orient-project-recovery-'));
  const workspaceRoot = path.join(root, 'workspace');
  const receiptDirectory = path.join(root, 'receipts');
  const lockDirectory = path.join(receiptDirectory, 'workspace-locks');
  await fsp.mkdir(workspaceRoot);
  await fsp.mkdir(receiptDirectory, { mode: 0o700 });
  const store = new ProjectOperationReceiptStore({ directory: receiptDirectory });
  store.ensureDirectory();
  return { root, workspaceRoot, receiptDirectory, lockDirectory, store };
}

function waitForOwner(child) {
  let output = '';
  let stderr = '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for workspace lock owner: ' + stderr)), 8000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      output += chunk;
      const newline = output.indexOf('\n');
      if (newline >= 0) {
        clearTimeout(timer);
        resolve(JSON.parse(output.slice(0, newline)));
      }
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      if (!output.includes('\n')) {
        clearTimeout(timer);
        reject(new Error('Lock owner exited before publishing metadata: ' + code + '/' + signal + ' ' + stderr));
      }
    });
  });
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise(resolve => child.once('exit', resolve));
}

async function createAbandonedOperation(f, operationId, tenantId) {
  const modulePath = path.resolve(__dirname, '../../../../src/infrastructure/execution/workspace-mutation-lock');
  const source = [
    "const Lock = require(process.argv[1]);",
    "(async () => {",
    "  const lock = new Lock({ workspaceRoot: process.argv[2], lockDirectory: process.argv[3], operationId: process.argv[4], tenantId: process.argv[5] });",
    "  const lease = await lock.acquire();",
    "  process.stdout.write(JSON.stringify(lease.metadata) + '\\\\n');",
    "  process.stdin.resume();",
    "})().catch(error => { process.stderr.write(error.stack || String(error)); process.exitCode = 2; });"
  ].join('\n');
  const child = spawn(process.execPath, ['-e', source, modulePath, f.workspaceRoot, f.lockDirectory, operationId, tenantId], {
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const owner = await waitForOwner(child);
  child.kill('SIGKILL');
  await waitForExit(child);
  assert.equal(child.signalCode, 'SIGKILL');
  return owner;
}

function makeJournalChange({ action, relativePath, beforeContent, beforeMode, afterContent }) {
  const beforeExists = beforeContent !== null;
  return {
    action,
    path: relativePath,
    beforeExists,
    beforeType: beforeExists ? 'regular' : 'absent',
    beforeMode: beforeExists ? beforeMode : null,
    beforeContent,
    beforeContentSha256: beforeExists ? hash(beforeContent) : null,
    afterContentSha256: hash(afterContent)
  };
}

async function preparePendingOperation(f, owner, changes, changeSetHash = hash('approved-change-set')) {
  const workspaceId = hash(fs.realpathSync.native(f.workspaceRoot));
  const reservation = f.store.beginIntent({
    operationId: owner.operationId,
    tenantId: owner.tenantId,
    workspaceId,
    changeSetHash,
    changes
  });
  assert.equal(reservation.created, true);
  return { workspaceId, changeSetHash };
}

test('recovery restores exact before-images, removes only matching created after-images, commits and reads back a rolled-back receipt before releasing the canonical lock', async t => {
  const f = await fixture();
  t.after(() => fsp.rm(f.root, { recursive: true, force: true }));
  const operationId = 'recovery-restores-before-images';
  const tenantId = 'tenant-a';
  const existingPath = path.join(f.workspaceRoot, 'existing.txt');
  const createdPath = path.join(f.workspaceRoot, 'created.txt');
  const beforeContent = 'original content\n';
  const afterExisting = 'approved replacement\n';
  const afterCreated = 'approved new file\n';
  await fsp.writeFile(existingPath, afterExisting, { mode: 0o640 });
  await fsp.chmod(existingPath, 0o640);
  await fsp.writeFile(createdPath, afterCreated, { mode: 0o600 });
  const owner = await createAbandonedOperation(f, operationId, tenantId);
  const changes = [
    makeJournalChange({
      action: 'update',
      relativePath: 'existing.txt',
      beforeContent,
      beforeMode: 0o640,
      afterContent: afterExisting
    }),
    makeJournalChange({
      action: 'create',
      relativePath: 'created.txt',
      beforeContent: null,
      beforeMode: null,
      afterContent: afterCreated
    })
  ];
  const identity = await preparePendingOperation(f, owner, changes);
  const lock = new WorkspaceMutationLock({ workspaceRoot: f.workspaceRoot, lockDirectory: f.lockDirectory });

  const result = lock.recover({
    expectedToken: owner.token,
    operatorId: 'owner',
    reason: 'Recover an interrupted approved project mutation',
    receiptStore: f.store
  });

  assert.equal(result.recovered, true);
  assert.equal(await fsp.readFile(existingPath, 'utf8'), beforeContent);
  assert.equal(fs.statSync(existingPath).mode & 0o777, 0o640);
  await assert.rejects(fsp.stat(createdPath), { code: 'ENOENT' });
  const receipt = f.store.read({ operationId, tenantId });
  assert.equal(receipt.outcome, 'rolled_back');
  assert.equal(receipt.workspaceId, identity.workspaceId);
  assert.equal(receipt.changeSetHash, identity.changeSetHash);
  assert.equal(receipt.result.rollback.rolledBack, true);
  assert.equal(lock.classify().state, 'unlocked');
});

test('recovery refuses to overwrite a file matching neither its before-image nor its after-image and retains the canonical lock', async t => {
  const f = await fixture();
  t.after(() => fsp.rm(f.root, { recursive: true, force: true }));
  const operationId = 'recovery-preserves-conflict';
  const tenantId = 'tenant-a';
  const target = path.join(f.workspaceRoot, 'conflict.txt');
  await fsp.writeFile(target, 'third-party content\n', { mode: 0o640 });
  const owner = await createAbandonedOperation(f, operationId, tenantId);
  const changes = [makeJournalChange({
    action: 'update',
    relativePath: 'conflict.txt',
    beforeContent: 'before\n',
    beforeMode: 0o640,
    afterContent: 'after\n'
  })];
  await preparePendingOperation(f, owner, changes);
  const lock = new WorkspaceMutationLock({ workspaceRoot: f.workspaceRoot, lockDirectory: f.lockDirectory });

  assert.throws(
    () => lock.recover({
      expectedToken: owner.token,
      operatorId: 'owner',
      reason: 'A conflicting file must never be overwritten',
      receiptStore: f.store
    }),
    error => error?.code === 'PROJECT_OPERATION_RECOVERY_CONFLICT'
  );

  assert.equal(await fsp.readFile(target, 'utf8'), 'third-party content\n');
  assert.equal(lock.classify().state, 'recovery_required');
  assert.equal(f.store.read({ operationId, tenantId }), null);
});

test('recovery refuses legacy intents without a complete version-3 file metadata journal', async t => {
  const f = await fixture();
  t.after(() => fsp.rm(f.root, { recursive: true, force: true }));
  const operationId = 'recovery-legacy-intent';
  const tenantId = 'tenant-a';
  const owner = await createAbandonedOperation(f, operationId, tenantId);
  const workspaceId = hash(fs.realpathSync.native(f.workspaceRoot));
  f.store.beginIntent({
    operationId,
    tenantId,
    workspaceId,
    changeSetHash: hash('legacy-change-set')
  });
  const lock = new WorkspaceMutationLock({ workspaceRoot: f.workspaceRoot, lockDirectory: f.lockDirectory });

  assert.throws(
    () => lock.recover({
      expectedToken: owner.token,
      operatorId: 'owner',
      reason: 'Legacy intent has no restorable before-image',
      receiptStore: f.store
    }),
    error => error?.code === 'PROJECT_OPERATION_RECOVERY_JOURNAL_UNAVAILABLE'
  );

  assert.equal(lock.classify().state, 'recovery_required');
});
