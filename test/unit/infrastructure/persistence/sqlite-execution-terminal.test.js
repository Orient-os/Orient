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
