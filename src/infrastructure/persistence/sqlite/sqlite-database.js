'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const ensurePrivateStorageDirectory = require('../../filesystem/private-storage-directory');

const SCHEMA_VERSION = 2;
const SIDECAR_SUFFIXES = ['-wal', '-shm', '-journal'];

function storageError(message, code, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function secureExistingFile(filePath, { required = false } = {}) {
  let stats;
  try {
    stats = fs.lstatSync(filePath, { bigint: true });
  } catch (error) {
    if (error.code === 'ENOENT' && !required) return false;
    if (error.code === 'ENOENT') {
      throw storageError('SQLite storage file was not created as expected', 'SQLITE_STORAGE_FILE_MISSING', error);
    }
    throw error;
  }

  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw storageError('SQLite database and sidecars must be regular files',
      'SQLITE_STORAGE_FILE_TYPE_INVALID');
  }
  if (stats.nlink !== 1n) {
    throw storageError('SQLite database and sidecars must have exactly one hard link',
      'SQLITE_STORAGE_FILE_LINKS_INVALID');
  }

  if (process.platform !== 'win32' && typeof process.getuid === 'function') {
    if (stats.uid !== BigInt(process.getuid())) {
      throw storageError('SQLite database and sidecars must be owned by the application user',
        'SQLITE_STORAGE_FILE_OWNER_INVALID');
    }
    if ((stats.mode & 0o7777n) !== 0o600n) {
      try {
        fs.chmodSync(filePath, 0o600);
      } catch (error) {
        throw storageError('SQLite file permissions could not be secured',
          'SQLITE_STORAGE_FILE_PERMISSIONS_INVALID', error);
      }
      stats = fs.lstatSync(filePath, { bigint: true });
      if (stats.isSymbolicLink() || !stats.isFile() ||
          stats.uid !== BigInt(process.getuid()) || stats.nlink !== 1n ||
          (stats.mode & 0o7777n) !== 0o600n) {
        throw storageError('SQLite file permissions could not be verified',
          'SQLITE_STORAGE_FILE_PERMISSIONS_INVALID');
      }
    }
  }
  return true;
}

const BASE_SCHEMA = [
  'CREATE TABLE IF NOT EXISTS memories (memory_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, scope TEXT NOT NULL, state TEXT NOT NULL, type TEXT NOT NULL, semantic_key TEXT, text TEXT NOT NULL, payload TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS idx_memories_tenant_scope ON memories(tenant_id, scope)',
  'CREATE INDEX IF NOT EXISTS idx_memories_semantic_key ON memories(tenant_id, scope, semantic_key)',
  'CREATE TABLE IF NOT EXISTS memory_audit (event_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, scope TEXT, memory_id TEXT, operation_id TEXT, occurred_at TEXT NOT NULL, payload TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS idx_memory_audit_operation ON memory_audit(tenant_id, scope, operation_id)',
  'CREATE INDEX IF NOT EXISTS idx_memory_audit_memory ON memory_audit(tenant_id, scope, memory_id)',
  'CREATE TABLE IF NOT EXISTS executions (execution_id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS events (event_id TEXT PRIMARY KEY, execution_id TEXT, goal_id TEXT, type TEXT NOT NULL, timestamp TEXT NOT NULL, payload TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS idx_events_execution ON events(execution_id)',
  'CREATE TABLE IF NOT EXISTS idempotency (key TEXT PRIMARY KEY, payload TEXT NOT NULL, status TEXT NOT NULL, updated_at TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS checkpoints (execution_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL, checkpoint_id TEXT NOT NULL UNIQUE, reason TEXT NOT NULL, created_at TEXT NOT NULL, snapshot TEXT NOT NULL, snapshot_sha256 TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS workflows (workflow_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, state TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS idx_workflows_tenant_state ON workflows(tenant_id, state)',
  "CREATE INDEX IF NOT EXISTS idx_workflows_approval_execution ON workflows(tenant_id, json_extract(payload, '$.metadata.approvalExecutionId')) WHERE json_extract(payload, '$.metadata.approvalBlocked') = 1",
  'CREATE TABLE IF NOT EXISTS workflow_leases (workflow_id TEXT PRIMARY KEY, lease_id TEXT NOT NULL UNIQUE, worker_id TEXT NOT NULL, acquired_at TEXT NOT NULL, expires_at TEXT NOT NULL, payload TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS idx_workflow_leases_expiry ON workflow_leases(expires_at)',
  'CREATE TABLE IF NOT EXISTS approvals (approval_id TEXT PRIMARY KEY, execution_id TEXT NOT NULL, step INTEGER NOT NULL, plan_revision INTEGER NOT NULL, tool TEXT NOT NULL, capability TEXT NOT NULL, scope TEXT NOT NULL, issued_at TEXT NOT NULL, expires_at TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0, used_at TEXT, metadata TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS idx_approvals_execution ON approvals(execution_id)',
  'CREATE INDEX IF NOT EXISTS idx_approvals_expiry ON approvals(expires_at)'
].join(';\n');

class SqliteDatabase {
  constructor(filePath) {
    if (typeof filePath !== 'string' || !filePath.trim()) throw new TypeError('filePath is required');
    this.connection = null;
    this.closed = false;
    this.filePath = ':memory:';

    try {
      if (filePath !== ':memory:') {
        const requested = path.resolve(filePath);
        const basename = path.basename(requested);
        if (!basename || basename === '.' || basename === path.sep) {
          throw storageError('SQLite path must identify a file', 'SQLITE_STORAGE_PATH_INVALID');
        }
        const directory = ensurePrivateStorageDirectory(path.dirname(requested), {
          mode: 0o700, repairPermissions: true, create: true
        });
        this.filePath = path.join(directory, basename);
        secureExistingFile(this.filePath);
        this.assertSidecarsSecure();
      }

      this.connection = new DatabaseSync(this.filePath);

      // DatabaseSync opens by path and does not accept a pre-opened descriptor
      // or O_NOFOLLOW. The private parent directory is the primary cross-UID
      // race boundary; this immediate post-open check detects path substitution.
      if (this.filePath !== ':memory:') {
        secureExistingFile(this.filePath, { required: true });
        this.assertSidecarsSecure();
      }

      this.connection.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
      this.assertSupportedSchemaVersion();
      const journal = this.connection.prepare('PRAGMA journal_mode=WAL').get();
      if (this.filePath !== ':memory:' &&
          String(journal?.journal_mode || '').toLowerCase() !== 'wal') {
        throw storageError('SQLite could not enable WAL journal mode', 'SQLITE_WAL_MODE_UNAVAILABLE');
      }
      if (this.filePath !== ':memory:') {
        secureExistingFile(this.filePath, { required: true });
        this.assertSidecarsSecure();
      }

      this.initialize();
      if (this.filePath !== ':memory:') {
        secureExistingFile(this.filePath, { required: true });
        this.assertSidecarsSecure();
      }
    } catch (error) {
      this.closed = true;
      if (this.connection) {
        try { this.connection.close(); }
        catch (closeError) {
          if (!error.cause) error.cause = closeError;
          else error.closeError = closeError;
        }
      }
      throw error;
    }
  }

  assertOpen() {
    if (this.closed || !this.connection) {
      throw storageError('SQLite database connection is closed', 'SQLITE_CONNECTION_CLOSED');
    }
  }

  assertSupportedSchemaVersion() {
    const migrationTable = this.connection.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='schema_migrations'"
    ).get();
    if (!migrationTable) return;
    const row = this.connection.prepare(
      'SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations'
    ).get();
    if (Number(row?.version || 0) > SCHEMA_VERSION) {
      throw storageError('SQLite schema is newer than this ORIENT version supports',
        'SQLITE_SCHEMA_VERSION_UNSUPPORTED');
    }
  }

  assertSidecarsSecure() {
    for (const suffix of SIDECAR_SUFFIXES) secureExistingFile(this.filePath + suffix);
  }

  run(sql, params = []) {
    this.assertOpen();
    if (typeof sql !== 'string' || !sql.trim()) throw new TypeError('SQL statement is required');
    if (!Array.isArray(params)) throw new TypeError('SQL parameters must be an array');
    if (params.length === 0 && sql.trim().includes(';') &&
        sql.trim().split(';').filter(part => part.trim()).length > 1) {
      throw new TypeError('run() accepts one prepared statement; use exec() only for static SQL batches');
    }
    return this.connection.prepare(sql).run(...params);
  }

  query(sql, params = []) {
    this.assertOpen();
    if (typeof sql !== 'string' || !sql.trim()) throw new TypeError('SQL statement is required');
    if (!Array.isArray(params)) throw new TypeError('SQL parameters must be an array');
    return this.connection.prepare(sql).all(...params);
  }

  exec(sql) {
    this.assertOpen();
    if (typeof sql !== 'string' || !sql.trim()) throw new TypeError('SQL batch is required');
    return this.connection.exec(sql);
  }

  transaction(statementsOrCallback) {
    this.assertOpen();
    if (typeof statementsOrCallback === 'function') {
      this.connection.exec('BEGIN IMMEDIATE;');
      try {
        const result = statementsOrCallback();
        this.connection.exec('COMMIT;');
        return result;
      } catch (error) {
        try { this.connection.exec('ROLLBACK;'); } catch {}
        throw error;
      }
    }

    const statements = statementsOrCallback;
    if (!Array.isArray(statements) || !statements.length) return;
    this.connection.exec('BEGIN IMMEDIATE;');
    try {
      for (const statement of statements) {
        if (typeof statement === 'string') {
          this.connection.exec(statement);
          continue;
        }
        if (!statement || typeof statement.sql !== 'string' ||
            !Array.isArray(statement.params || [])) {
          throw new TypeError('Transaction statements must be SQL strings or { sql, params } objects');
        }
        this.connection.prepare(statement.sql).run(...(statement.params || []));
      }
      this.connection.exec('COMMIT;');
    } catch (error) {
      try { this.connection.exec('ROLLBACK;'); } catch {}
      throw error;
    }
  }

  initialize() {
    this.transaction(() => {
      this.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
      const currentVersion = Number(
        this.query('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations')[0].version
      );
      if (currentVersion > SCHEMA_VERSION) {
        throw storageError('SQLite schema is newer than this ORIENT version supports',
          'SQLITE_SCHEMA_VERSION_UNSUPPORTED');
      }

      this.exec(BASE_SCHEMA);
      if (currentVersion < 1) {
        this.run("INSERT INTO schema_migrations(version, applied_at) VALUES (1, datetime('now'))");
      }

      if (currentVersion < 2) {
        const eventColumns = new Set(this.query('PRAGMA table_info(events)').map(column => column.name));
        if (!eventColumns.has('tenant_id')) {
          this.exec("ALTER TABLE events ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'local'");
        }
        if (!eventColumns.has('aggregate_id')) this.exec('ALTER TABLE events ADD COLUMN aggregate_id TEXT');
        if (!eventColumns.has('sequence')) this.exec('ALTER TABLE events ADD COLUMN sequence INTEGER');

        this.exec([
          "UPDATE events SET tenant_id = COALESCE(json_extract(payload, '$.data.tenantId'), 'local'), aggregate_id = COALESCE(json_extract(payload, '$.aggregateId'), json_extract(payload, '$.workflowId')) WHERE aggregate_id IS NULL OR tenant_id IS NULL",
          'WITH ranked AS (SELECT event_id, ROW_NUMBER() OVER (PARTITION BY tenant_id, aggregate_id ORDER BY timestamp ASC, event_id ASC) AS next_sequence FROM events WHERE aggregate_id IS NOT NULL) UPDATE events SET sequence = (SELECT next_sequence FROM ranked WHERE ranked.event_id = events.event_id) WHERE aggregate_id IS NOT NULL AND sequence IS NULL',
          'CREATE INDEX IF NOT EXISTS idx_events_tenant_aggregate ON events(tenant_id, aggregate_id, sequence)',
          "CREATE INDEX IF NOT EXISTS idx_workflows_pending_publications ON workflows(tenant_id, updated_at) WHERE json_extract(payload, '$.metadata.approvalBlocked') = 1 AND CASE WHEN json_type(payload, '$.metadata.pendingPublications') = 'array' THEN json_array_length(payload, '$.metadata.pendingPublications') ELSE 0 END > 0",
          'CREATE UNIQUE INDEX IF NOT EXISTS idx_events_tenant_aggregate_sequence ON events(tenant_id, aggregate_id, sequence) WHERE aggregate_id IS NOT NULL AND sequence IS NOT NULL'
        ].join(';\n'));
        this.run("INSERT INTO schema_migrations(version, applied_at) VALUES (2, datetime('now'))");
      }
      this.verifySchema();
    });
  }

  verifySchema() {
    const requiredTables = [
      'schema_migrations', 'memories', 'memory_audit', 'executions', 'events',
      'idempotency', 'checkpoints', 'workflows', 'workflow_leases', 'approvals'
    ];
    const tables = new Set(this.query("SELECT name FROM sqlite_master WHERE type='table'").map(row => row.name));
    for (const table of requiredTables) {
      if (!tables.has(table)) {
        throw storageError('SQLite schema is missing required table: ' + table, 'SQLITE_SCHEMA_INVALID');
      }
    }
    const eventColumns = new Set(this.query('PRAGMA table_info(events)').map(column => column.name));
    for (const column of ['tenant_id', 'aggregate_id', 'sequence']) {
      if (!eventColumns.has(column)) {
        throw storageError('SQLite events schema is missing required column: ' + column, 'SQLITE_SCHEMA_INVALID');
      }
    }
    const version = Number(
      this.query('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations')[0].version
    );
    if (version !== SCHEMA_VERSION) {
      throw storageError('SQLite schema migration did not reach the expected version',
        'SQLITE_SCHEMA_VERSION_INCOMPLETE');
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.connection) {
      const connection = this.connection;
      this.connection = null;
      connection.close();
    }
  }
}

module.exports = SqliteDatabase;
