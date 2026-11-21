'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const EventRepository = require('../../../../../src/infrastructure/persistence/json/event.repository');

test('rejects an untrusted writable grandparent before creating event storage', t => {
  if (process.platform === 'win32' || typeof process.getuid !== 'function') {
    t.skip('POSIX ownership and mode checks are not available');
    return;
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-event-ancestor-chain-'));
  const untrustedGrandparent = path.join(root, 'untrusted');
  const trustedParent = path.join(untrustedGrandparent, 'private-parent');
  const storage = path.join(trustedParent, 'storage');
  fs.mkdirSync(trustedParent, { recursive: true, mode: 0o700 });
  fs.chmodSync(untrustedGrandparent, 0o777);

  t.after(() => {
    fs.chmodSync(untrustedGrandparent, 0o700);
    fs.rmSync(root, { recursive: true, force: true });
  });

  assert.throws(
    () => new EventRepository(path.join(storage, 'events.json')),
    error => error.code === 'EVENT_STORAGE_PARENT_UNTRUSTED'
  );
  assert.equal(fs.existsSync(storage), false, 'storage must not be created below an untrusted ancestor');
});

test('creates every missing storage ancestor privately and initializes valid JSON', t => {
  if (process.platform === 'win32' || typeof process.getuid !== 'function') {
    t.skip('POSIX ownership and mode checks are not available');
    return;
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-event-private-chain-'));
  fs.chmodSync(root, 0o700);
  t.after(() => {
    fs.chmodSync(root, 0o700);
    fs.rmSync(root, { recursive: true, force: true });
  });

  const parent = path.join(root, 'private-parent');
  const storage = path.join(parent, 'storage');
  const repository = new EventRepository(path.join(storage, 'events.json'));

  for (const directory of [parent, storage]) {
    const stats = fs.statSync(directory);
    assert.equal(stats.uid, process.getuid());
    assert.equal(stats.mode & 0o777, 0o700);
  }

  assert.equal(fs.readFileSync(repository.filePath, 'utf8'), '[]\n');
  assert.deepEqual(repository.read(), []);
});
