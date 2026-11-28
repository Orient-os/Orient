'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ProjectOperationReceiptStore = require('../../../../src/infrastructure/execution/project-operation-receipt-store');

function identity(value) {
  return require('node:crypto').createHash('sha256').update(value).digest('hex');
}

test('receipt store durably records a verified rollback as a terminal operation outcome', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-operation-outcome-'));
  const directory = path.join(root, 'receipts');
  fs.mkdirSync(directory, { mode: 0o700 });
  const store = new ProjectOperationReceiptStore({ directory });
  const workspaceId = identity('/workspace');
  const changeSetHash = identity('change-set');
  store.beginIntent({
    operationId: 'rollback-operation',
    tenantId: 'tenant-a',
    workspaceId,
    changeSetHash
  });
  const result = {
    status: 'failed',
    verification: { status: 'failed', failed: 1, passed: 0 },
    rollback: {
      rolledBack: true,
      restored: [
        { path: 'settings.json', existed: true, contentSha256: identity('before') },
        { path: 'new.txt', existed: false, contentSha256: null }
      ]
    }
  };
  try {
    const receipt = store.write({
      operationId: 'rollback-operation',
      tenantId: 'tenant-a',
      workspaceId,
      changeSetHash,
      result
    });
    assert.equal(receipt.outcome, 'rolled_back');
    assert.equal(store.read({ operationId: 'rollback-operation', tenantId: 'tenant-a' }).outcome, 'rolled_back');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('receipt store refuses to commit an unverified and unrolled-back failure', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-operation-outcome-invalid-'));
  const directory = path.join(root, 'receipts');
  fs.mkdirSync(directory, { mode: 0o700 });
  const store = new ProjectOperationReceiptStore({ directory });
  store.beginIntent({
    operationId: 'unsafe-operation',
    tenantId: 'tenant-a',
    workspaceId: identity('/workspace'),
    changeSetHash: identity('change-set')
  });
  try {
    assert.throws(
      () => store.write({
        operationId: 'unsafe-operation',
        tenantId: 'tenant-a',
        workspaceId: identity('/workspace'),
        changeSetHash: identity('change-set'),
        result: { status: 'failed', rollback: { rolledBack: false } }
      }),
      { code: 'PROJECT_OPERATION_RECEIPT_INVALID' }
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
