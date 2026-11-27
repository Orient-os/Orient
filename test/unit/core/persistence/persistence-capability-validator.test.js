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
  assert.equal(resolved.capabilities['execution.cancellation'].enabled, false);
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

test('SQLite satisfies the core terminal idempotency guarantee after compare-and-set hardening', () => {
  const resolved = resolvePersistenceCapabilities({ adapter: 'sqlite', profile: 'local' });
  assert.ok(resolved.guarantees.includes('idempotency.terminal.protection'));
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

test('pre-initialization verification rejects an enabled capability with a missing declared operation', () => {
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



test('pre-initialization interface checks do not claim behavioral guarantees are proven', () => {
  const {
    resolvePersistenceCapabilities: resolve,
    verifyPersistenceAdapter
  } = require('../../../../src/core/persistence/contracts/persistence-capability-validator');
  const resolved = resolve({
    adapter: 'json',
    profile: 'local',
    enabledCapabilities: ['execution.cancellation']
  });
  const persistence = {
    executions: { findById() {}, insert() {}, update() {}, requestCancellation() {} },
    events: { append() {} },
    idempotency: { begin() {}, complete() {}, fail() {} }
  };

  const verification = verifyPersistenceAdapter({
    adapter: 'json',
    persistence,
    resolved
  });

  assert.equal(verification.interfacesVerified, true);
  assert.equal(verification.guaranteesVerified, false);
  assert.equal(verification.verified, undefined);
  assert.equal(
    verification.guaranteeVerification['execution.cancellation:execution.cancellation.durability'].status,
    'unverified'
  );
  for (const guarantee of resolved.guarantees) {
    assert.equal(verification.guaranteeVerification[guarantee].status, 'unverified');
    assert.ok(verification.guaranteeVerification[guarantee].evidence.length > 0);
    assert.match(verification.guaranteeVerification[guarantee].reason, /strict-ci/);
  }
});


test('every core persistence guarantee is linked to an existing adapter-specific behavioral test', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { EVIDENCE } = require('../../../../src/core/persistence/contracts/persistence-guarantee-evidence');
  const { getCoreGuarantees } = require('../../../../src/core/persistence/contracts/persistence-capability-validator');
  const root = path.resolve(__dirname, '../../../..');
  const guarantees = getCoreGuarantees();

  for (const adapter of ['json', 'sqlite', 'postgres']) {
    for (const guarantee of guarantees) {
      const evidence = EVIDENCE[adapter]?.[guarantee];
      assert.ok(Array.isArray(evidence) && evidence.length > 0,
        `${adapter}.${guarantee} must link behavioral evidence`);
      for (const item of evidence) {
        const absolutePath = path.join(root, item.file);
        assert.equal(fs.existsSync(absolutePath), true, `missing evidence file: ${item.file}`);
        assert.ok(fs.readFileSync(absolutePath, 'utf8').includes(item.testName),
          `missing behavioral test "${item.testName}" in ${item.file}`);
      }
    }
  }
});


test('supported optional capabilities remain disabled until explicitly requested', () => {
  for (const adapter of ['json', 'sqlite', 'postgres']) {
    const resolved = resolvePersistenceCapabilities({ adapter, profile: adapter === 'postgres' ? 'postgres' : 'local' });
    for (const capability of Object.values(resolved.capabilities)) {
      assert.equal(capability.enabled, false, adapter + ' must not auto-enable optional capabilities');
    }
  }
});

test('explicitly enabled capabilities require their profile guarantees and adapter-specific evidence', () => {
  const { MANIFESTS } = require('../../../../src/infrastructure/persistence/manifests/persistence-manifest-registry');
  const { CAPABILITY_EVIDENCE } = require('../../../../src/core/persistence/contracts/persistence-guarantee-evidence');
  const profiles = { json: 'local', sqlite: 'local', postgres: 'postgres' };
  for (const [adapter, manifest] of Object.entries(MANIFESTS)) {
    for (const [name, declaration] of Object.entries(manifest.capabilities)) {
      if (declaration.status === 'UNSUPPORTED') continue;
      const resolved = resolvePersistenceCapabilities({
        adapter,
        profile: profiles[adapter],
        enabledCapabilities: [name]
      });
      assert.equal(resolved.capabilities[name].enabled, true, adapter + '.' + name);
      assert.ok(resolved.capabilities[name].requiredGuarantees.length > 0,
        adapter + '.' + name + ' must require feature guarantees');
      for (const guarantee of resolved.capabilities[name].requiredGuarantees) {
        assert.ok(declaration.guarantees.includes(guarantee),
          adapter + '.' + name + ' must declare ' + guarantee);
        assert.ok(CAPABILITY_EVIDENCE[adapter]?.[name]?.[guarantee]?.length > 0,
          adapter + '.' + name + ' must link evidence for ' + guarantee);
      }
    }
  }
});

test('JSON ephemeral workflow capability is explicitly degraded and never claims durable storage', () => {
  const { MANIFESTS } = require('../../../../src/infrastructure/persistence/manifests/persistence-manifest-registry');
  const declaration = MANIFESTS.json.capabilities['workflow.ephemeral'];
  assert.equal(declaration.status, 'DEGRADED');
  assert.ok(declaration.guarantees.includes('workflow.persistence.ephemeral'));
  const resolved = resolvePersistenceCapabilities({
    adapter: 'json',
    profile: 'local',
    enabledCapabilities: ['workflow.ephemeral']
  });
  assert.equal(resolved.capabilities['workflow.ephemeral'].enabled, true);
  assert.equal(resolved.capabilities['workflow.ephemeral'].status, 'DEGRADED');
  assert.equal(resolved.capabilities['workflow.ephemeral'].guaranteeEvidence['workflow.persistence.ephemeral'].length, 1);
});

test('duplicate enabled capability declarations fail closed', () => {
  assert.throws(
    () => resolvePersistenceCapabilities({
      adapter: 'json',
      profile: 'local',
      enabledCapabilities: ['execution.cancellation', 'execution.cancellation']
    }),
    error => error.code === 'PERSISTENCE_MANIFEST_INVALID'
  );
});


test('preflight and verified contracts are identity-trusted and cannot be forged by freezing a copy', () => {
  const {
    resolvePersistenceCapabilities: resolve,
    verifyPersistenceAdapter,
    isTrustedPersistenceContract
  } = require('../../../../src/core/persistence/contracts/persistence-capability-validator');
  const resolved = resolve({ adapter: 'json', profile: 'local' });
  assert.equal(isTrustedPersistenceContract(resolved), true);
  const forged = Object.freeze({ ...resolved });
  assert.equal(isTrustedPersistenceContract(forged), false);
  assert.throws(
    () => verifyPersistenceAdapter({
      adapter: 'json',
      persistence: {
        executions: { findById() {}, insert() {}, update() {} },
        events: { append() {} },
        idempotency: { begin() {}, complete() {}, fail() {} }
      },
      resolved: forged
    }),
    error => error.code === 'PERSISTENCE_CAPABILITY_CONTRACT_REQUIRED'
  );
  const verified = verifyPersistenceAdapter({
    adapter: 'json',
    persistence: {
      executions: { findById() {}, insert() {}, update() {} },
      events: { append() {} },
      idempotency: { begin() {}, complete() {}, fail() {} }
    },
    resolved
  });
  assert.equal(isTrustedPersistenceContract(verified), true);
});

test('runtime rejects a concrete persistence adapter without its frozen preflight contract', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const JsonPersistence = require('../../../../src/infrastructure/persistence/json-persistence');
  const OrientRuntime = require('../../../../src/core/runtime/orient-runtime');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-runtime-contract-required-'));
  try {
    const persistence = new JsonPersistence({ dataDirectory: directory });
    assert.throws(
      () => new OrientRuntime({
        toolRegistry: { requireAuthorization() {} },
        agentOrchestrator: { async plan() { return { plan: { steps: [] }, validation: { valid: true, steps: [] } }; } },
        persistence
      }),
      error => error.code === 'PERSISTENCE_CAPABILITY_CONTRACT_REQUIRED' &&
        error.phase === 'runtime-construction'
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('runtime refuses startup until concrete persistence interfaces are verified', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const JsonPersistence = require('../../../../src/infrastructure/persistence/json-persistence');
  const OrientRuntime = require('../../../../src/core/runtime/orient-runtime');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-runtime-contract-unverified-'));
  try {
    const persistence = new JsonPersistence({ dataDirectory: directory });
    const resolved = resolvePersistenceCapabilities({ adapter: 'json', profile: 'local' });
    const runtime = new OrientRuntime({
      toolRegistry: { requireAuthorization() {} },
      agentOrchestrator: { async plan() { return { plan: { steps: [] }, validation: { valid: true, steps: [] } }; } },
      persistence,
      persistenceCapabilities: resolved,
      deferPersistenceStartup: true
    });
    await assert.rejects(
      runtime.start(),
      error => error.code === 'PERSISTENCE_CAPABILITY_CONTRACT_UNVERIFIED' &&
        error.phase === 'runtime-start'
    );
    await runtime.shutdown({ cancelQueued: false });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});


test('every optional capability guarantee maps to an existing named behavioral test', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { CAPABILITY_EVIDENCE } = require('../../../../src/core/persistence/contracts/persistence-guarantee-evidence');
  const root = path.resolve(__dirname, '../../../..');
  for (const [adapter, capabilities] of Object.entries(CAPABILITY_EVIDENCE)) {
    for (const [capability, guarantees] of Object.entries(capabilities)) {
      for (const [guarantee, evidence] of Object.entries(guarantees)) {
        assert.ok(Array.isArray(evidence) && evidence.length > 0,
          adapter + '.' + capability + '.' + guarantee + ' must have evidence');
        for (const item of evidence) {
          const file = path.resolve(root, item.file);
          assert.ok(file.startsWith(root + path.sep), 'evidence path must remain inside the repository');
          assert.equal(fs.existsSync(file), true, 'missing evidence file: ' + item.file);
          assert.ok(fs.readFileSync(file, 'utf8').includes(item.testName),
            'missing behavioral test "' + item.testName + '" in ' + item.file);
        }
      }
    }
  }
});


test('runtime does not instantiate durable approval services when the capability is not explicitly enabled', () => {
  const OrientRuntime = require('../../../../src/core/runtime/orient-runtime');
  const persistence = {
    approvals: {
      async findById() { return null; },
      async save() { return null; }
    }
  };
  const runtime = new OrientRuntime({
    toolRegistry: { requireAuthorization() {} },
    agentOrchestrator: { async plan() { return { plan: { steps: [] }, validation: { valid: true, steps: [] } }; } },
    persistence,
    persistenceCapabilities: resolvePersistenceCapabilities({ adapter: 'sqlite', profile: 'local' })
  });
  assert.equal(runtime.approvalService, null);
  runtime.shutdown({ cancelQueued: false });
});
