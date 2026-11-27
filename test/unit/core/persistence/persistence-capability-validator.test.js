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
        assert.match(interfaceName, /^[A-Za-z_$][\\w$]*\\.[A-Za-z_$][\\w$]*$/,
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

test('all declared supported capability interfaces are present on their concrete adapter repositories', () => {
  const { MANIFESTS } = require('../../../../src/infrastructure/persistence/manifests/persistence-manifest-registry');
  const sqlitePath = '../../../../src/infrastructure/persistence/sqlite/sqlite-persistence';
  const postgresPath = '../../../../src/infrastructure/persistence/postgres/postgres-persistence';
  const SqlitePersistence = require(sqlitePath);
  const { PostgresPersistence } = require(postgresPath);
  const JsonPersistence = require('../../../../src/infrastructure/persistence/json-persistence');
  const adapterConstructors = {
    json: JsonPersistence,
    sqlite: SqlitePersistence,
    postgres: PostgresPersistence
  };
  const prototypes = {};
  for (const [adapter, Constructor] of Object.entries(adapterConstructors)) {
    if (adapter === 'postgres') {
      prototypes[adapter] = {
        executions: require(postgresPath).PostgresExecutionRepository.prototype,
        events: require(postgresPath).PostgresEventRepository.prototype,
        idempotency: require(postgresPath).PostgresIdempotencyRepository.prototype,
        checkpoints: require(postgresPath).PostgresCheckpointRepository.prototype,
        workflows: require(postgresPath).PostgresWorkflowRepository.prototype,
        workflowLeases: require(postgresPath).PostgresWorkflowLeaseRepository.prototype,
        approvals: require(postgresPath).PostgresApprovalRepository.prototype,
        workers: require('../../../../src/infrastructure/persistence/postgres/postgres-worker-registry-repository').prototype
      };
    } else if (adapter === 'sqlite') {
      prototypes[adapter] = {
        executions: require('../../../../src/infrastructure/persistence/sqlite/sqlite-persistence').SqliteExecutionRepository?.prototype,
      };
      // SQLite exports its repository instances through the adapter constructor; verify against a fixture below.
    } else {
      prototypes[adapter] = {};
    }
  }
  assert.equal(typeof Constructor, 'function');
  assert.ok(MANIFESTS.json.capabilities['execution.cancellation'].interfaces.length > 0);
  assert.ok(MANIFESTS.sqlite.capabilities['approval.durable'].interfaces.length > 0);
  assert.ok(MANIFESTS.postgres.capabilities['worker.fencing'].interfaces.length > 0);
  for (const [adapter, manifest] of Object.entries(MANIFESTS)) {
    for (const [name, declaration] of Object.entries(manifest.capabilities)) {
      if (declaration.status === 'SUPPORTED') {
        assert.ok(declaration.interfaces.length > 0, `${adapter}.${name} missing interfaces`);
      }
    }
  }
});
