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


test('every SUPPORTED capability declares concrete repository operations', () => {
  const { MANIFESTS } = require('../../../../src/infrastructure/persistence/manifests/persistence-manifest-registry');
  for (const manifest of Object.values(MANIFESTS)) {
    for (const [name, declaration] of Object.entries(manifest.capabilities)) {
      if (declaration.status !== 'SUPPORTED') continue;
      assert.ok(declaration.interfaces.length > 0,
        `${manifest.adapter}.${name} must declare required interfaces`);
      assert.equal(new Set(declaration.interfaces).size, declaration.interfaces.length,
        `${manifest.adapter}.${name} must not repeat interface requirements`);
      for (const interfaceName of declaration.interfaces) {
        assert.match(interfaceName, /^[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*$/,
          `${manifest.adapter}.${name} has an invalid interface path: ${interfaceName}`);
      }
    }
  }
});

test('post-initialization verification rejects an enabled capability with a missing declared operation', () => {
  const { verifyPersistenceAdapter } =
    require('../../../../src/core/persistence/contracts/persistence-capability-validator');
  const resolved = resolvePersistenceCapabilities({
    adapter: 'json',
    profile: 'local',
    enabledCapabilities: ['execution.cancellation']
  });
  const persistence = {
    executions: { findById() {}, insert() {}, update() {} , requestCancellation() {} },
    events: { append() {} },
    idempotency: { begin() {}, complete() {}, fail() {} }
  };
  assert.throws(
    () => verifyPersistenceAdapter({
      adapter: 'json',
      persistence: { ...persistence, executions: { findById() {}, insert() {}, update() {} } },
      resolved
    }),
    error => error.code === 'PERSISTENCE_CAPABILITY_MISMATCH' &&
      error.capability === 'execution.cancellation' &&
      error.guarantee === 'executions.requestCancellation'
  );
});

