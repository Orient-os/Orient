'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const SqliteDatabase = require('../../../src/infrastructure/persistence/sqlite/sqlite-database');

function withDirectory(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-sqlite-hardening-'));
  try { return run(directory); }
  finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

function runChild(filePath) {
  return new Promise((resolve, reject) => {
    const modulePath = path.resolve(__dirname, '../../../src/infrastructure/persistence/sqlite/sqlite-database.js');
    const child = spawn(process.execPath, ['-e',
      "const Database = require(process.argv[1]); const db = new Database(process.argv[2]); " +
      "const version = db.query('SELECT MAX(version) AS version FROM schema_migrations')[0].version; " +
      "db.close(); process.stdout.write(String(version));",
      modulePath, filePath
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => code === 0
      ? resolve(stdout)
      : reject(new Error('SQLite child failed (' + code + '): ' + stderr)));
  });
}

test('file-backed SQLite creates a private directory and a 0600 database file', () => {
  withDirectory(directory => {
    const filePath = path.join(directory, 'nested', 'orient.db');
    const db = new SqliteDatabase(filePath);
    try {
      assert.equal(fs.statSync(path.dirname(filePath)).mode & 0o777, 0o700);
      assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
      assert.equal(db.query('PRAGMA journal_mode')[0].journal_mode, 'wal');
    } finally { db.close(); }
  });
});

test('existing service-owned database permissions are tightened to 0600', () => {
  withDirectory(directory => {
    const filePath = path.join(directory, 'orient.db');
    new SqliteDatabase(filePath).close();
    fs.chmodSync(filePath, 0o644);
    const db = new SqliteDatabase(filePath);
    try { assert.equal(fs.statSync(filePath).mode & 0o777, 0o600); }
    finally { db.close(); }
  });
});

test('rejects a symbolic link at the database path', () => {
  withDirectory(directory => {
    const target = path.join(directory, 'target.db');
    new SqliteDatabase(target).close();
    const alias = path.join(directory, 'orient.db');
    fs.symlinkSync(target, alias);
    assert.throws(() => new SqliteDatabase(alias),
      error => error.code === 'SQLITE_STORAGE_FILE_TYPE_INVALID');
  });
});

test('rejects a hard-linked database instead of opening a shared inode', () => {
  withDirectory(directory => {
    const filePath = path.join(directory, 'orient.db');
    new SqliteDatabase(filePath).close();
    fs.linkSync(filePath, path.join(directory, 'second-name.db'));
    assert.throws(() => new SqliteDatabase(filePath),
      error => error.code === 'SQLITE_STORAGE_FILE_LINKS_INVALID');
  });
});

test('rejects a symbolic link in a pre-existing SQLite sidecar', () => {
  withDirectory(directory => {
    const filePath = path.join(directory, 'orient.db');
    new SqliteDatabase(filePath).close();
    const target = path.join(directory, 'sidecar-target');
    fs.writeFileSync(target, 'not a SQLite sidecar', { mode: 0o600 });
    fs.symlinkSync(target, filePath + '-wal');
    assert.throws(() => new SqliteDatabase(filePath),
      error => error.code === 'SQLITE_STORAGE_FILE_TYPE_INVALID');
  });
});

test('schema migration is atomic when a legacy unique-index invariant fails', () => {
  withDirectory(directory => {
    const filePath = path.join(directory, 'legacy.db');
    const raw = new DatabaseSync(filePath);
    raw.exec([
      'CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)',
      "INSERT INTO schema_migrations(version, applied_at) VALUES (1, 'legacy')",
      'CREATE TABLE events (event_id TEXT PRIMARY KEY, execution_id TEXT, goal_id TEXT, type TEXT NOT NULL, timestamp TEXT NOT NULL, payload TEXT NOT NULL, tenant_id TEXT NOT NULL, aggregate_id TEXT, sequence INTEGER)',
      "INSERT INTO events VALUES ('e1', NULL, NULL, 'test', '2026-01-01', '{}', 'tenant-a', 'aggregate-a', 1)",
      "INSERT INTO events VALUES ('e2', NULL, NULL, 'test', '2026-01-02', '{}', 'tenant-a', 'aggregate-a', 1)"
    ].join(';'));
    raw.close();
    fs.chmodSync(filePath, 0o600);

    assert.throws(() => new SqliteDatabase(filePath));
    const verify = new DatabaseSync(filePath);
    try {
      const versions = verify.prepare('SELECT version FROM schema_migrations ORDER BY version').all();
      assert.deepEqual(versions.map(row => Number(row.version)), [1]);
      const index = verify.prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_events_tenant_aggregate_sequence'"
      ).all();
      assert.equal(index.length, 0);
    } finally { verify.close(); }
  });
});

test('rejects a database schema version newer than the running application', () => {
  withDirectory(directory => {
    const filePath = path.join(directory, 'future.db');
    const raw = new DatabaseSync(filePath);
    raw.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL); INSERT INTO schema_migrations VALUES (3, 'future');");
    raw.close();
    fs.chmodSync(filePath, 0o600);
    assert.throws(() => new SqliteDatabase(filePath),
      error => error.code === 'SQLITE_SCHEMA_VERSION_UNSUPPORTED');
    const verify = new DatabaseSync(filePath);
    try {
      assert.equal(verify.prepare('PRAGMA journal_mode').get().journal_mode, 'delete');
    } finally { verify.close(); }
  });
});

test('two independent processes serialize first-time schema migration', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-sqlite-race-'));
  try {
    const filePath = path.join(directory, 'concurrent.db');
    const results = await Promise.all([runChild(filePath), runChild(filePath)]);
    assert.deepEqual(results.sort(), ['2', '2']);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('close is idempotent and operations reject after close', () => {
  const db = new SqliteDatabase(':memory:');
  assert.equal(db.query('SELECT 1 AS value')[0].value, 1);
  db.close();
  assert.doesNotThrow(() => db.close());
  assert.throws(() => db.query('SELECT 1'),
    error => error.code === 'SQLITE_CONNECTION_CLOSED');
});

test('in-memory SQLite remains independent of private filesystem setup', () => {
  const db = new SqliteDatabase(':memory:');
  try {
    assert.equal(db.filePath, ':memory:');
    assert.equal(db.query('PRAGMA journal_mode')[0].journal_mode, 'memory');
    assert.equal(db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='memories'").length, 1);
  } finally { db.close(); }
});

test('rejects a hard-linked SQLite sidecar before opening the database', () => {
  withDirectory(directory => {
    const filePath = path.join(directory, 'orient.db');
    const target = path.join(directory, 'sidecar-target');
    fs.writeFileSync(target, 'untrusted sidecar', { mode: 0o600 });
    fs.linkSync(target, filePath + '-shm');
    assert.throws(() => new SqliteDatabase(filePath),
      error => error.code === 'SQLITE_STORAGE_FILE_LINKS_INVALID');
  });
});

test('rejects a non-regular SQLite sidecar', () => {
  withDirectory(directory => {
    const filePath = path.join(directory, 'orient.db');
    fs.mkdirSync(filePath + '-journal');
    assert.throws(() => new SqliteDatabase(filePath),
      error => error.code === 'SQLITE_STORAGE_FILE_TYPE_INVALID');
  });
});

test('WAL and SHM files are private while a file-backed connection is active', () => {
  withDirectory(directory => {
    const filePath = path.join(directory, 'orient.db');
    const db = new SqliteDatabase(filePath);
    try {
      db.run(
        'INSERT INTO memories(memory_id, tenant_id, scope, state, type, text, payload) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ['wal-permissions', 'tenant-a', 'private', 'active', 'note', 'wal test', '{}']
      );
      for (const suffix of ['-wal', '-shm']) {
        const sidecar = filePath + suffix;
        assert.equal(fs.existsSync(sidecar), true, suffix + ' should exist during an active WAL connection');
        const stats = fs.lstatSync(sidecar, { bigint: true });
        assert.equal(stats.isFile(), true);
        assert.equal(stats.nlink, 1n);
        if (typeof process.getuid === 'function') {
          assert.equal(stats.uid, BigInt(process.getuid()));
        }
        assert.equal(stats.mode & 0o7777n, 0o600n);
      }
    } finally { db.close(); }
  });
});

test('committed WAL data survives abrupt process termination and restart', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-sqlite-wal-recovery-'));
  try {
    const filePath = path.join(directory, 'recovery.db');
    const modulePath = path.resolve(__dirname, '../../../src/infrastructure/persistence/sqlite/sqlite-database.js');
    const source = [
      "const Database = require(process.argv[1]);",
      "const db = new Database(process.argv[2]);",
      "db.run('INSERT INTO memories(memory_id, tenant_id, scope, state, type, text, payload) VALUES (?, ?, ?, ?, ?, ?, ?)', ['crash-recovery', 'tenant-a', 'private', 'active', 'note', 'durable', '{}']);",
      "process.exit(0);"
    ].join('');
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', source, modulePath, filePath], {
        stdio: ['ignore', 'ignore', 'pipe']
      });
      let stderr = '';
      child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
      child.once('error', reject);
      child.once('close', code => code === 0
        ? resolve()
        : reject(new Error('SQLite crash-writer failed (' + code + '): ' + stderr)));
    });

    const db = new SqliteDatabase(filePath);
    try {
      const rows = db.query('SELECT text FROM memories WHERE memory_id = ?', ['crash-recovery']);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].text, 'durable');
    } finally { db.close(); }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
