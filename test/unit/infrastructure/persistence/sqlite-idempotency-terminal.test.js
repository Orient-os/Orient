'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SqlitePersistence = require('../../../../src/infrastructure/persistence/sqlite/sqlite-persistence');

test('SQLite idempotency terminal transitions are immutable and tenant-scoped', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-sqlite-idempotency-cas-'));
  const persistence = new SqlitePersistence({ filePath: path.join(directory, 'runtime.db') });
  t.after(() => {
    persistence.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const started = persistence.idempotency.begin({
    executionId: 'execution-a', step: 1, tool: 'tool-a', tenantId: 'tenant-a'
  });
  assert.equal(started.created, true);

  const completed = persistence.idempotency.complete(started.key, { ok: true }, { tenantId: 'tenant-a' });
  assert.equal(completed.status, 'completed');
  assert.deepEqual(completed.result, { ok: true });

  const lateFailure = persistence.idempotency.fail(
    started.key, Object.assign(new Error('late failure'), { code: 'LATE_FAILURE' }),
    { tenantId: 'tenant-a' }
  );
  assert.equal(lateFailure.status, 'completed');
  assert.deepEqual(lateFailure.result, { ok: true });

  assert.equal(persistence.idempotency.complete(started.key, { forged: true }, { tenantId: 'tenant-b' }), null);
  assert.equal(persistence.idempotency.fail(started.key, new Error('wrong tenant'), { tenantId: 'tenant-b' }), null);
  assert.equal(persistence.idempotency.findByKey(started.key, { tenantId: 'tenant-a' }).status, 'completed');

  const second = persistence.idempotency.begin({
    executionId: 'execution-b', step: 1, tool: 'tool-b', tenantId: 'tenant-a'
  });
  assert.equal(second.created, true);
  const failed = persistence.idempotency.fail(second.key, Object.assign(new Error('failed'), { code: 'EXPECTED' }), {
    tenantId: 'tenant-a'
  });
  assert.equal(failed.status, 'failed');
  const lateCompletion = persistence.idempotency.complete(second.key, { shouldNotCommit: true }, {
    tenantId: 'tenant-a'
  });
  assert.equal(lateCompletion.status, 'failed');
  assert.deepEqual(lateCompletion.error, { code: 'EXPECTED', message: 'failed' });
});
