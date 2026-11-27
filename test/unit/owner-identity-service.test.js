'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const OwnerIdentityService = require('../../src/core/security/owner-identity-service');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-owner-identity-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, stateFile: path.join(directory, 'owner.json') };
}

test('owner identity bootstrap stores only a password hash and forces rotation', t => {
  const { directory, stateFile } = fixture(t);
  const temporary = 'temporary-owner-password-9F!x';
  const identity = new OwnerIdentityService({ stateFile, bootstrapPassword: temporary });
  assert.equal(identity.createdBootstrap, true);
  assert.equal(identity.consumeBootstrapPassword(), temporary);
  assert.equal(identity.consumeBootstrapPassword(), null);
  assert.equal(identity.status().passwordChangeRequired, true);
  const persisted = fs.readFileSync(stateFile, 'utf8');
  assert.equal(persisted.includes(temporary), false);
  assert.match(JSON.parse(persisted).passwordHash, /^[a-f0-9]{128}:[a-f0-9]{32}$/);
  assert.equal((fs.statSync(directory).mode & 0o077), 0);
  assert.equal((fs.statSync(stateFile).mode & 0o077), 0, 'owner state file must not be readable by group or others');
});

test('password rotation revokes old owner sessions and returns one replacement session', async t => {
  const { stateFile } = fixture(t);
  const identity = new OwnerIdentityService({ stateFile, bootstrapPassword: 'temporary-owner-password-9F!x' });
  const login = await identity.login({ username: 'Admin', password: 'temporary-owner-password-9F!x' });
  assert.equal(login.ok, true);
  const changed = await identity.changePassword({
    token: login.token,
    password: 'permanent-owner-password-2026!',
    confirmPassword: 'permanent-owner-password-2026!'
  });
  assert.equal(changed.ok, true);
  assert.equal(changed.passwordChangeRequired, false);
  assert.equal(identity.authenticate(login.token), null);
  assert.ok(identity.authenticate(changed.token));
  const reloaded = new OwnerIdentityService({ stateFile });
  assert.ok(reloaded.authenticate(changed.token));
  assert.equal((await reloaded.login({ username: 'Admin', password: 'temporary-owner-password-9F!x' })).ok, false);
  assert.equal((await reloaded.login({ username: 'Admin', password: 'permanent-owner-password-2026!' })).ok, true);
});

test('public-user tokens cannot authenticate as owner and owner mutations require CSRF verification', async t => {
  const { stateFile } = fixture(t);
  const identity = new OwnerIdentityService({ stateFile, bootstrapPassword: 'temporary-owner-password-9F!x' });
  assert.equal(identity.authenticate('public-user-session-token-not-an-owner'), null);
  const login = await identity.login({ username: 'Admin', password: 'temporary-owner-password-9F!x' });
  const session = identity.authenticate(login.token);
  assert.ok(session);
  assert.equal(identity.verifyCsrf(session, login.csrfToken), true);
  assert.equal(identity.verifyCsrf(session, 'wrong-token'), false);
  assert.equal(identity.logout(login.token), true);
  assert.equal(identity.authenticate(login.token), null);
});

test('owner identity session IDs are non-secret, independently revocable, and expire at the boundary', async t => {
  const { stateFile } = fixture(t);
  let now = 1000;
  const identity = new OwnerIdentityService({
    stateFile,
    bootstrapPassword: 'temporary-owner-password-9F!x',
    sessionTtlMs: 1000,
    now: () => now
  });
  const first = await identity.login({ username: 'Admin', password: 'temporary-owner-password-9F!x' });
  const second = await identity.login({ username: 'Admin', password: 'temporary-owner-password-9F!x' });
  const firstSession = identity.authenticate(first.token);
  const secondSession = identity.authenticate(second.token);
  assert.match(firstSession.sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.notEqual(firstSession.sessionId, secondSession.sessionId);
  assert.equal(identity.isActiveSession(firstSession.sessionId), true);
  assert.equal(identity.isActiveSession(secondSession.sessionId), true);
  assert.equal(identity.isActiveSession('unknown-session-id'), false);
  assert.equal(identity.logout(first.token), true);
  assert.equal(identity.isActiveSession(firstSession.sessionId), false);
  assert.equal(identity.isActiveSession(secondSession.sessionId), true);
  now += 1000;
  assert.equal(identity.isActiveSession(secondSession.sessionId), false);
  assert.equal(identity.sessions.size, 0);
  const restarted = new OwnerIdentityService({ stateFile, now: () => now });
  assert.equal(restarted.isActiveSession(secondSession.sessionId), false);
});

test('invalid owner state fails closed instead of silently resetting credentials', t => {
  const { stateFile } = fixture(t);
  fs.writeFileSync(stateFile, '{"version":1,"passwordHash":"invalid"}');
  assert.throws(() => new OwnerIdentityService({ stateFile }), { code: 'OWNER_IDENTITY_STATE_INVALID' });
});

test('legacy website owner.json migrates without losing the existing password and forces password rotation', async t => {
  const { stateFile } = fixture(t);
  const legacyPassword = 'legacy-temporary-owner-password-2026!';
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(legacyPassword, salt, 64).toString('hex');
  fs.writeFileSync(stateFile, JSON.stringify({
    version: 1,
    username: 'Admin',
    password: { salt, hash },
    mustChangePassword: true,
    createdAt: new Date(0).toISOString()
  }), { mode: 0o600 });

  const identity = new OwnerIdentityService({ stateFile });
  assert.equal(identity.status().passwordChangeRequired, true);
  const migrated = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(typeof migrated.password, 'undefined');
  assert.match(migrated.passwordHash, /^legacy:[a-f0-9]{128}:[a-f0-9]{32}$/);
  const login = await identity.login({ username: 'Admin', password: legacyPassword });
  assert.equal(login.ok, true);
  assert.equal(login.passwordChangeRequired, true);

  const changed = await identity.changePassword({
    token: login.token,
    password: 'new-permanent-owner-password-2026!',
    confirmPassword: 'new-permanent-owner-password-2026!'
  });
  assert.equal(changed.ok, true);
  assert.match(JSON.parse(fs.readFileSync(stateFile, 'utf8')).passwordHash, /^[a-f0-9]{128}:[a-f0-9]{32}$/);
  assert.equal((await identity.login({ username: 'Admin', password: legacyPassword })).ok, false);
  assert.equal((await identity.login({ username: 'Admin', password: 'new-permanent-owner-password-2026!' })).ok, true);
});

test('owner identity persistence syncs the state file and containing directory', t => {
  const { directory, stateFile } = fixture(t);
  let fileSyncs = 0;
  let directorySyncs = 0;
  const originalFsync = fs.fsyncSync;

  fs.fsyncSync = function (fd) {
    if (fs.fstatSync(fd).isDirectory()) directorySyncs += 1;
    else fileSyncs += 1;
    return originalFsync.call(fs, fd);
  };

  try {
    new OwnerIdentityService({
      stateFile,
      bootstrapPassword: 'temporary-owner-password-9F!x'
    });
  } finally {
    fs.fsyncSync = originalFsync;
  }

  assert.ok(fileSyncs >= 1, 'state file must be flushed before rename');
  if (process.platform === 'win32') {
    assert.equal(directorySyncs, 0, 'Windows has no portable directory-fsync support in Node');
  } else {
    assert.ok(directorySyncs >= 1, 'containing directory must be flushed after rename');
  }
  assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600);
  assert.deepEqual(
    fs.readdirSync(directory).filter(name => name.endsWith('.tmp')),
    [],
    'successful persistence must not leave temporary files behind'
  );
});


test('failed session creation compensates a post-rename durability error without persisting an unreachable session', t => {
  const { stateFile } = fixture(t);
  const identity = new OwnerIdentityService({ stateFile, bootstrapPassword: 'temporary-owner-password-9F!x' });
  const originalFsync = fs.fsyncSync;
  let failDirectorySync = true;
  fs.fsyncSync = function (fd) {
    if (failDirectorySync && fs.fstatSync(fd).isDirectory()) {
      failDirectorySync = false;
      const error = new Error('simulated directory fsync failure');
      error.code = 'EIO';
      throw error;
    }
    return originalFsync.call(fs, fd);
  };

  try {
    assert.throws(() => identity.createSession(), error =>
      error.code === 'OWNER_IDENTITY_PERSIST_FAILED' && error.committed === true);
  } finally {
    fs.fsyncSync = originalFsync;
  }

  assert.equal(identity.sessions.size, 0, 'failed session creation must not leave an accepted in-memory session');
  assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')).sessions, [],
    'compensating write must remove the session whose token was never returned');
});

test('directory-sync failure after rename does not restore revoked owner sessions', async t => {
  const { stateFile } = fixture(t);
  const identity = new OwnerIdentityService({
    stateFile,
    bootstrapPassword: 'temporary-owner-password-9F!x'
  });
  const login = await identity.login({
    username: 'Admin',
    password: 'temporary-owner-password-9F!x'
  });
  assert.equal(login.ok, true);

  const originalFsync = fs.fsyncSync;
  let failedDirectorySync = false;
  fs.fsyncSync = function (fd) {
    if (!failedDirectorySync && fs.fstatSync(fd).isDirectory()) {
      failedDirectorySync = true;
      const error = new Error('simulated directory fsync failure');
      error.code = 'EIO';
      throw error;
    }
    return originalFsync.call(fs, fd);
  };

  let failure;
  try {
    await assert.rejects(
      identity.changePassword({
        token: login.token,
        password: 'new-permanent-owner-password-2026!',
        confirmPassword: 'new-permanent-owner-password-2026!'
      }),
      error => {
        failure = error;
        return error.code === 'OWNER_IDENTITY_PERSIST_FAILED' && error.committed === true;
      }
    );
  } finally {
    fs.fsyncSync = originalFsync;
  }

  assert.ok(failedDirectorySync, 'the directory durability barrier must be attempted');
  assert.ok(failure);
  assert.equal(identity.authenticate(login.token), null, 'old sessions remain revoked after rename committed');
  const relogin = await identity.login({
    username: 'Admin',
    password: 'new-permanent-owner-password-2026!'
  });
  assert.equal(relogin.ok, true, 'the committed password must match in-memory state');
});

test('owner identity state refuses symbolic links without reading their targets', t => {
  const { directory, stateFile } = fixture(t);
  new OwnerIdentityService({
    stateFile,
    bootstrapPassword: 'temporary-owner-password-9F!x'
  });

  const targetFile = path.join(directory, 'owner-state-target.json');
  fs.renameSync(stateFile, targetFile);
  fs.symlinkSync(targetFile, stateFile);

  assert.throws(
    () => new OwnerIdentityService({ stateFile }),
    error => error.code === 'OWNER_IDENTITY_STATE_INVALID'
  );
  assert.equal(fs.lstatSync(stateFile).isSymbolicLink(), true);
  assert.equal(fs.statSync(targetFile).isFile(), true);
});

test('owner identity state size is rejected from descriptor metadata before reading bytes', t => {
  const { stateFile } = fixture(t);
  fs.writeFileSync(stateFile, Buffer.alloc(2 * 1024 * 1024 + 1, 0x20), { mode: 0o600 });

  const originalReadFileSync = fs.readFileSync;
  fs.readFileSync = function (target, ...args) {
    if (path.resolve(String(target)) === stateFile) {
      throw new Error('state file must not be read before its size is checked');
    }
    return originalReadFileSync.call(this, target, ...args);
  };
  try {
    assert.throws(
      () => new OwnerIdentityService({ stateFile }),
      error => error.code === 'OWNER_IDENTITY_STATE_INVALID'
    );
  } finally {
    fs.readFileSync = originalReadFileSync;
  }
});

test('failed pre-rename logout preserves the committed session in memory and after restart', async t => {
  const { stateFile } = fixture(t);
  const identity = new OwnerIdentityService({
    stateFile,
    bootstrapPassword: 'temporary-owner-password-9F!x'
  });
  const login = await identity.login({
    username: 'Admin',
    password: 'temporary-owner-password-9F!x'
  });
  assert.equal(login.ok, true);

  const originalFsync = fs.fsyncSync;
  let failed = false;
  fs.fsyncSync = function (fd) {
    if (!failed && !fs.fstatSync(fd).isDirectory()) {
      failed = true;
      throw Object.assign(new Error('simulated owner-state file fsync failure'), { code: 'EIO' });
    }
    return originalFsync.call(fs, fd);
  };
  try {
    assert.throws(
      () => identity.logout(login.token),
      error => error.code === 'OWNER_IDENTITY_PERSIST_FAILED' && error.committed === false
    );
  } finally {
    fs.fsyncSync = originalFsync;
  }

  assert.equal(failed, true);
  assert.ok(identity.authenticate(login.token), 'a failed logout must not leave memory more revoked than durable state');
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).sessions.length, 1);
  const restarted = new OwnerIdentityService({ stateFile });
  assert.ok(restarted.authenticate(login.token), 'the still-committed session remains valid after restart');
});

test('failed pre-rename revoke-all restores every committed session in memory and after restart', async t => {
  const { stateFile } = fixture(t);
  const identity = new OwnerIdentityService({
    stateFile,
    bootstrapPassword: 'temporary-owner-password-9F!x'
  });
  const first = await identity.login({ username: 'Admin', password: 'temporary-owner-password-9F!x' });
  const second = await identity.login({ username: 'Admin', password: 'temporary-owner-password-9F!x' });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);

  const originalFsync = fs.fsyncSync;
  let failed = false;
  fs.fsyncSync = function (fd) {
    if (!failed && !fs.fstatSync(fd).isDirectory()) {
      failed = true;
      throw Object.assign(new Error('simulated owner-state file fsync failure'), { code: 'EIO' });
    }
    return originalFsync.call(fs, fd);
  };
  try {
    assert.throws(
      () => identity.revokeAllSessions(),
      error => error.code === 'OWNER_IDENTITY_PERSIST_FAILED' && error.committed === false
    );
  } finally {
    fs.fsyncSync = originalFsync;
  }

  assert.equal(failed, true);
  assert.ok(identity.authenticate(first.token));
  assert.ok(identity.authenticate(second.token));
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).sessions.length, 2);
  const restarted = new OwnerIdentityService({ stateFile });
  assert.ok(restarted.authenticate(first.token));
  assert.ok(restarted.authenticate(second.token));
});

test('post-rename logout durability error keeps the committed revocation applied', async t => {
  const { stateFile } = fixture(t);
  const identity = new OwnerIdentityService({
    stateFile,
    bootstrapPassword: 'temporary-owner-password-9F!x'
  });
  const login = await identity.login({
    username: 'Admin',
    password: 'temporary-owner-password-9F!x'
  });
  assert.equal(login.ok, true);

  const originalFsync = fs.fsyncSync;
  let failed = false;
  fs.fsyncSync = function (fd) {
    if (!failed && fs.fstatSync(fd).isDirectory()) {
      failed = true;
      throw Object.assign(new Error('simulated owner-state directory fsync failure'), { code: 'EIO' });
    }
    return originalFsync.call(fs, fd);
  };
  try {
    assert.throws(
      () => identity.logout(login.token),
      error => error.code === 'OWNER_IDENTITY_PERSIST_FAILED' && error.committed === true
    );
  } finally {
    fs.fsyncSync = originalFsync;
  }

  assert.equal(failed, true);
  assert.equal(identity.authenticate(login.token), null);
  assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')).sessions, []);
  const restarted = new OwnerIdentityService({ stateFile });
  assert.equal(restarted.authenticate(login.token), null);
});

test('owner identity state directory rejects a symlink at the configured boundary', t => {
  const { directory } = fixture(t);
  const alias = path.join(directory, 'owner-directory-alias');
  fs.symlinkSync(directory, alias, 'dir');

  assert.throws(
    () => new OwnerIdentityService({
      stateFile: path.join(alias, 'owner.json'),
      bootstrapPassword: 'temporary-owner-password-9F!x'
    }),
    error => error.code === 'OWNER_IDENTITY_STORAGE_DIRECTORY_INVALID'
  );
});

test('owner identity state file permissions are tightened when an existing state is loaded', t => {
  const { stateFile } = fixture(t);
  new OwnerIdentityService({
    stateFile,
    bootstrapPassword: 'temporary-owner-password-9F!x'
  });
  fs.chmodSync(stateFile, 0o644);

  new OwnerIdentityService({ stateFile });

  assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600);
});

test('owner identity state rejects a hard-linked state file', t => {
  if (process.platform === 'win32') {
    t.skip('POSIX hard-link count enforcement is not available');
    return;
  }
  const { directory, stateFile } = fixture(t);
  new OwnerIdentityService({
    stateFile,
    bootstrapPassword: 'temporary-owner-password-9F!x'
  });
  fs.linkSync(stateFile, path.join(directory, 'owner-state-hardlink.json'));

  assert.throws(
    () => new OwnerIdentityService({ stateFile }),
    error => error.code === 'OWNER_IDENTITY_STATE_INVALID'
  );
});

test('owner identity state rejects a parent directory writable by other users without a sticky bit', t => {
  if (process.platform === 'win32' || typeof process.getuid !== 'function') {
    t.skip('POSIX parent permission checks are not available');
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-owner-parent-boundary-'));
  const parent = path.join(root, 'untrusted-parent');
  const storage = path.join(parent, 'storage');
  fs.mkdirSync(parent, { mode: 0o700 });
  fs.chmodSync(parent, 0o777);
  try {
    assert.throws(
      () => new OwnerIdentityService({
        stateFile: path.join(storage, 'owner.json'),
        bootstrapPassword: 'temporary-owner-password-9F!x'
      }),
      error => error.code === 'OWNER_IDENTITY_STORAGE_PARENT_UNTRUSTED'
    );
  } finally {
    fs.chmodSync(parent, 0o700);
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test('owner identity temp-file collision is preserved when exclusive creation fails', t => {
  const { stateFile } = fixture(t);
  const identity = new OwnerIdentityService({ stateFile, bootstrapPassword: 'temporary-owner-password-9F!x' });
  const before = fs.readFileSync(stateFile, 'utf8');
  const originalOpen = fs.openSync;
  const originalClose = fs.closeSync;
  let collision;
  fs.openSync = function (target, ...args) {
    if (typeof target === 'string' && target.startsWith(stateFile + '.') && target.endsWith('.tmp') && args[0] === 'wx') {
      collision = target;
      const fd = originalOpen.call(this, target, 'wx', 0o600);
      originalClose.call(this, fd);
      throw Object.assign(new Error('simulated EEXIST'), { code: 'EEXIST' });
    }
    return originalOpen.call(this, target, ...args);
  };
  try {
    assert.throws(() => identity.save(), error => error.code === 'OWNER_IDENTITY_PERSIST_FAILED' && error.cause?.code === 'EEXIST');
  } finally { fs.openSync = originalOpen; }
  assert.ok(collision);
  assert.equal(fs.existsSync(collision), true);
  assert.equal(fs.readFileSync(stateFile, 'utf8'), before);
});

test('owner lockout key collision is preserved and not removed by a losing initializer', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-owner-key-race-'));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateFile = path.join(root, 'owner.json');
  const keyFile = stateFile + '.lockout-key';
  const originalOpen = fs.openSync;
  const originalClose = fs.closeSync;
  let reserved = false;
  fs.openSync = function (target, flags, ...args) {
    if (target === keyFile && typeof flags === 'number' && !reserved) {
      throw Object.assign(new Error('simulated absent key'), { code: 'ENOENT' });
    }
    if (target === keyFile && flags === 'wx' && !reserved) {
      reserved = true;
      const fd = originalOpen.call(this, target, 'wx', 0o600);
      originalClose.call(this, fd);
      fs.writeFileSync(target, 'owned by another writer');
      throw Object.assign(new Error('simulated reservation collision'), { code: 'EEXIST' });
    }
    return originalOpen.call(this, target, flags, ...args);
  };
  try {
    assert.throws(() => new OwnerIdentityService({ stateFile, bootstrapPassword: 'temporary-owner-password-9F!x' }),
      error => error.code === 'OWNER_LOCKOUT_KEY_INVALID');
  } finally { fs.openSync = originalOpen; }
  assert.equal(reserved, true);
  assert.equal(fs.readFileSync(keyFile, 'utf8'), 'owned by another writer');
});


test('rejects malformed persisted owner login-failure records at every schema boundary', t => {
  const invalidRecords = [
    { keyVersion: 0 },
    { keyVersion: 3 },
    { keyVersion: null },
    { blockedUntil: -1 },
    { blockedUntil: 86400001 + 10000 },
    { windowStartedAt: 10001 },
    { count: 0 },
    { count: 101 }
  ];

  for (const [index, override] of invalidRecords.entries()) {
    const { stateFile } = fixture(t);
    new OwnerIdentityService({
      stateFile,
      bootstrapPassword: 'temporary-owner-password-9F!x',
      now: () => 10000
    });
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    state.loginFailures = [{
      key: (index + 1).toString(16).padStart(64, '0'),
      count: 1,
      windowStartedAt: 10000,
      blockedUntil: 0,
      keyVersion: 2,
      ...override
    }];
    fs.writeFileSync(stateFile, JSON.stringify(state));
    assert.throws(
      () => new OwnerIdentityService({ stateFile, now: () => 10000 }),
      error => error.code === 'OWNER_IDENTITY_STATE_INVALID',
      'invalid persisted login-failure field must fail closed: ' + JSON.stringify(override)
    );
  }
});

test('rejects malformed and duplicate persisted login-failure keys', t => {
  const invalidKeys = ['', 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64)];
  for (const [index, key] of invalidKeys.entries()) {
    const { stateFile } = fixture(t);
    new OwnerIdentityService({ stateFile, bootstrapPassword: 'temporary-owner-password-9F!x', now: () => 10000 });
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    state.loginFailures = [{
      key, count: 1, windowStartedAt: 10000, blockedUntil: 0, keyVersion: 2
    }];
    fs.writeFileSync(stateFile, JSON.stringify(state));
    assert.throws(
      () => new OwnerIdentityService({ stateFile, now: () => 10000 }),
      error => error.code === 'OWNER_IDENTITY_STATE_INVALID',
      'invalid persisted key must fail closed at case ' + index
    );
  }

  const { stateFile } = fixture(t);
  new OwnerIdentityService({ stateFile, bootstrapPassword: 'temporary-owner-password-9F!x', now: () => 10000 });
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const duplicateKey = 'a'.repeat(64);
  const record = { key: duplicateKey, count: 1, windowStartedAt: 10000, blockedUntil: 0, keyVersion: 2 };
  state.loginFailures = [record, { ...record }];
  fs.writeFileSync(stateFile, JSON.stringify(state));
  assert.throws(
    () => new OwnerIdentityService({ stateFile, now: () => 10000 }),
    error => error.code === 'OWNER_IDENTITY_STATE_INVALID',
    'duplicate persisted keys must fail closed'
  );
});

test('accepts each supported persisted login-failure key version', t => {
  const { stateFile } = fixture(t);
  new OwnerIdentityService({ stateFile, bootstrapPassword: 'temporary-owner-password-9F!x', now: () => 10000 });
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  state.loginFailures = [1, 2].map((keyVersion, index) => ({
    key: (index + 1).toString(16).padStart(64, '0'),
    count: 1,
    windowStartedAt: 10000,
    blockedUntil: 0,
    keyVersion
  }));
  fs.writeFileSync(stateFile, JSON.stringify(state));
  const reloaded = new OwnerIdentityService({ stateFile, now: () => 10000 });
  assert.equal(reloaded.loginFailures.size, 2);
});

test('expires a login lockout at the exact persisted window boundary before recording a new failure', async t => {
  const { stateFile } = fixture(t);
  const identity = new OwnerIdentityService({
    stateFile,
    bootstrapPassword: 'temporary-owner-password-9F!x',
    maxLoginFailures: 1,
    loginLockoutMs: 1000,
    now: () => 1000
  });

  const first = await identity.login({
    username: 'Admin',
    password: 'wrong-password-value',
    sourceIp: '192.0.2.44',
    now: 1000
  });
  assert.equal(first.code, 'OWNER_LOGIN_FAILED');
  assert.equal(identity.loginFailures.values().next().value.blockedUntil, 2000);

  const atBoundary = await identity.login({
    username: 'Admin',
    password: 'wrong-password-value',
    sourceIp: '192.0.2.44',
    now: 2000
  });
  assert.equal(atBoundary.code, 'OWNER_LOGIN_FAILED');
  assert.equal(identity.loginFailures.values().next().value.count, 1);
  assert.equal(identity.loginFailures.values().next().value.windowStartedAt, 2000);
});

test('canonicalizes owner email before persisting and comparing identity', t => {
  const { stateFile } = fixture(t);
  const identity = new OwnerIdentityService({
    stateFile,
    ownerEmail: '  Owner@Example.COM  ',
    bootstrapPassword: 'temporary-owner-password-9F!x'
  });

  assert.equal(identity.ownerEmail, 'owner@example.com');
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).email, 'owner@example.com');
});

test('rejects persisted password verifiers with any prefix or suffix outside the exact hash grammar', t => {
  const malformedVerifiers = [
    'x' + 'a'.repeat(128) + ':' + 'b'.repeat(32),
    'a'.repeat(128) + ':' + 'b'.repeat(32) + 'x',
    'legacy:' + 'a'.repeat(128) + ':' + 'b'.repeat(32) + 'x'
  ];

  for (const verifier of malformedVerifiers) {
    const { stateFile } = fixture(t);
    new OwnerIdentityService({
      stateFile,
      bootstrapPassword: 'temporary-owner-password-9F!x'
    });
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    state.passwordHash = verifier;
    fs.writeFileSync(stateFile, JSON.stringify(state), { mode: 0o600 });

    assert.throws(
      () => new OwnerIdentityService({ stateFile }),
      error => error.code === 'OWNER_IDENTITY_STATE_INVALID',
      'persisted verifier must match the complete hash grammar'
    );
  }
});

test('does not restore persisted owner sessions when their CSRF token has a prefix or suffix', async t => {
  for (const malformedToken of ['p'.repeat(60), 's'.repeat(60)]) {
    const { stateFile } = fixture(t);
    const identity = new OwnerIdentityService({
      stateFile,
      bootstrapPassword: 'temporary-owner-password-9F!x'
    });
    const login = await identity.login({
      username: 'Admin',
      password: 'temporary-owner-password-9F!x'
    });
    assert.equal(login.ok, true);

    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    state.sessions[0].csrfToken = malformedToken.startsWith('p')
      ? malformedToken + state.sessions[0].csrfToken
      : state.sessions[0].csrfToken + malformedToken;
    fs.writeFileSync(stateFile, JSON.stringify(state), { mode: 0o600 });

    const reloaded = new OwnerIdentityService({ stateFile });
    assert.equal(
      reloaded.authenticate(login.token),
      null,
      'a session with a non-canonical persisted CSRF token must not be restored'
    );
  }
});

test('rejects non-string password inputs without invoking password verification', async t => {
  const { stateFile } = fixture(t);
  const identity = new OwnerIdentityService({
    stateFile,
    bootstrapPassword: 'temporary-owner-password-9F!x'
  });

  for (const password of [null, undefined, 42, {}, ['temporary-owner-password-9F!x']]) {
    const result = await identity.login({ username: 'Admin', password });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'OWNER_LOGIN_FAILED');
  }
});

test('regenerates malformed persisted owner session IDs before restoring session identity', async t => {
  const { stateFile } = fixture(t);
  const identity = new OwnerIdentityService({
    stateFile,
    bootstrapPassword: 'temporary-owner-password-9F!x'
  });
  const login = await identity.login({
    username: 'Admin',
    password: 'temporary-owner-password-9F!x'
  });
  assert.equal(login.ok, true);

  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  state.sessions[0].sessionId = 'not-a-canonical-session-id';
  fs.writeFileSync(stateFile, JSON.stringify(state), { mode: 0o600 });

  const reloaded = new OwnerIdentityService({ stateFile });
  const restored = reloaded.authenticate(login.token);
  assert.ok(restored, 'a valid credential session remains restorable');
  assert.notEqual(restored.sessionId, 'not-a-canonical-session-id');
  assert.match(
    restored.sessionId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  );

  const persisted = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(persisted.sessions[0].sessionId, restored.sessionId,
    'the regenerated non-secret session identity must be durably persisted');
});


test('owner identity validates constructor and per-login policy boundaries before persistence side effects', async t => {
  const invalidConstructorOptions = [
    { sessionTtlMs: 999 },
    { sessionTtlMs: 86400001 },
    { sessionTtlMs: 1500.5 },
    { sessionTtlMs: Number.MAX_SAFE_INTEGER + 1 },
    { ownerEmail: 'not-an-email' },
    { maxLoginFailures: 0 },
    { maxLoginFailures: 101 },
    { maxLoginFailures: 2.5 },
    { loginLockoutMs: 999 },
    { loginLockoutMs: 86400001 },
    { loginLockoutMs: 1500.5 },
    { loginLockoutMs: Number.MAX_SAFE_INTEGER + 1 }
  ];

  for (const options of invalidConstructorOptions) {
    const { stateFile } = fixture(t);
    assert.throws(
      () => new OwnerIdentityService({ stateFile, ...options }),
      error => error instanceof RangeError || error instanceof TypeError,
      JSON.stringify(options)
    );
    assert.equal(fs.existsSync(stateFile), false, 'invalid constructor policy must fail before creating owner state');
  }

  const { stateFile } = fixture(t);
  const identity = new OwnerIdentityService({
    stateFile,
    bootstrapPassword: 'temporary-owner-password-9F!x'
  });
  const persistedBefore = fs.readFileSync(stateFile);
  const invalidLoginPolicies = [
    { maxFailures: 0 },
    { maxFailures: 101 },
    { maxFailures: 2.5 },
    { lockoutMs: 999 },
    { lockoutMs: 86400001 },
    { lockoutMs: 1500.5 },
    { lockoutMs: Number.MAX_SAFE_INTEGER + 1 },
    { now: -1 },
    { now: 1.5 },
    { now: Number.MAX_SAFE_INTEGER + 1 }
  ];

  for (const policy of invalidLoginPolicies) {
    await assert.rejects(
      identity.login({ username: 'Admin', password: 'wrong-password', ...policy }),
      error => error instanceof RangeError,
      JSON.stringify(policy)
    );
  }

  assert.equal(identity.loginFailures.size, 0, 'invalid policy must not record or prune login failures');
  assert.deepEqual(fs.readFileSync(stateFile), persistedBefore, 'invalid policy must not persist owner state');
});
