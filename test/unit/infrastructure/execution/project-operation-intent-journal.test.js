'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const ProjectOperationReceiptStore = require('../../../../src/infrastructure/execution/project-operation-receipt-store');

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

test('pending project intent durably preserves bounded before-images and expected after-image hashes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-project-intent-journal-'));
  const directory = path.join(root, 'receipts');
  fs.mkdirSync(directory, { mode: 0o700 });
  const store = new ProjectOperationReceiptStore({ directory });
  const changes = [
    {
      action: 'update',
      path: 'config.json',
      beforeExists: true,
      beforeContent: '{"mode":"old"}\n',
      beforeContentSha256: digest('{"mode":"old"}\n'),
      afterContentSha256: digest('{"mode":"new"}\n')
    },
    {
      action: 'create',
      path: 'new.txt',
      beforeExists: false,
      beforeContent: null,
      beforeContentSha256: null,
      afterContentSha256: digest('new file')
    }
  ];
  try {
    const reserved = store.beginIntent({
      operationId: 'journal-operation',
      tenantId: 'tenant-a',
      workspaceId: digest('/workspace'),
      changeSetHash: digest('change-set'),
      changes
    });
    assert.equal(reserved.created, true);
    const intent = store.readIntent({ operationId: 'journal-operation', tenantId: 'tenant-a' });
    assert.equal(intent.version, 2);
    assert.deepEqual(intent.changes, changes);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('pending intent rejects before-images whose digest does not match their recorded bytes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-project-intent-invalid-'));
  const directory = path.join(root, 'receipts');
  fs.mkdirSync(directory, { mode: 0o700 });
  const store = new ProjectOperationReceiptStore({ directory });
  try {
    assert.throws(
      () => store.beginIntent({
        operationId: 'invalid-journal',
        tenantId: 'tenant-a',
        workspaceId: digest('/workspace'),
        changeSetHash: digest('change-set'),
        changes: [{
          action: 'update',
          path: 'config.json',
          beforeExists: true,
          beforeContent: 'actual before',
          beforeContentSha256: digest('different before'),
          afterContentSha256: digest('after')
        }]
      }),
      { code: 'PROJECT_OPERATION_INTENT_INVALID' }
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
