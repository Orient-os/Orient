'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ensurePrivateStorageDirectory = require('../filesystem/private-storage-directory');

function fail(message, code) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function digest(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

const MAX_INTENT_BYTES = 2 * 1024 * 1024;
const MAX_INTENT_CHANGES = 10;
const MAX_INTENT_BEFORE_BYTES = 1024 * 1024;
const MAX_INTENT_BEFORE_FILE_BYTES = 256 * 1024;
const MAX_RECEIPT_BYTES = 1024 * 1024;

function readBoundedFile(fd, maxBytes, code, label) {
  const buffer = Buffer.allocUnsafe(maxBytes + 1);
  let total = 0;
  while (total < buffer.length) {
    const count = fs.readSync(fd, buffer, total, buffer.length - total, null);
    if (count === 0) break;
    total += count;
  }
  if (total > maxBytes) fail(label + ' exceeds its maximum permitted size', code);
  return buffer.subarray(0, total).toString('utf8');
}

function validIntentChanges(changes, version = 3) {
  if (!Array.isArray(changes) || changes.length === 0 || changes.length > MAX_INTENT_CHANGES) return false;
  const paths = new Set();
  let totalBeforeBytes = 0;
  return changes.every(change => {
    if (!change || !['create', 'update'].includes(change.action) ||
        typeof change.path !== 'string' || !change.path || change.path.length > 512 ||
        paths.has(change.path) || typeof change.beforeExists !== 'boolean' ||
        typeof change.afterContentSha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(change.afterContentSha256)) return false;
    paths.add(change.path);
    if (change.action === 'create' && change.beforeExists) return false;
    if (change.action === 'update' && !change.beforeExists) return false;
    if (version === 3) {
      if (change.beforeExists) {
        if (change.beforeType !== 'regular' ||
            !Number.isInteger(change.beforeMode) ||
            change.beforeMode < 0 || change.beforeMode > 0o777) return false;
      } else if (change.beforeType !== 'absent' || change.beforeMode !== null) {
        return false;
      }
    }
    if (!change.beforeExists) {
      return change.beforeContent === null && change.beforeContentSha256 === null;
    }
    if (typeof change.beforeContent !== 'string' ||
        typeof change.beforeContentSha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(change.beforeContentSha256)) return false;
    const bytes = Buffer.byteLength(change.beforeContent, 'utf8');
    totalBeforeBytes += bytes;
    return bytes <= MAX_INTENT_BEFORE_FILE_BYTES &&
      totalBeforeBytes <= MAX_INTENT_BEFORE_BYTES &&
      digest(change.beforeContent) === change.beforeContentSha256;
  });
}

function validRollbackOutcome(result) {
  const restored = result?.rollback?.restored;
  if (result?.status !== 'failed' || result.rollback?.rolledBack !== true ||
      !Array.isArray(restored) || restored.length === 0 || restored.length > 100) {
    return false;
  }
  const paths = new Set();
  return restored.every(item => {
    if (!item || typeof item.path !== 'string' || !item.path ||
        item.path.length > 512 || paths.has(item.path) ||
        typeof item.existed !== 'boolean') return false;
    paths.add(item.path);
    return item.existed
      ? typeof item.contentSha256 === 'string' && /^[a-f0-9]{64}$/.test(item.contentSha256)
      : item.contentSha256 === null;
  });
}

function matchesRollbackJournal(result, changes) {
  const restored = result?.rollback?.restored;
  return matchesVerifiedJournal(result, changes) &&
    Array.isArray(restored) && restored.length === changes.length &&
    changes.every((change, index) => {
      const item = restored[index];
      return item?.path === change.path &&
        item.existed === change.beforeExists &&
        item.contentSha256 === change.beforeContentSha256;
    });
}

function matchesVerifiedJournal(result, changes) {
  const applied = result?.changeSet?.changes;
  return Array.isArray(changes) && Array.isArray(applied) &&
    applied.length === changes.length &&
    changes.every((change, index) => {
      const item = applied[index];
      return item?.action === change.action &&
        item.path === change.path &&
        (typeof item.content === 'string'
          ? digest(item.content) === change.afterContentSha256
          : item.afterContentSha256 === change.afterContentSha256);
    });
}

function validVerifiedOutcome(result) {
  return Boolean(result && result.status === 'verified' &&
    result.verification?.status === 'passed' &&
    result.verification?.failed === 0);
}

function validIdentity(value) {
  return value && typeof value.operationId === 'string' &&
    value.operationId.length > 0 && value.operationId.length <= 256 &&
    typeof value.tenantId === 'string' &&
    value.tenantId.length > 0 && value.tenantId.length <= 128;
}

function syncDirectory(directory) {
  let fd;
  try {
    fd = fs.openSync(directory, 'r');
    fs.fsyncSync(fd);
  } catch (error) {
    if (['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR'].includes(error.code)) {
      const unsupported = new Error('Receipt storage does not provide durable directory synchronization');
      unsupported.code = 'PROJECT_OPERATION_RECEIPT_UNSUPPORTED_FILESYSTEM';
      unsupported.cause = error;
      throw unsupported;
    }
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Durable, tenant-scoped receipts for verified and safely rolled-back project operations.
 * The receipt directory belongs to application data, never to the workspace.
 * Writers use exclusive directory locks; stale locks fail closed and require operator recovery.
 */
class ProjectOperationReceiptStore {
  constructor({ directory } = {}) {
    if (typeof directory !== 'string' || !directory.trim()) {
      throw new TypeError('directory is required');
    }
    this.directory = path.resolve(directory);
  }

  receiptPath(operationId, tenantId) {
    if (!validIdentity({ operationId, tenantId })) {
      fail('Operation receipt identity is invalid', 'PROJECT_OPERATION_RECEIPT_IDENTITY_INVALID');
    }
    return path.join(this.directory, digest(tenantId + '\0' + operationId) + '.json');
  }

  ensureDirectory({ create = true } = {}) {
    this.directory = ensurePrivateStorageDirectory(this.directory, {
      create,
      repairPermissions: false,
      errorCodes: {
        directoryInvalid: 'PROJECT_OPERATION_RECEIPT_DIRECTORY_INVALID',
        directoryOwnerInvalid: 'PROJECT_OPERATION_RECEIPT_DIRECTORY_OWNER_INVALID',
        directoryPermissionsInvalid: 'PROJECT_OPERATION_RECEIPT_DIRECTORY_PERMISSIONS_INVALID',
        parentInvalid: 'PROJECT_OPERATION_RECEIPT_PARENT_UNTRUSTED',
        parentUntrusted: 'PROJECT_OPERATION_RECEIPT_PARENT_UNTRUSTED'
      }
    });
  }

  intentPath(operationId, tenantId) {
    return this.receiptPath(operationId, tenantId) + '.intent.json';
  }

  assertPrivateFileDescriptor(fd, code, label) {
    const stats = fs.fstatSync(fd);
    const posix = process.platform !== 'win32' && typeof process.getuid === 'function';
    if (!stats.isFile() || (posix && stats.nlink !== 1)) {
      fail(label + ' must be a single-link regular file', code);
    }
    if (posix) {
      if (stats.uid !== process.getuid()) {
        fail(label + ' must be owned by the application user', code);
      }
      if ((stats.mode & 0o7777) !== 0o600) {
        try {
          fs.fchmodSync(fd, 0o600);
        } catch (error) {
          const invalid = new Error(label + ' permissions could not be secured');
          invalid.code = code;
          invalid.cause = error;
          throw invalid;
        }
        if ((fs.fstatSync(fd).mode & 0o7777) !== 0o600) {
          fail(label + ' must be private (mode 0600)', code);
        }
      }
    }
    return stats;
  }

  readIntent({ operationId, tenantId }) {
    // Reads are security-sensitive too: validate the complete canonical
    // storage boundary before resolving or opening a tenant-scoped pathname.
    this.ensureDirectory({ create: false });
    const filePath = this.intentPath(operationId, tenantId);
    let intent;
    let fd;
    try {
      // Never inspect then reopen by pathname: that creates a TOCTOU window.
      // Require O_NOFOLLOW so unsupported platforms fail closed instead of
      // following a substituted symlink.
      if (typeof fs.constants.O_NOFOLLOW !== 'number') {
        fail('Safe intent-file reads are unsupported on this platform', 'PROJECT_OPERATION_INTENT_UNSAFE_FILESYSTEM');
      }
      fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const openedStats = this.assertPrivateFileDescriptor(
        fd,
        'PROJECT_OPERATION_INTENT_CORRUPT',
        'Project operation intent'
      );
      if (openedStats.size > MAX_INTENT_BYTES) {
        fail('Project operation intent exceeds its maximum permitted size', 'PROJECT_OPERATION_INTENT_CORRUPT');
      }
      intent = JSON.parse(readBoundedFile(fd, MAX_INTENT_BYTES, 'PROJECT_OPERATION_INTENT_CORRUPT', 'Project operation intent'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      if (error.code === 'ELOOP') {
        fail('Project operation intent must not be a symbolic link', 'PROJECT_OPERATION_INTENT_CORRUPT');
      }
      if (error.code === 'PROJECT_OPERATION_INTENT_UNSAFE_FILESYSTEM' ||
          error.code === 'PROJECT_OPERATION_INTENT_CORRUPT') throw error;
      if (error instanceof SyntaxError) {
        const corrupt = new Error('Project operation intent is not valid JSON');
        corrupt.code = 'PROJECT_OPERATION_INTENT_CORRUPT';
        corrupt.cause = error;
        throw corrupt;
      }
      // Preserve filesystem failures (EACCES, EIO, EMFILE, etc.) so callers
      // can distinguish unavailable storage from corrupt intent evidence.
      throw error;
    } finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch {}
      }
    }

    const validVersion = intent?.version === 1 ||
      (intent?.version === 2 && validIntentChanges(intent.changes, 2)) ||
      (intent?.version === 3 && validIntentChanges(intent.changes, 3));
    if (!intent || !validVersion || intent.status !== 'pending' ||
        intent.operationId !== operationId || intent.tenantId !== tenantId ||
        typeof intent.workspaceId !== 'string' || !/^[a-f0-9]{64}$/.test(intent.workspaceId) ||
        typeof intent.changeSetHash !== 'string' || !/^[a-f0-9]{64}$/.test(intent.changeSetHash) ||
        typeof intent.recordedAt !== 'string') {
      fail('Project operation intent schema or identity is invalid', 'PROJECT_OPERATION_INTENT_CORRUPT');
    }
    return intent;
  }

  beginIntent({ operationId, tenantId, workspaceId, changeSetHash, changes = null }) {
    if (!validIdentity({ operationId, tenantId }) ||
        typeof workspaceId !== 'string' || !/^[a-f0-9]{64}$/.test(workspaceId) ||
        typeof changeSetHash !== 'string' || !/^[a-f0-9]{64}$/.test(changeSetHash)) {
      fail('Project operation intent identity is invalid', 'PROJECT_OPERATION_INTENT_INVALID');
    }

    if (changes !== null && !validIntentChanges(changes, 3)) {
      fail('Project operation before-image journal is invalid or exceeds its limits', 'PROJECT_OPERATION_INTENT_INVALID');
    }

    this.ensureDirectory();
    const filePath = this.intentPath(operationId, tenantId);
    const intent = {
      version: changes === null ? 1 : 3,
      status: 'pending',
      operationId,
      tenantId,
      workspaceId,
      changeSetHash,
      ...(changes === null ? {} : { changes }),
      recordedAt: new Date().toISOString()
    };
    const serializedIntent = JSON.stringify(intent) + '\n';
    if (Buffer.byteLength(serializedIntent, 'utf8') > MAX_INTENT_BYTES) {
      fail('Project operation before-image journal exceeds its maximum permitted size', 'PROJECT_OPERATION_INTENT_INVALID');
    }
    let fd;
    try {
      fd = fs.openSync(filePath, 'wx', 0o600);
      fs.writeFileSync(fd, serializedIntent, 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      syncDirectory(this.directory);
      return { created: true, intent };
    } catch (error) {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch {}
      }
      if (error.code !== 'EEXIST') {
        // Do not unlink by pathname after a failed write: another actor could
        // replace the path between creation and cleanup. A partial intent is
        // deliberately left in place and causes fail-closed recovery.
        throw error;
      }
    }

    const existing = this.readIntent({ operationId, tenantId });
    if (!existing) {
      fail('Project operation intent disappeared during reservation', 'PROJECT_OPERATION_INTENT_CONFLICT');
    }
    if (existing.workspaceId !== workspaceId || existing.changeSetHash !== changeSetHash) {
      fail('Operation ID is already bound to a different pending project change', 'PROJECT_OPERATION_INTENT_IDENTITY_CONFLICT');
    }
    return { created: false, intent: existing };
  }

  // Pending intent files are intentionally retained after a receipt is committed.
  // A terminal receipt is authoritative; deleting by pathname after a separate
  // identity check would introduce a time-of-check/time-of-use race.
  read({ operationId, tenantId }) {
    // Reconciliation may read before any write has initialized this store.
    // Never let a read bypass the private-directory trust boundary.
    this.ensureDirectory({ create: false });
    const filePath = this.receiptPath(operationId, tenantId);
    if (typeof fs.constants.O_NOFOLLOW !== 'number') {
      fail('Safe receipt-file reads are unsupported on this platform', 'PROJECT_OPERATION_RECEIPT_UNSAFE_FILESYSTEM');
    }

    let descriptor;
    let raw;
    try {
      // Open once without following symlinks, then validate and read that exact
      // file descriptor. A pathname replacement cannot redirect this read.
      descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const openedStats = this.assertPrivateFileDescriptor(
        descriptor,
        'PROJECT_OPERATION_RECEIPT_CORRUPT',
        'Project operation receipt'
      );
      if (openedStats.size > MAX_RECEIPT_BYTES) {
        fail('Project operation receipt exceeds its maximum permitted size', 'PROJECT_OPERATION_RECEIPT_CORRUPT');
      }
      raw = readBoundedFile(descriptor, MAX_RECEIPT_BYTES, 'PROJECT_OPERATION_RECEIPT_CORRUPT', 'Project operation receipt');
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      if (error.code === 'ELOOP') {
        fail('Project operation receipt must not be a symbolic link', 'PROJECT_OPERATION_RECEIPT_CORRUPT');
      }
      if (error.code === 'PROJECT_OPERATION_RECEIPT_CORRUPT' ||
          error.code === 'PROJECT_OPERATION_RECEIPT_UNSAFE_FILESYSTEM') throw error;
      // Preserve operational failures (EACCES, EIO, EMFILE, etc.) rather than
      // misreporting them as corrupt receipt data.
      throw error;
    } finally {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor); } catch {}
      }
    }

    let receipt;
    try {
      receipt = JSON.parse(raw);
    } catch (error) {
      const corrupt = new Error('Project operation receipt is not valid JSON');
      corrupt.code = 'PROJECT_OPERATION_RECEIPT_CORRUPT';
      corrupt.cause = error;
      throw corrupt;
    }

    const verifiedOutcome = receipt?.outcome === 'verified' || receipt?.outcome === undefined;
    const validOutcome = verifiedOutcome
      ? validVerifiedOutcome(receipt?.result)
      : receipt?.outcome === 'rolled_back' && validRollbackOutcome(receipt?.result);

    if (!receipt || receipt.version !== 1 ||
        receipt.operationId !== operationId ||
        receipt.tenantId !== tenantId ||
        typeof receipt.workspaceId !== 'string' ||
        !/^[a-f0-9]{64}$/.test(receipt.workspaceId) ||
        typeof receipt.changeSetHash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(receipt.changeSetHash) ||
        typeof receipt.recordedAt !== 'string' ||
        !validOutcome) {
      fail('Project operation receipt schema or identity is invalid', 'PROJECT_OPERATION_RECEIPT_CORRUPT');
    }

    if (receipt.outcome === 'verified' || receipt.outcome === 'rolled_back') {
      const intent = this.readIntent({ operationId, tenantId });
      const journalMatches = (intent?.version === 2 || intent?.version === 3) &&
        validIntentChanges(intent.changes, intent.version) &&
        intent.workspaceId === receipt.workspaceId &&
        intent.changeSetHash === receipt.changeSetHash &&
        (receipt.outcome === 'verified'
          ? matchesVerifiedJournal(receipt.result, intent.changes)
          : matchesRollbackJournal(receipt.result, intent.changes));
      if (!journalMatches) {
        fail('Project operation receipt does not match its durable before-image journal', 'PROJECT_OPERATION_RECEIPT_CORRUPT');
      }
    }

    return receipt;
  }

  write({ operationId, tenantId, workspaceId, changeSetHash, result, requireIntentJournal = false }) {
    const verifiedOutcome = validVerifiedOutcome(result);
    const rolledBackOutcome = validRollbackOutcome(result);
    if (!validIdentity({ operationId, tenantId }) ||
        typeof workspaceId !== 'string' || !/^[a-f0-9]{64}$/.test(workspaceId) ||
        typeof changeSetHash !== 'string' || !/^[a-f0-9]{64}$/.test(changeSetHash) ||
        (!verifiedOutcome && !rolledBackOutcome)) {
      fail('Only verified or fully rolled-back project operations can be receipted', 'PROJECT_OPERATION_RECEIPT_INVALID');
    }

    this.ensureDirectory();
    const intent = this.readIntent({ operationId, tenantId });
    if (intent && (intent.workspaceId !== workspaceId || intent.changeSetHash !== changeSetHash)) {
      fail('Project receipt identity does not match its pending intent', 'PROJECT_OPERATION_RECEIPT_INTENT_IDENTITY_CONFLICT');
    }
    const hasCompleteJournal = Boolean(
      (intent?.version === 2 || intent?.version === 3) &&
      validIntentChanges(intent.changes, intent.version)
    );
    if (requireIntentJournal && !hasCompleteJournal) {
      fail('A complete durable before-image journal is required before committing this project receipt', 'PROJECT_OPERATION_RECEIPT_INTENT_INCOMPLETE');
    }
    if (rolledBackOutcome && !hasCompleteJournal) {
      fail('A safely rolled-back receipt requires a complete before-image journal', 'PROJECT_OPERATION_RECEIPT_INTENT_INCOMPLETE');
    }
    if (hasCompleteJournal &&
        ((verifiedOutcome && !matchesVerifiedJournal(result, intent.changes)) ||
          (rolledBackOutcome && !matchesRollbackJournal(result, intent.changes))) ) {
      fail('Project operation result does not match its durable before-image journal', 'PROJECT_OPERATION_RECEIPT_INTENT_IDENTITY_CONFLICT');
    }
    const receiptOutcome = hasCompleteJournal
      ? (verifiedOutcome ? 'verified' : 'rolled_back')
      : undefined;
    const filePath = this.receiptPath(operationId, tenantId);
    const lockPath = filePath + '.lock';
    const token = crypto.randomUUID();
    const ownerPath = path.join(lockPath, 'owner.' + token + '.json');
    let acquired = false;

    try {
      // A directory is the atomic lock primitive. Unlike check-then-unlink of
      // a lock file, rmdir succeeds only while this exact directory is empty.
      fs.mkdirSync(lockPath, 0o700);
      const ownerFd = fs.openSync(ownerPath, 'wx', 0o600);
      try {
        fs.writeFileSync(ownerFd, JSON.stringify({
          token,
          pid: process.pid,
          acquiredAt: new Date().toISOString()
        }) + '\n', 'utf8');
        fs.fsyncSync(ownerFd);
      } finally {
        fs.closeSync(ownerFd);
      }
      syncDirectory(this.directory);
      acquired = true;
    } catch (error) {
      if (error.code === 'EEXIST' || error.code === 'ENOTEMPTY') {
        fail('Project operation receipt is locked; refusing unsafe stale-lock reclamation', 'PROJECT_OPERATION_RECEIPT_LOCKED');
      }
      // An incompletely initialized lock is deliberately retained. Removing
      // it by pathname after an initialization error could delete a successor.
      throw error;
    }
    if (!acquired) {
      fail('Project operation receipt lock could not be acquired', 'PROJECT_OPERATION_RECEIPT_LOCKED');
    }

    let operationError;
    try {
      const existing = this.read({ operationId, tenantId });
      if (existing) {
        if (existing.workspaceId !== workspaceId || existing.changeSetHash !== changeSetHash) {
          fail('Operation ID is already bound to a different tenant-scoped project change', 'PROJECT_OPERATION_RECEIPT_IDENTITY_CONFLICT');
        }
        if (requireIntentJournal && !existing.outcome) {
          fail('Existing project receipt predates the durable before-image journal', 'PROJECT_OPERATION_RECEIPT_INTENT_INCOMPLETE');
        }
        return existing;
      }

      const receipt = {
        version: 1,
        ...(receiptOutcome ? { outcome: receiptOutcome } : {}),
        operationId,
        tenantId,
        workspaceId,
        changeSetHash,
        recordedAt: new Date().toISOString(),
        result
      };
      const serialized = JSON.stringify(receipt) + '\n';
      if (Buffer.byteLength(serialized, 'utf8') > MAX_RECEIPT_BYTES) {
        fail('Project operation receipt exceeds its maximum permitted size', 'PROJECT_OPERATION_RECEIPT_CORRUPT');
      }
      const temporary = filePath + '.tmp.' + token;
      let fd;
      let temporaryCreated = false;
      let receiptWriteError;
      try {
        fd = fs.openSync(temporary, 'wx', 0o600);
        temporaryCreated = true;
        fs.writeFileSync(fd, serialized, 'utf8');
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = undefined;
        fs.renameSync(temporary, filePath);
        syncDirectory(this.directory);
      } catch (error) {
        receiptWriteError = error;
        throw error;
      } finally {
        if (fd !== undefined) {
          try { fs.closeSync(fd); } catch {}
        }
        // An exclusive-open collision means this operation never owned the
        // pathname. Never remove a pre-existing temporary file on that path.
        if (temporaryCreated) {
          try { fs.unlinkSync(temporary); } catch (cleanupError) {
            if (cleanupError.code !== 'ENOENT') {
              if (receiptWriteError) {
                if (!Array.isArray(receiptWriteError.cleanupErrors)) receiptWriteError.cleanupErrors = [];
                receiptWriteError.cleanupErrors.push(cleanupError);
              } else {
                throw cleanupError;
              }
            }
          }
        }
      }
      return receipt;
    } catch (error) {
      operationError = error;
      throw error;
    } finally {
      // The unguessable per-acquisition marker path is the ownership
      // capability. A replacement lock has a different marker name, so this
      // cleanup can never unlink that successor's owner file.
      try {
        fs.unlinkSync(ownerPath);
        fs.rmdirSync(lockPath);
        syncDirectory(this.directory);
      } catch (cleanupError) {
        if (cleanupError.code !== 'ENOENT') {
          // A cleanup failure must not mask the primary write/commit error.
          // If the receipt rename already happened, callers can reconcile by
          // reading the receipt; retain both failures for diagnostics.
          if (operationError) {
            if (!Array.isArray(operationError.cleanupErrors)) operationError.cleanupErrors = [];
            operationError.cleanupErrors.push(cleanupError);
          } else {
            throw cleanupError;
          }
        }
      }
    }
  }
}

ProjectOperationReceiptStore.digest = digest;
module.exports = ProjectOperationReceiptStore;
