'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const SqlitePersistence = require('../../../../src/infrastructure/persistence/sqlite/sqlite-persistence');

test('SQLite execution terminal states are immutable and tenant-scoped', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-sqlite-execution-terminal-'));
  const filePath = path.join(directory, 'runtime.db');
  let persistence = new SqlitePersistence({ filePath });
  t.after(() => {
    persistence.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  for (const status of ['completed', 'failed', 'cancelled']) {
    const executionId = 'execution-' + status;
    persistence.executions.insert({
      executionId,
      requestId: 'request-' + status,
      status: 'running',
      metadata: { tenantId: 'tenant-a' },
      result: null
    }, { tenantId: 'tenant-a' });
    const committed = persistence.executions.update(executionId, {
      status,
      result: { committed: status }
    }, { tenantId: 'tenant-a' });
    assert.equal(committed.status, status);
    assert.throws(
      () => persistence.executions.update(executionId, {
        status,
        result: { committed: 'tampered' }
      }, { tenantId: 'tenant-a' }),
      error => error.code === 'EXECUTION_TERMINAL_CONFLICT'
    );
    assert.deepEqual(
      persistence.executions.update(executionId, {
        status,
        result: { committed: status }
      }, { tenantId: 'tenant-a' }).result,
      { committed: status }
    );
    assert.throws(
      () => persistence.executions.update(executionId, {
        status: status === 'completed' ? 'failed' : 'completed'
      }, { tenantId: 'tenant-a' }),
      error => error.code === 'EXECUTION_TERMINAL_CONFLICT'
    );
    assert.equal(persistence.executions.findById(executionId, { tenantId: 'tenant-b' }), null);
  }

  persistence.close();
  persistence = new SqlitePersistence({ filePath });
  for (const status of ['completed', 'failed', 'cancelled']) {
    const persisted = persistence.executions.findById('execution-' + status, { tenantId: 'tenant-a' });
    assert.equal(persisted.status, status);
    assert.deepEqual(persisted.result, { committed: status });
  }
});


test('SQLite cancellation committed after the read wins the terminal compare-and-set', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-sqlite-execution-cancel-race-'));
  const filePath = path.join(directory, 'runtime.db');
  const writer = new SqlitePersistence({ filePath });
  const canceller = new SqlitePersistence({ filePath });
  t.after(() => {
    writer.close();
    canceller.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  writer.executions.insert({
    executionId: 'execution-cancel-race',
    status: 'running',
    metadata: { tenantId: 'tenant-a' },
    result: null,
    cancellationRequested: false
  }, { tenantId: 'tenant-a' });

  const originalRun = writer.db.run.bind(writer.db);
  let cancellationCommitted = false;
  writer.db.run = (sql, params) => {
    if (!cancellationCommitted && sql.startsWith('UPDATE executions SET payload')) {
      cancellationCommitted = true;
      canceller.executions.update('execution-cancel-race', {
        cancellationRequested: true,
        cancellationReason: 'owner requested cancellation'
      }, { tenantId: 'tenant-a' });
    }
    return originalRun(sql, params);
  };

  const persisted = writer.executions.update('execution-cancel-race', {
    status: 'completed',
    result: { shouldNotCommit: true }
  }, { tenantId: 'tenant-a' });

  assert.equal(cancellationCommitted, true);
  assert.equal(persisted.status, 'running');
  assert.equal(persisted.cancellationRequested, true);
  assert.equal(persisted.cancellationReason, 'owner requested cancellation');
  assert.equal(persisted.result, null);
});


test('SQLite execution identity cannot be rebound by updates', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-sqlite-identity-'));
  const persistence = new SqlitePersistence({ filePath: path.join(directory, 'runtime.db') });
  t.after(() => {
    persistence.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  persistence.executions.insert({
    id: 'stable-id',
    executionId: 'stable-execution',
    requestId: 'stable-request',
    goalId: 'stable-goal',
    parentExecutionId: 'stable-parent',
    executionVersion: 4,
    status: 'running',
    metadata: { tenantId: 'tenant-a', userId: 'owner-a', workspaceId: 'workspace-a' }
  }, { tenantId: 'tenant-a' });

  assert.throws(
    () => persistence.executions.update('stable-execution', { requestId: 'replacement-request' }, { tenantId: 'tenant-a' }),
    error => error.code === 'EXECUTION_IDENTITY_CONFLICT' && error.field === 'requestId'
  );
  assert.throws(
    () => persistence.executions.update('stable-execution', {
      metadata: { tenantId: 'tenant-b', userId: 'owner-a', workspaceId: 'workspace-a' }
    }, { tenantId: 'tenant-a' }),
    error => error.code === 'EXECUTION_IDENTITY_CONFLICT' && error.field === 'metadata.tenantId'
  );

  const updated = persistence.executions.update('stable-execution', {
    metadata: { label: 'safe mutable metadata' }
  }, { tenantId: 'tenant-a' });
  assert.equal(updated.requestId, 'stable-request');
  assert.equal(updated.goalId, 'stable-goal');
  assert.equal(updated.executionVersion, 4);
  assert.equal(updated.metadata.tenantId, 'tenant-a');
  assert.equal(updated.metadata.label, 'safe mutable metadata');
});
