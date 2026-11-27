'use strict';

const { Pool } = require('pg');
const path = require('node:path');
const { PostgresPersistence } = require('./postgres/postgres-persistence');
const JsonPersistence = require('./json-persistence');
const SqlitePersistence = require('./sqlite/sqlite-persistence');
const {
  preflightPersistence,
  verifyInitializedPersistence
} = require('./contracts/persistence-adapter-contract');

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
  const resolvedCapabilities = preflightPersistence({
    mode,
    profile: config.persistenceProfile || 'local',
    enabledCapabilities: config.enabledPersistenceCapabilities || []
  });

  if (mode === 'sqlite') {
    const filePath = config.databaseFile || path.join(config.agentDataDirectory, 'orient.db');
    const adapter = new SqlitePersistence({ filePath });
    return {
      adapter,
      resolvedCapabilities,
      verify: () => verifyInitializedPersistence({ mode, persistence: adapter, resolved: resolvedCapabilities }),
      initialize: async () => {},
      close: async () => adapter.close()
    };
  }

  if (mode === 'json') {
    const adapter = new JsonPersistence({ dataDirectory: config.agentDataDirectory });
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

  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: config.databasePoolMax,
    idleTimeoutMillis: config.databaseIdleTimeoutMs,
    connectionTimeoutMillis: config.databaseConnectionTimeoutMs,
    application_name: 'orient-one'
  });
  const adapter = new PostgresPersistence({ pool });
  return {
    adapter,
    resolvedCapabilities,
    verify: () => verifyInitializedPersistence({ mode, persistence: adapter, resolved: resolvedCapabilities }),
    initialize: () => adapter.initialize(),
    close: () => pool.end()
  };
}

module.exports = createPersistence;
