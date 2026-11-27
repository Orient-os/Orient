'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolvePersistenceCapabilities } =
  require('../../../../src/core/persistence/contracts/persistence-capability-validator');

test('trusted JSON manifest resolves the required core contract', () => {
  const resolved = resolvePersistenceCapabilities({ adapter: 'json', profile: 'local' });
  assert.equal(resolved.contractVersion, '1.0.0');
  assert.ok(resolved.guarantees.includes('idempotency.terminal.protection'));
  assert.equal(resolved.capabilities['approval.durable'].status, 'UNSUPPORTED');
  assert.equal(resolved.capabilities['execution.cancellation'].enabled, true);
});

test('a degraded optional capability is disabled unless explicitly requested', () => {
  const resolved = resolvePersistenceCapabilities({ adapter: 'json', profile: 'local' });
  assert.equal(resolved.capabilities['workflow.ephemeral'].status, 'DEGRADED');
  assert.equal(resolved.capabilities['workflow.ephemeral'].enabled, false);
});

test('a profile-approved degraded capability can be explicitly enabled', () => {
  const resolved = resolvePersistenceCapabilities({
    adapter: 'json',
    profile: 'local',
    enabledCapabilities: ['workflow.ephemeral']
  });
  assert.equal(resolved.capabilities['workflow.ephemeral'].enabled, true);
});

test('unsupported optional capabilities cannot be enabled', () => {
  assert.throws(
    () => resolvePersistenceCapabilities({
      adapter: 'json',
      profile: 'local',
      enabledCapabilities: ['approval.durable']
    }),
    error => error.code === 'PERSISTENCE_CAPABILITY_MISSING' &&
      error.capability === 'approval.durable'
  );
});

test('SQLite is rejected because terminal idempotency protection is not yet guaranteed', () => {
  assert.throws(
    () => resolvePersistenceCapabilities({ adapter: 'sqlite', profile: 'local' }),
    error => error.code === 'PERSISTENCE_GUARANTEE_UNSATISFIED' &&
      error.guarantee === 'idempotency.terminal.protection'
  );
});

test('unknown adapter and unknown profile fail closed', () => {
  assert.throws(
    () => resolvePersistenceCapabilities({ adapter: 'unknown', profile: 'local' }),
    error => error.code === 'PERSISTENCE_MANIFEST_INVALID'
  );
  assert.throws(
    () => resolvePersistenceCapabilities({ adapter: 'json', profile: 'missing' }),
    error => error.code === 'PERSISTENCE_PROFILE_INCOMPATIBLE'
  );
});
