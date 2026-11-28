'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');

const MAX_FILE_BYTES = 256 * 1024;
const UTF8 = new TextDecoder('utf-8', { fatal: true });

function fail(message, code) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function digest(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function syncDirectory(directoryPath) {
  let fd;
  try {
    fd = fs.openSync(directoryPath, 'r');
    fs.fsyncSync(fd);
  } catch (error) {
    const unsupported = new Error('Workspace recovery requires durable parent-directory synchronization');
    unsupported.code = 'PROJECT_WORKSPACE_LOCK_UNSUPPORTED_FILESYSTEM';
    unsupported.cause = error;
    throw unsupported;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function validateRelativePath(value) {
  if (typeof value !== 'string' || !value || value.length > 512 ||
      value.startsWith('/') || value.includes('\\') || value.includes('\0')) {
    fail('Recovery journal contains an unsafe workspace path', 'PROJECT_WORKSPACE_LOCK_RECOVERY_CONFLICT');
  }
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) {
    fail('Recovery journal contains an unsafe workspace path', 'PROJECT_WORKSPACE_LOCK_RECOVERY_CONFLICT');
  }
  return parts;
}

function openParent(root, relativePath) {
  const parts = validateRelativePath(relativePath);
  const flags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
  let fd = fs.openSync(root, flags);
  try {
    for (const part of parts.slice(0, -1)) {
      const next = fs.openSync('/proc/self/fd/' + fd + '/' + part, flags);
      fs.closeSync(fd);
      fd = next;
    }
    return { fd, path: '/proc/self/fd/' + fd, basename: parts[parts.length - 1] };
  } catch (error) {
    fs.closeSync(fd);
    if (error.code === 'ELOOP' || error.code === 'ENOTDIR') {
      fail('Recovery path contains a symbolic link or non-directory parent', 'PROJECT_WORKSPACE_LOCK_RECOVERY_CONFLICT');
    }
    throw error;
  }
}

function readAt(parent, relativePath) {
  const target = parent.path + '/' + parent.basename;
  let fd;
  try {
    fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (error) {
    if (error.code === 'ENOENT') return { exists: false, content: null, hash: null, mode: null };
    if (error.code === 'ELOOP' || error.code === 'ENOTDIR') {
      fail('Recovery target is a symbolic link or unsupported file type: ' + relativePath,
        'PROJECT_WORKSPACE_LOCK_RECOVERY_CONFLICT');
    }
    throw error;
  }

  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size > MAX_FILE_BYTES || (before.mode & 0o7000) !== 0 ||
        (typeof process.getuid === 'function' && before.uid !== process.getuid())) {
      fail('Recovery target must be an owned, bounded, single-link regular file: ' + relativePath,
        'PROJECT_WORKSPACE_LOCK_RECOVERY_CONFLICT');
    }
    const buffer = Buffer.allocUnsafe(MAX_FILE_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const count = fs.readSync(fd, buffer, total, buffer.length - total, null);
      if (count === 0) break;
      total += count;
    }
    if (total > MAX_FILE_BYTES) {
      fail('Recovery target exceeds the bounded UTF-8 file limit: ' + relativePath,
        'PROJECT_WORKSPACE_LOCK_RECOVERY_CONFLICT');
    }
    const after = fs.fstatSync(fd);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
        total !== after.size) {
      fail('Recovery target changed while its contents were being read: ' + relativePath,
        'PROJECT_WORKSPACE_LOCK_RECOVERY_CONFLICT');
    }
    let content;
    try {
      content = UTF8.decode(buffer.subarray(0, total));
    } catch (error) {
      fail('Recovery supports UTF-8 text files only: ' + relativePath,
        'PROJECT_WORKSPACE_LOCK_RECOVERY_CONFLICT');
    }
    return {
      exists: true,
      content,
      hash: digest(content),
      mode: after.mode & 0o777
    };
  } finally {
    fs.closeSync(fd);
  }
}

function sameBefore(state, change) {
  if (!change.beforeExists) return !state.exists;
  return state.exists && state.hash === change.beforeContentSha256 && state.mode === change.beforeMode;
}

function sameAfter(state, change) {
  if (!state.exists || state.hash !== change.afterContentSha256) return false;
  const expectedMode = change.beforeExists ? change.beforeMode : 0o600;
  return state.mode === expectedMode;
}

class ProjectWorkspaceRecovery {
  constructor({ workspaceRoot, receiptStore, assertClaim } = {}) {
    if (typeof workspaceRoot !== 'string' || !workspaceRoot.trim()) throw new TypeError('workspaceRoot is required');
    if (!receiptStore || typeof receiptStore.readIntent !== 'function' ||
        typeof receiptStore.read !== 'function' || typeof receiptStore.write !== 'function') {
      throw new TypeError('receiptStore is required');
    }
    if (typeof assertClaim !== 'function') throw new TypeError('assertClaim is required');
    this.workspaceRoot = fs.realpathSync.native(path.resolve(workspaceRoot));
    this.receiptStore = receiptStore;
    this.assertClaim = assertClaim;
  }

  readState(relativePath) {
    let parent;
    try {
      parent = openParent(this.workspaceRoot, relativePath);
    } catch (error) {
      if (error.code === 'ENOENT') return { exists: false, content: null, hash: null, mode: null };
      throw error;
    }
    try {
      return readAt(parent, relativePath);
    } finally {
      fs.closeSync(parent.fd);
    }
  }

  restoreAt(parent, change, ownerToken) {
    const relativePath = change.path;
    const current = readAt(parent, relativePath);
    if (sameBefore(current, change)) {
      // A previous interrupted recovery may have changed the directory but
      // crashed before its durability barrier. Re-sync before accepting the
      // before-image as a completed recovery step.
      fs.fsyncSync(parent.fd);
      return;
    }
    if (!sameAfter(current, change)) {
      fail('Recovery conflict: current file matches neither before-image nor operation after-image: ' + relativePath,
        'PROJECT_WORKSPACE_LOCK_RECOVERY_CONFLICT');
    }

    this.assertClaim();
    if (!change.beforeExists) {
      fs.unlinkSync(parent.path + '/' + parent.basename);
      fs.fsyncSync(parent.fd);
      return;
    }

    const tempName = '.orient-recovery-' +
      crypto.createHash('sha256').update(ownerToken + '\0' + relativePath).digest('hex').slice(0, 32);
    const tempPath = parent.path + '/' + tempName;
    try {
      const stale = fs.lstatSync(tempPath);
      if (!stale.isFile() || stale.isSymbolicLink() || stale.nlink !== 1 ||
          (typeof process.getuid === 'function' && stale.uid !== process.getuid()) ||
          (stale.mode & 0o7777) !== 0o600) {
        fail('Recovery temporary path is occupied by an unsafe file', 'PROJECT_WORKSPACE_LOCK_RECOVERY_CONFLICT');
      }
      fs.unlinkSync(tempPath);
      fs.fsyncSync(parent.fd);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    let fd;
    try {
      fd = fs.openSync(tempPath,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
        0o600);
      fs.writeFileSync(fd, change.beforeContent, 'utf8');
      fs.fchmodSync(fd, change.beforeMode);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      this.assertClaim();
      const latest = readAt(parent, relativePath);
      if (!sameAfter(latest, change)) {
        fail('Recovery target changed before the before-image could be committed: ' + relativePath,
          'PROJECT_WORKSPACE_LOCK_RECOVERY_CONFLICT');
      }
      fs.renameSync(tempPath, parent.path + '/' + parent.basename);
      fs.fsyncSync(parent.fd);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      try { fs.unlinkSync(tempPath); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }

  verify(changes, expected) {
    for (const change of changes) {
      this.assertClaim();
      let parent;
      try {
        parent = openParent(this.workspaceRoot, change.path);
      } catch (error) {
        if (error.code === 'ENOENT' && expected === 'before' && !change.beforeExists) continue;
        throw error;
      }
      try {
        const state = readAt(parent, change.path);
        const matches = expected === 'before'
          ? sameBefore(state, change)
          : sameAfter(state, change);
        if (!matches) {
          fail('Recovery verification failed for workspace path: ' + change.path,
            'PROJECT_WORKSPACE_LOCK_RECOVERY_CONFLICT');
        }
        // This is recovery-only: make the verified directory entry durable
        // before a rollback receipt or lock release can become authoritative.
        fs.fsyncSync(parent.fd);
      } finally {
        fs.closeSync(parent.fd);
      }
    }
  }

  restore({ owner, operatorId, reason }) {
    this.assertClaim();
    if (!owner?.operationId || !owner?.tenantId) {
      fail('Workspace lock has no operation identity; before-image recovery is unavailable',
        'PROJECT_OPERATION_INTENT_REQUIRED');
    }

    const intent = this.receiptStore.readIntent({
      operationId: owner.operationId,
      tenantId: owner.tenantId
    });
    if (!intent || intent.version !== 3 || !Array.isArray(intent.changes) ||
        intent.workspaceId !== owner.workspaceId) {
      fail('A complete version-3 before-image journal is required for workspace recovery',
        'PROJECT_OPERATION_INTENT_INCOMPLETE');
    }

    const receiptIdentity = {
      operationId: owner.operationId,
      tenantId: owner.tenantId
    };
    const existingReceipt = this.receiptStore.read(receiptIdentity);
    if (existingReceipt) {
      if (existingReceipt.workspaceId !== intent.workspaceId ||
          existingReceipt.changeSetHash !== intent.changeSetHash) {
        fail('Existing operation receipt does not match the recovery journal',
          'PROJECT_OPERATION_RECEIPT_IDENTITY_CONFLICT');
      }
      if (existingReceipt.outcome === 'rolled_back') {
        this.verify(intent.changes, 'before');
        return { outcome: 'rolled_back', receipt: existingReceipt };
      }
      if (existingReceipt.outcome === 'verified') {
        this.verify(intent.changes, 'after');
        return { outcome: 'verified', receipt: existingReceipt };
      }
      fail('Existing operation receipt has an unsupported recovery outcome',
        'PROJECT_OPERATION_RECEIPT_CORRUPT');
    }

    for (const change of intent.changes) {
      this.assertClaim();
      let parent;
      try {
        parent = openParent(this.workspaceRoot, change.path);
      } catch (error) {
        if (error.code === 'ENOENT' && !change.beforeExists) continue;
        if (error.code === 'ENOENT') {
          fail('Recovery parent directory is missing for an existing before-image: ' + change.path,
            'PROJECT_WORKSPACE_LOCK_RECOVERY_CONFLICT');
        }
        throw error;
      }
      try {
        this.restoreAt(parent, change, owner.token);
      } finally {
        fs.closeSync(parent.fd);
      }
    }

    this.verify(intent.changes, 'before');
    this.assertClaim();
    const result = {
      status: 'failed',
      changeSet: {
        changes: intent.changes.map(change => ({
          action: change.action,
          path: change.path,
          afterContentSha256: change.afterContentSha256
        }))
      },
      rollback: {
        rolledBack: true,
        restored: intent.changes.map(change => ({
          path: change.path,
          existed: change.beforeExists,
          contentSha256: change.beforeContentSha256
        }))
      }
    };
    this.receiptStore.write({
      operationId: owner.operationId,
      tenantId: owner.tenantId,
      workspaceId: intent.workspaceId,
      changeSetHash: intent.changeSetHash,
      result,
      requireIntentJournal: true
    });
    const committed = this.receiptStore.read(receiptIdentity);
    if (!committed || committed.outcome !== 'rolled_back' ||
        committed.workspaceId !== intent.workspaceId ||
        committed.changeSetHash !== intent.changeSetHash) {
      fail('Durable rolled-back receipt could not be read back and validated',
        'PROJECT_OPERATION_RECEIPT_COMMIT_UNCONFIRMED');
    }
    this.verify(intent.changes, 'before');
    this.assertClaim();
    return { outcome: 'rolled_back', receipt: committed };
  }
}

module.exports = ProjectWorkspaceRecovery;
