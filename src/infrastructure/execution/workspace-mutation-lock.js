'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const ensurePrivateStorageDirectory = require('../filesystem/private-storage-directory');

function fail(message, code) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function syncDirectory(directory) {
  let descriptor;
  try {
    descriptor = fs.openSync(directory, 'r');
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR'].includes(error.code)) throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function readProcessStartIdentity(pid) {
  const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
  const close = stat.lastIndexOf(')');
  if (close < 0) fail('Process identity record is malformed', 'PROJECT_WORKSPACE_LOCK_OWNER_UNKNOWN');
  const fields = stat.slice(close + 1).trim().split(/\s+/);
  const startTime = fields[19];
  if (!startTime || !/^\d+$/.test(startTime)) {
    fail('Process start identity is unavailable', 'PROJECT_WORKSPACE_LOCK_OWNER_UNKNOWN');
  }
  return startTime;
}

function readBootId() {
  const value = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  if (!/^[a-f0-9-]{16,64}$/i.test(value)) {
    fail('Host boot identity is unavailable', 'PROJECT_WORKSPACE_LOCK_UNSUPPORTED_PLATFORM');
  }
  return value;
}

function assertLocalFilesystem(directory) {
  const mountInfo = fs.readFileSync('/proc/self/mountinfo', 'utf8');
  const decodeMountPath = value => value.replace(/\\\\([0-7]{3})/g, (_, octal) =>
    String.fromCharCode(parseInt(octal, 8))
  );
  const target = path.resolve(directory);
  let selected = null;
  for (const line of mountInfo.split('\\n')) {
    const separator = line.indexOf(' - ');
    if (separator < 0) continue;
    const left = line.slice(0, separator).split(' ');
    const right = line.slice(separator + 3).split(' ');
    const mountPoint = decodeMountPath(left[4] || '');
    const fileSystem = right[0] || '';
    if ((target === mountPoint || target.startsWith(mountPoint.endsWith('/') ? mountPoint : mountPoint + path.sep)) &&
        (!selected || mountPoint.length > selected.mountPoint.length)) {
      selected = { mountPoint, fileSystem };
    }
  }
  const localFilesystems = new Set(['ext4', 'f2fs', 'xfs', 'btrfs', 'tmpfs', 'overlay']);
  if (!selected || !localFilesystems.has(selected.fileSystem)) {
    fail('Workspace lock storage must use a supported local filesystem; network or unknown filesystems are denied',
      'PROJECT_WORKSPACE_LOCK_UNSUPPORTED_FILESYSTEM');
  }
}

function readOwner(lockPath) {
  const ownerPath = path.join(lockPath, 'owner.json');
  let descriptor;
  try {
    if (typeof fs.constants.O_NOFOLLOW !== 'number') {
      fail('Safe workspace lock inspection is unsupported on this platform', 'PROJECT_WORKSPACE_LOCK_UNSUPPORTED_PLATFORM');
    }
    descriptor = fs.openSync(ownerPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stats = fs.fstatSync(descriptor);
    if (!stats.isFile() || stats.nlink !== 1 || stats.size > 4096) {
      fail('Workspace lock owner record is unsafe', 'PROJECT_WORKSPACE_LOCK_CORRUPT');
    }
    if (typeof process.getuid === 'function' &&
        (stats.uid !== process.getuid() || (stats.mode & 0o7777) !== 0o600)) {
      fail('Workspace lock owner record is not private', 'PROJECT_WORKSPACE_LOCK_CORRUPT');
    }
    const raw = fs.readFileSync(descriptor, 'utf8');
    const owner = JSON.parse(raw);
    if (!owner || owner.version !== 1 ||
        typeof owner.token !== 'string' || !/^[a-f0-9-]{36}$/i.test(owner.token) ||
        typeof owner.hostname !== 'string' || !owner.hostname ||
        typeof owner.bootId !== 'string' || !owner.bootId ||
        !Number.isSafeInteger(owner.pid) || owner.pid < 1 ||
        typeof owner.processStartIdentity !== 'string' ||
        typeof owner.acquiredAt !== 'string' ||
        typeof owner.workspaceId !== 'string' || !/^[a-f0-9]{64}$/.test(owner.workspaceId)) {
      fail('Workspace lock owner record is malformed', 'PROJECT_WORKSPACE_LOCK_CORRUPT');
    }
    return owner;
  } catch (error) {
    if (error.code === 'ENOENT') {
      fail('Workspace lock exists without a complete owner record; operator intervention is required', 'PROJECT_WORKSPACE_LOCK_CORRUPT');
    }
    if (error.code === 'ELOOP') {
      fail('Workspace lock owner record must not be a symbolic link', 'PROJECT_WORKSPACE_LOCK_CORRUPT');
    }
    if (error instanceof SyntaxError) {
      fail('Workspace lock owner record is not valid JSON', 'PROJECT_WORKSPACE_LOCK_CORRUPT');
    }
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

class WorkspaceMutationLock {
  constructor({ workspaceRoot, lockDirectory } = {}) {
    if (typeof workspaceRoot !== 'string' || !workspaceRoot.trim()) {
      throw new TypeError('workspaceRoot is required');
    }
    if (typeof lockDirectory !== 'string' || !lockDirectory.trim()) {
      throw new TypeError('lockDirectory is required');
    }
    if (process.platform !== 'linux') {
      fail('Cross-process workspace mutation locks are supported only on Linux hosts', 'PROJECT_WORKSPACE_LOCK_UNSUPPORTED_PLATFORM');
    }
    this.workspaceRoot = fs.realpathSync.native(path.resolve(workspaceRoot));
    this.lockDirectory = ensurePrivateStorageDirectory(path.resolve(lockDirectory), {
      create: true,
      repairPermissions: false,
      errorCodes: {
        directoryInvalid: 'PROJECT_WORKSPACE_LOCK_DIRECTORY_INVALID',
        directoryOwnerInvalid: 'PROJECT_WORKSPACE_LOCK_DIRECTORY_OWNER_INVALID',
        directoryPermissionsInvalid: 'PROJECT_WORKSPACE_LOCK_DIRECTORY_PERMISSIONS_INVALID',
        parentInvalid: 'PROJECT_WORKSPACE_LOCK_PARENT_INVALID',
        parentUntrusted: 'PROJECT_WORKSPACE_LOCK_PARENT_UNTRUSTED'
      }
    });
    assertLocalFilesystem(this.lockDirectory);
    this.workspaceId = crypto.createHash('sha256').update(this.workspaceRoot, 'utf8').digest('hex');
    this.lockPath = path.join(this.lockDirectory, this.workspaceId + '.lock');
  }

  async acquire() {
    const token = crypto.randomUUID();
    const owner = {
      version: 1,
      token,
      workspaceId: this.workspaceId,
      hostname: os.hostname(),
      bootId: readBootId(),
      pid: process.pid,
      processStartIdentity: readProcessStartIdentity('self'),
      acquiredAt: new Date().toISOString()
    };
    try {
      fs.mkdirSync(this.lockPath, 0o700);
    } catch (error) {
      if (error.code === 'EEXIST' || error.code === 'ENOTEMPTY') {
        const locked = new Error('Workspace mutation is locked; inspect and recover only through the operator procedure');
        locked.code = 'PROJECT_WORKSPACE_MUTATION_LOCKED';
        throw locked;
      }
      throw error;
    }

    let descriptor;
    try {
      descriptor = fs.openSync(path.join(this.lockPath, 'owner.json'), 'wx', 0o600);
      fs.writeFileSync(descriptor, JSON.stringify(owner) + '\n', 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      syncDirectory(this.lockPath);
      syncDirectory(this.lockDirectory);
    } catch (error) {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor); } catch {}
      }
      // A partially initialized lock is intentionally retained. Removing it
      // by pathname could race with a successor and permit concurrent writes.
      throw error;
    }

    let released = false;
    return {
      metadata: owner,
      release: async () => {
        if (released) return;
        const current = readOwner(this.lockPath);
        if (current.token !== token || current.workspaceId !== this.workspaceId) {
          fail('Workspace lock ownership changed; refusing to release another owner lock', 'PROJECT_WORKSPACE_LOCK_OWNERSHIP_LOST');
        }
        fs.unlinkSync(path.join(this.lockPath, 'owner.json'));
        fs.rmdirSync(this.lockPath);
        syncDirectory(this.lockDirectory);
        released = true;
      }
    };
  }

  inspect() {
    try {
      const stats = fs.lstatSync(this.lockPath);
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        fail('Workspace lock path is not a trusted directory', 'PROJECT_WORKSPACE_LOCK_CORRUPT');
      }
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    return readOwner(this.lockPath);
  }

  recover({ expectedToken, operatorId, reason } = {}) {
    if (typeof expectedToken !== 'string' || !expectedToken ||
        typeof operatorId !== 'string' || !operatorId.trim() ||
        typeof reason !== 'string' || !reason.trim()) {
      fail('Explicit lock recovery requires expectedToken, operatorId, and reason', 'PROJECT_WORKSPACE_LOCK_RECOVERY_INPUT_INVALID');
    }
    const owner = readOwner(this.lockPath);
    if (owner.token !== expectedToken || owner.workspaceId !== this.workspaceId) {
      fail('Workspace lock identity changed; refusing recovery', 'PROJECT_WORKSPACE_LOCK_RECOVERY_CONFLICT');
    }
    if (owner.hostname !== os.hostname() || owner.bootId !== readBootId()) {
      fail('Lock owner belongs to another host or boot session; automatic recovery is unsafe', 'PROJECT_WORKSPACE_LOCK_OWNER_UNKNOWN');
    }

    let currentStartIdentity;
    try {
      currentStartIdentity = readProcessStartIdentity(owner.pid);
    } catch (error) {
      if (error.code === 'ENOENT') currentStartIdentity = null;
      else throw error;
    }
    if (currentStartIdentity === owner.processStartIdentity) {
      fail('The recorded owner process is still alive; stop it normally before recovery', 'PROJECT_WORKSPACE_LOCK_OWNER_ACTIVE');
    }
    if (currentStartIdentity !== null) {
      // A reused PID is not the recorded owner; start-time identity proves
      // that the original process no longer owns this lock.
    }

    const quarantinePath = this.lockPath + '.quarantine.' + crypto.randomUUID();
    fs.renameSync(this.lockPath, quarantinePath);
    syncDirectory(this.lockDirectory);
    const recovery = {
      version: 1,
      operatorId: operatorId.trim(),
      reason: reason.trim(),
      recoveredAt: new Date().toISOString(),
      owner
    };
    const recoveryPath = path.join(quarantinePath, 'recovery.json');
    const descriptor = fs.openSync(recoveryPath, 'wx', 0o600);
    try {
      fs.writeFileSync(descriptor, JSON.stringify(recovery, null, 2) + '\n', 'utf8');
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    syncDirectory(quarantinePath);
    syncDirectory(this.lockDirectory);
    return { recovered: true, quarantinePath, recovery };
  }
}

module.exports = WorkspaceMutationLock;
