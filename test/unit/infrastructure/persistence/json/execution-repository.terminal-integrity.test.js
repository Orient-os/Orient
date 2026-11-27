'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ExecutionRepository = require('../../../../../src/infrastructure/persistence/json/execution.repository');

test('JSON execution terminal states are immutable across retries and repository restart', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-execution-terminal-'));
  const filePath = path.join(directory, 'executions.json');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const repository = new ExecutionRepository(filePath);
  for (const status of ['completed', 'failed', 'cancelled']) {
    const executionId = 'execution-' + status;
    repository.insert({
      executionId,
      requestId: 'request-' + status,
      status: 'running',
      metadata: { tenantId: 'tenant-a' },
      result: null
    }, { tenantId: 'tenant-a' });

    const committed = repository.update(executionId, {
      status,
      result: { committed: status }
    }, { tenantId: 'tenant-a' });
    assert.equal(committed.status, status);

    assert.throws(
      () => repository.update(executionId, {
        status,
        result: { committed: 'tampered' }
      }, { tenantId: 'tenant-a' }),
      error => error.code === 'EXECUTION_TERMINAL_CONFLICT' && error.status === 409
    );
    const repeated = repository.update(executionId, {
      status,
      result: { committed: status }
    }, { tenantId: 'tenant-a' });
    assert.deepEqual(repeated.result, { committed: status });

    const conflicting = ['completed', 'failed', 'cancelled'].find(value => value !== status);
    assert.throws(
      () => repository.update(executionId, { status: conflicting }, { tenantId: 'tenant-a' }),
      error => error.code === 'EXECUTION_TERMINAL_CONFLICT' && error.status === 409
    );
  }

  const reopened = new ExecutionRepository(filePath);
  for (const status of ['completed', 'failed', 'cancelled']) {
    assert.equal(reopened.findById('execution-' + status, { tenantId: 'tenant-a' }).status, status);
    assert.deepEqual(
      reopened.findById('execution-' + status, { tenantId: 'tenant-a' }).result,
      { committed: status }
    );
  }
});


test('JSON terminal integrity includes durable failure details, not only status', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-json-terminal-failure-'));
  const filePath = path.join(directory, 'executions.json');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const repository = new ExecutionRepository(filePath);
  repository.insert({
    executionId: 'execution-failure-details',
    requestId: 'request-failure-details',
    status: 'running',
    metadata: { tenantId: 'tenant-a' },
    agentState: { errors: [] }
  }, { tenantId: 'tenant-a' });

  repository.update('execution-failure-details', {
    status: 'failed',
    completedAt: '2026-11-27T10:00:00.000Z',
    agentState: { errors: [{ code: 'ORIGINAL_FAILURE', message: 'original' }] }
  }, { tenantId: 'tenant-a' });

  assert.throws(
    () => repository.update('execution-failure-details', {
      status: 'failed',
      agentState: { errors: [{ code: 'REPLACED_FAILURE', message: 'tampered' }] }
    }, { tenantId: 'tenant-a' }),
    error => error.code === 'EXECUTION_TERMINAL_CONFLICT'
  );
});
