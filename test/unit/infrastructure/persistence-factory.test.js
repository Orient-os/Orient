const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const createPersistence = require('../../../src/infrastructure/persistence/persistence-factory');

test('persistence factory defaults to local JSON without database configuration', async t => {
  const agentDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-test-data-'));
  t.after(() => fs.rmSync(agentDataDirectory, { recursive: true, force: true }));

  const runtime = createPersistence({
    persistenceMode: 'json',
    agentDataDirectory
  });

  assert.equal(runtime.adapter.health().adapter, 'json');
  await runtime.close();
});

test('persistence factory fails closed when PostgreSQL mode has no URL', () => {
  assert.throws(
    () => createPersistence({
      persistenceMode: 'postgres',
      databaseUrl: ''
    }),
    error => error.message.includes('ORIENT_PERSISTENCE=postgres requires ORIENT_DATABASE_URL')
  );
});

test('persistence factory does not silently downgrade PostgreSQL mode', () => {
  assert.throws(
    () => createPersistence({
      persistenceMode: 'postgres',
      databaseUrl: ''
    }),
    error => !error.message.includes('json')
  );
});


test('JSON persistence passes the trusted preflight and initialized adapter contract', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-persistence-contract-'));
  try {
    const runtime = createPersistence({
      persistenceMode: 'json',
      persistenceProfile: 'local',
      agentDataDirectory: directory
    });
    assert.equal(runtime.resolvedCapabilities.contractVersion, '1.0.0');
    assert.equal(runtime.verify().verified, true);
    runtime.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('SQLite capability preflight fails before opening a database or applying migrations', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-sqlite-preflight-'));
  const filePath = path.join(directory, 'must-not-exist.db');
  try {
    assert.throws(
      () => createPersistence({
        persistenceMode: 'sqlite',
        persistenceProfile: 'local',
        databaseFile: filePath,
        agentDataDirectory: directory
      }),
      error => error.code === 'PERSISTENCE_GUARANTEE_UNSATISFIED' &&
        error.guarantee === 'idempotency.terminal.protection' &&
        error.phase === 'preflight'
    );
    assert.equal(fs.existsSync(filePath), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('unknown requested capabilities fail closed during preflight', () => {
  assert.throws(
    () => createPersistence({
      persistenceMode: 'json',
      enabledPersistenceCapabilities: ['invented.capability'],
      agentDataDirectory: path.join(os.tmpdir(), 'orient-unused-contract-dir')
    }),
    error => error.code === 'PERSISTENCE_CAPABILITY_MISSING'
  );
});


test('persistence constructor failures return a structured initialization diagnostic', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-persistence-init-failure-'));
  const blockedDirectory = path.join(root, 'not-a-directory');
  fs.writeFileSync(blockedDirectory, 'file');
  try {
    assert.throws(
      () => createPersistence({
        persistenceMode: 'json',
        persistenceProfile: 'local',
        enabledPersistenceCapabilities: ['workflow.ephemeral'],
        agentDataDirectory: blockedDirectory
      }),
      error => error.code === 'PERSISTENCE_INITIALIZATION_FAILED' &&
        error.phase === 'initialization' &&
        error.adapter === 'json' &&
        error.actual === 'EEXIST'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
