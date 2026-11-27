'use strict';

const { Pool } = require('pg');
const path = require('node:path');
const { PostgresPersistence } = require('./postgres/postgres-persistence');
const JsonPersistence = require('./json-persistence');
const SqlitePersistence = require('./sqlite/sqlite-persistence');
const PersistenceCapabilityError = require('../../core/persistence/contracts/persistence-capability-errors');
const {
  preflightPersistence,
  verifyInitializedPersistence
} = require('./contracts/persistence-adapter-contract');

function initializationFailure(mode, profile, cause) {
  const error = new PersistenceCapabilityError({
    code: 'PERSISTENCE_INITIALIZATION_FAILED',
    message: 'Persistence adapter initialization failed',
    adapter: mode,
    profile,
    phase: 'initialization',
    expected: 'initialized adapter',
    actual: cause?.code || cause?.name || 'unknown'
  });
  error.cause = cause;
  return error;
}

function createPersistence(config) {
  const mode = config.persistenceMode || 'json';

  if (!['json', 'sqlite', 'postgres'].includes(mode)) {
    throw Object.assign(
      new Error(`Unsupported persistence mode "${mode}". Supported modes: json, sqlite, postgres`),
      { code: 'PERSISTENCE_MODE_UNSUPPORTED' }
    );
  }

  // This is deliberately the first persistence operation. The trusted static
  // manifest and profile requirements are checked before constructors can
  // create files, open SQLite, allocate a PostgreSQL pool, or run migrations.
  const profile = config.persistenceProfile || 'local';
  const resolvedCapabilities = preflightPersistence({
    mode,
    profile,
    enabledCapabilities: config.enabledPersistenceCapabilities || []
  });

  if (mode === 'sqlite') {
    const filePath = config.databaseFile || path.join(config.agentDataDirectory, 'orient.db');
    let adapter;
    try {
      adapter = new SqlitePersistence({ filePath });
    } catch (error) {
      throw initializationFailure(mode, profile, error);
    }
    return {
      adapter,
      resolvedCapabilities,
      verify: () => verifyInitializedPersistence({ mode, persistence: adapter, resolved: resolvedCapabilities }),
      initialize: async () => {},
      close: async () => adapter.close()
    };
  }

  if (mode === 'json') {
    let adapter;
    try {
      adapter = new JsonPersistence({ dataDirectory: config.agentDataDirectory });
    } catch (error) {
      throw initializationFailure(mode, profile, error);
    }
    return {
      adapter,
      resolvedCapabilities,
      verify: () => verifyInitializedPersistence({ mode, persistence: adapter, resolved: resolvedCapabilities }),
      close: async () => {}
    };
  }

  if (!config.databaseUrl) {
    throw Object.assign(
      new Error('ORIENT_PERSISTENCE=postgres requires ORIENT_DATABASE_URL'),
      { code: 'PERSISTENCE_DATABASE_URL_REQUIRED' }
    );
  }

  let pool;
  let adapter;
  try {
    pool = new Pool({
      connectionString: config.databaseUrl,
      max: config.databasePoolMax,
      idleTimeoutMillis: config.databaseIdleTimeoutMs,
      connectionTimeoutMillis: config.databaseConnectionTimeoutMs,
      application_name: 'orient-one'
    });
    adapter = new PostgresPersistence({ pool });
  } catch (error) {
    throw initializationFailure(mode, profile, error);
  }
  return {
    adapter,
    resolvedCapabilities,
    verify: () => verifyInitializedPersistence({ mode, persistence: adapter, resolved: resolvedCapabilities }),
    initialize: async () => {
      try {
        await adapter.initialize();
      } catch (error) {
        throw initializationFailure(mode, profile, error);
      }
    },
    close: () => pool.end()
  };
}

module.exports = createPersistence;
