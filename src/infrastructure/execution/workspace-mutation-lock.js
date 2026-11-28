'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const ensurePrivateStorageDirectory = require('../filesystem/private-storage-directory');
const ProjectWorkspaceRecovery = require('./project-workspace-recovery');

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
    const unsupported = new Error('Filesystem does not provide durable directory synchronization for workspace locks');
    unsupported.code = 'PROJECT_WORKSPACE_LOCK_UNSUPPORTED_FILESYSTEM';
    unsupported.cause = error;
    throw unsupported;
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

function readPidNamespace() {
  let value;
  try {
    value = fs.readlinkSync('/proc/self/ns/pid');
  } catch (error) {
    const unsupported = new Error('Process namespace identity is unavailable');
    unsupported.code = 'PROJECT_WORKSPACE_LOCK_UNSUPPORTED_PLATFORM';
    unsupported.cause = error;
    throw unsupported;
  }
  if (typeof value !== 'string' || !/^pid:\[\d+\]$/.test(value)) {
    fail('Process namespace identity is malformed', 'PROJECT_WORKSPACE_LOCK_UNSUPPORTED_PLATFORM');
  }
  return value;
}

function readBootId() {
  let value;
  try {
    value = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  } catch (error) {
    const unsupported = new Error('Host boot identity is unavailable');
    unsupported.code = 'PROJECT_WORKSPACE_LOCK_UNSUPPORTED_PLATFORM';
    unsupported.cause = error;
    throw unsupported;
  }
  if (!/^[a-f0-9-]{16,64}$/i.test(value)) {
    fail('Host boot identity is unavailable', 'PROJECT_WORKSPACE_LOCK_UNSUPPORTED_PLATFORM');
  }
  return value;
}

function assertLocalFilesystem(directory) {
  const mountInfo = fs.readFileSync('/proc/self/mountinfo', 'utf8');
  const decodeMountPath = value => value.replace(/\\([0-7]{3})/g, (_, octal) =>
    String.fromCharCode(parseInt(octal, 8))
  );
  const target = path.resolve(directory);
  let selected = null;
  for (const line of mountInfo.split('\n')) {
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

const MISSING_OWNER = Symbol('missing-owner');
const INCOMPLETE_OWNER = Symbol('incomplete-owner');

function readOwner(lockPath, { allowIncomplete = false } = {}) {
  const ownerPath = path.join(lockPath, 'owner.json');
  let descriptor;
  try {
    const directoryStats = fs.lstatSync(lockPath);
    if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink() ||
        (typeof process.getuid === 'function' &&
          (directoryStats.uid !== process.getuid() || (directoryStats.mode & 0o7777) !== 0o700))) {
      fail('Workspace lock directory is not private and owned by the application user', 'PROJECT_WORKSPACE_LOCK_CORRUPT');
    }
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
    if (allowIncomplete && raw.length === 0) {
      const openedStats = fs.fstatSync(descriptor);
      let pathStats;
      try {
        pathStats = fs.lstatSync(ownerPath);
      } catch (error) {
        if (error.code === 'ENOENT') {
          fail('Workspace owner metadata changed during classification', 'PROJECT_WORKSPACE_LOCK_RECOVERY_CONFLICT');
        }
        throw error;
      }
      if (!pathStats.isFile() || pathStats.isSymbolicLink() ||
          pathStats.dev !== openedStats.dev || pathStats.ino !== openedStats.ino || pathStats.size !== 0) {
        fail('Workspace owner metadata changed during classification', 'PROJECT_WORKSPACE_LOCK_RECOVERY_CONFLICT');
      }
      return INCOMPLETE_OWNER;
    }
    const owner = JSON.parse(raw);
    if (!owner || owner.version !== 1 ||
        typeof owner.token !== 'string' || !/^[a-f0-9-]{36}$/i.test(owner.token) ||
        typeof owner.hostname !== 'string' || !owner.hostname ||
        typeof owner.bootId !== 'string' || !owner.bootId ||
        typeof owner.pidNamespace !== 'string' || !/^pid:\[\d+\]$/.test(owner.pidNamespace) ||
        !Number.isSafeInteger(owner.pid) || owner.pid < 1 ||
        typeof owner.processStartIdentity !== 'string' || !/^\d+$/.test(owner.processStartIdentity) ||
        ((owner.operationId === undefined) !== (owner.tenantId === undefined)) ||
        (owner.operationId !== undefined &&
          (typeof owner.operationId !== 'string' || !owner.operationId || owner.operationId.length > 256 ||
            typeof owner.tenantId !== 'string' || !owner.tenantId || owner.tenantId.length > 128)) ||
        typeof owner.acquiredAt !== 'string' ||
        typeof owner.workspaceId !== 'string' || !/^[a-f0-9]{64}$/.test(owner.workspaceId)) {
      fail('Workspace lock owner record is malformed', 'PROJECT_WORKSPACE_LOCK_CORRUPT');
    }
    return owner;
  } catch (error) {
    if (error.code === 'ENOENT') {
      if (allowIncomplete) return MISSING_OWNER;
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


function readPrivateJson(filePath, { maxBytes = 8192, allowTwoLinks = false, code = 'PROJECT_WORKSPACE_LOCK_CORRUPT', label = 'Workspace recovery record' } = {}) {
  let fd;
  try {
    if (typeof fs.constants.O_NOFOLLOW !== 'number') {
      fail('Safe recovery metadata reads are unsupported on this platform', 'PROJECT_WORKSPACE_LOCK_UNSUPPORTED_PLATFORM');
    }
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stats = fs.fstatSync(fd);
    if (!stats.isFile() || stats.nlink !== 1 && !(allowTwoLinks && stats.nlink === 2) ||
        stats.size > maxBytes ||
        (typeof process.getuid === 'function' &&
          (stats.uid !== process.getuid() || (stats.mode & 0o7777) !== 0o600))) {
      fail(label + ' is unsafe', code);
    }
    const before = fs.fstatSync(fd);
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let total = 0;
    while (total < buffer.length) {
      const count = fs.readSync(fd, buffer, total, buffer.length - total, total);
      if (count === 0) break;
      total += count;
    }
    const after = fs.fstatSync(fd);
    if (total > maxBytes || before.dev !== after.dev || before.ino !== after.ino ||
        before.size !== after.size || total !== after.size) {
      fail(label + ' changed while being read or exceeds its size limit', code);
    }
    const raw = buffer.subarray(0, total).toString('utf8');
    if (!Buffer.from(raw, 'utf8').equals(buffer.subarray(0, total))) {
      fail(label + ' is not valid UTF-8', code);
    }
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === 'ELOOP') fail(label + ' must not be a symbolic link', code);
    if (error instanceof SyntaxError) fail(label + ' is corrupt JSON', code);
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function claimProcessState(claim) {
  const processOwner = claim.process;
  if (processOwner.hostname !== os.hostname() ||
      processOwner.bootId !== readBootId() ||
      processOwner.pidNamespace !== readPidNamespace()) {
    fail('Recovery claim belongs to another host, boot, or PID namespace',
      'PROJECT_WORKSPACE_LOCK_OWNER_UNKNOWN');
  }
  try {
    const current = readProcessStartIdentity(processOwner.pid);
    return current === processOwner.processStartIdentity ? 'active' : 'dead';
  } catch (error) {
    if (error.code === 'ENOENT') return 'dead';
    throw error;
  }
}

function validateRecoveryClaim(claim, parentToken, workspaceId) {
  if (!claim || claim.version !== 1 || claim.parentToken !== parentToken ||
      typeof claim.token !== 'string' || !/^[a-f0-9-]{36}$/i.test(claim.token) ||
      claim.workspaceId !== workspaceId ||
      !claim.process || typeof claim.process.hostname !== 'string' ||
      typeof claim.process.bootId !== 'string' ||
      typeof claim.process.pidNamespace !== 'string' ||
      !/^pid:\[\d+\]$/.test(claim.process.pidNamespace) ||
      !Number.isSafeInteger(claim.process.pid) || claim.process.pid < 1 ||
      typeof claim.process.processStartIdentity !== 'string' || !/^\d+$/.test(claim.process.processStartIdentity)) {
    fail('Workspace recovery claim is malformed or belongs to another operation',
      'PROJECT_WORKSPACE_LOCK_CORRUPT');
  }
}

function acquireRecoveryClaim(lockPath, owner, workspaceId) {
  let parentToken = owner.token;
  for (let generation = 0; generation < 64; generation += 1) {
    const claimPath = path.join(lockPath,
      'recovery.claim.' + crypto.createHash('sha256').update(parentToken, 'utf8').digest('hex') + '.json');
    let existing;
    try {
      existing = readPrivateJson(claimPath, {
        maxBytes: 4096,
        allowTwoLinks: true,
        code: 'PROJECT_WORKSPACE_LOCK_CORRUPT',
        label: 'Workspace recovery claim'
      });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    if (existing) {
      validateRecoveryClaim(existing, parentToken, workspaceId);
      if (claimProcessState(existing) === 'active') {
        fail('Another process currently owns the exclusive workspace recovery claim',
          'PROJECT_WORKSPACE_LOCK_RECOVERY_IN_PROGRESS');
      }
      parentToken = existing.token;
      continue;
    }

    const token = crypto.randomUUID();
    const claim = {
      version: 1,
      workspaceId,
      parentToken,
      token,
      process: {
        hostname: os.hostname(),
        bootId: readBootId(),
        pidNamespace: readPidNamespace(),
        pid: process.pid,
        processStartIdentity: readProcessStartIdentity('self')
      },
      acquiredAt: new Date().toISOString()
    };
    const temporaryPath = path.join(lockPath, '.recovery-claim-' + token + '.tmp');
    let fd;
    try {
      fd = fs.openSync(temporaryPath, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify(claim) + '\n', 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      try {
        // Hard-link publication is atomic and never replaces a successor claim.
        fs.linkSync(temporaryPath, claimPath);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        fs.unlinkSync(temporaryPath);
        continue;
      }
      fs.unlinkSync(temporaryPath);
      syncDirectory(lockPath);
      return { claim, claimPath };
    } catch (error) {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch {}
      }
      throw error;
    }
  }
  fail('Workspace recovery claim history exceeds the supported generation limit',
    'PROJECT_WORKSPACE_LOCK_RECOVERY_GENERATION_LIMIT');
}

function assertRecoveryClaim(claimPath, expectedClaim) {
  const current = readPrivateJson(claimPath, {
    maxBytes: 4096,
    allowTwoLinks: true,
    code: 'PROJECT_WORKSPACE_LOCK_RECOVERY_CLAIM_LOST',
    label: 'Workspace recovery claim'
  });
  if (current.token !== expectedClaim.token ||
      current.parentToken !== expectedClaim.parentToken ||
      current.workspaceId !== expectedClaim.workspaceId ||
      current.process.pid !== process.pid ||
      current.process.processStartIdentity !== expectedClaim.process.processStartIdentity) {
    fail('Workspace recovery claim ownership changed', 'PROJECT_WORKSPACE_LOCK_RECOVERY_CLAIM_LOST');
  }
}

function releaseRecoveryClaim(claimPath, expectedClaim, lockPath) {
  try {
    assertRecoveryClaim(claimPath, expectedClaim);
    fs.unlinkSync(claimPath);
    syncDirectory(lockPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function stageRecoveryDecision(lockPath, owner, operatorId, reason) {
  const recoveryPath = path.join(lockPath, 'recovery.json');
  try {
    const existing = readPrivateJson(recoveryPath, {
      maxBytes: 8192,
      allowTwoLinks: true,
      code: 'PROJECT_WORKSPACE_LOCK_CORRUPT',
      label: 'Workspace recovery decision'
    });
    if (existing.version !== 1 || existing.owner?.token !== owner.token ||
        existing.owner?.workspaceId !== owner.workspaceId ||
        existing.operatorId !== operatorId || existing.reason !== reason ||
        typeof existing.recoveredAt !== 'string') {
      fail('A different workspace recovery decision is already staged',
        'PROJECT_WORKSPACE_LOCK_RECOVERY_CONFLICT');
    }
    return existing;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const recovery = {
    version: 1,
    operatorId,
    reason,
    recoveredAt: new Date().toISOString(),
    owner
  };
  const token = crypto.randomUUID();
  const temporaryPath = path.join(lockPath, '.recovery-decision-' + token + '.tmp');
  let fd;
  try {
    fd = fs.openSync(temporaryPath, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(recovery, null, 2) + '\n', 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    try {
      fs.linkSync(temporaryPath, recoveryPath);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      fs.unlinkSync(temporaryPath);
      return stageRecoveryDecision(lockPath, owner, operatorId, reason);
    }
    fs.unlinkSync(temporaryPath);
    syncDirectory(lockPath);
    return recovery;
  } catch (error) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
    throw error;
  }
}

class WorkspaceMutationLock {
  constructor({ workspaceRoot, lockDirectory, operationId = '', tenantId = '' } = {}) {
    if (typeof workspaceRoot !== 'string' || !workspaceRoot.trim()) {
      throw new TypeError('workspaceRoot is required');
    }
    if (typeof lockDirectory !== 'string' || !lockDirectory.trim()) {
      throw new TypeError('lockDirectory is required');
    }
    if (process.platform !== 'linux') {
      fail('Cross-process workspace mutation locks are supported only on Linux hosts', 'PROJECT_WORKSPACE_LOCK_UNSUPPORTED_PLATFORM');
    }
    if ((operationId || tenantId) &&
        (typeof operationId !== 'string' || !operationId || operationId.length > 256 ||
          typeof tenantId !== 'string' || !tenantId || tenantId.length > 128)) {
      fail('Workspace lock operation identity is invalid', 'PROJECT_WORKSPACE_LOCK_IDENTITY_INVALID');
    }
    this.operationId = operationId;
    this.tenantId = tenantId;
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
    const lockRelativeToWorkspace = path.relative(this.workspaceRoot, this.lockDirectory);
    const lockIsInsideWorkspace = !lockRelativeToWorkspace ||
      (lockRelativeToWorkspace !== '..' &&
        !lockRelativeToWorkspace.startsWith('..' + path.sep) &&
        !path.isAbsolute(lockRelativeToWorkspace));
    if (lockIsInsideWorkspace) {
      fail('Workspace lock storage must be outside the mutable workspace', 'PROJECT_WORKSPACE_LOCK_DIRECTORY_IN_WORKSPACE');
    }
    this.workspaceId = crypto.createHash('sha256').update(this.workspaceRoot, 'utf8').digest('hex');
    this.lockPath = path.join(this.lockDirectory, this.workspaceId + '.lock');
  }

  async acquire() {
    const token = crypto.randomUUID();
    const owner = {
      version: 1,
      token,
      workspaceId: this.workspaceId,
      ...(this.operationId && this.tenantId ? {
        operationId: this.operationId,
        tenantId: this.tenantId
      } : {}),
      hostname: os.hostname(),
      bootId: readBootId(),
      pidNamespace: readPidNamespace(),
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
        // Atomically retire the owned lock directory. Unlink-then-rmdir has
        // a crash window that leaves an ownerless lock which cannot be safely
        // attributed or recovered. The tombstone preserves the owner evidence.
        const retiredPath = this.lockPath + '.released.' + token;
        fs.renameSync(this.lockPath, retiredPath);
        // The rename is the release commit point. Once its parent directory is
        // synced, the active lock is durably absent. Remove the retired metadata
        // afterward to avoid one permanent tombstone per successful mutation.
        syncDirectory(this.lockDirectory);
        released = true;
        try {
          fs.unlinkSync(path.join(retiredPath, 'owner.json'));
          fs.rmdirSync(retiredPath);
          syncDirectory(this.lockDirectory);
        } catch {
          // A leftover .released directory is inert evidence, never an active
          // lock. Cleanup failure must not recreate or weaken the release.
        }
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
    const owner = readOwner(this.lockPath);
    if (owner.workspaceId !== this.workspaceId) {
      fail('Workspace lock belongs to a different workspace identity', 'PROJECT_WORKSPACE_LOCK_RECOVERY_CONFLICT');
    }
    return owner;
  }

  classify() {
    let directoryStats;
    try {
      directoryStats = fs.lstatSync(this.lockPath);
    } catch (error) {
      if (error.code === 'ENOENT') {
        return { state: 'unlocked', reason: 'lock_absent', owner: null, recoveryRequired: false };
      }
      throw error;
    }
    if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink() ||
        (typeof process.getuid === 'function' &&
          (directoryStats.uid !== process.getuid() || (directoryStats.mode & 0o7777) !== 0o700))) {
      fail('Workspace lock directory is not private and owned by the application user', 'PROJECT_WORKSPACE_LOCK_CORRUPT');
    }

    const owner = readOwner(this.lockPath, { allowIncomplete: true });
    if (owner === MISSING_OWNER || owner === INCOMPLETE_OWNER) {
      let currentDirectoryStats;
      try {
        currentDirectoryStats = fs.lstatSync(this.lockPath);
      } catch (error) {
        if (error.code === 'ENOENT') {
          fail('Workspace lock changed while it was being classified', 'PROJECT_WORKSPACE_LOCK_RECOVERY_CONFLICT');
        }
        throw error;
      }
      if (!currentDirectoryStats.isDirectory() || currentDirectoryStats.isSymbolicLink() ||
          currentDirectoryStats.dev !== directoryStats.dev || currentDirectoryStats.ino !== directoryStats.ino) {
        fail('Workspace lock identity changed during classification', 'PROJECT_WORKSPACE_LOCK_RECOVERY_CONFLICT');
      }
      if (owner === MISSING_OWNER) {
        try {
          fs.lstatSync(path.join(this.lockPath, 'owner.json'));
          fail('Workspace owner metadata appeared during classification', 'PROJECT_WORKSPACE_LOCK_RECOVERY_CONFLICT');
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          if (error.code === 'PROJECT_WORKSPACE_LOCK_RECOVERY_CONFLICT') throw error;
        }
        return { state: 'recovery_required', reason: 'owner_metadata_missing', owner: null, recoveryRequired: true };
      }
      return { state: 'recovery_required', reason: 'owner_metadata_incomplete', owner: null, recoveryRequired: true };
    }
    if (owner.workspaceId !== this.workspaceId) {
      fail('Workspace lock belongs to a different workspace identity', 'PROJECT_WORKSPACE_LOCK_RECOVERY_CONFLICT');
    }
    if (owner.hostname !== os.hostname() || owner.bootId !== readBootId() ||
        owner.pidNamespace !== readPidNamespace()) {
      fail('Lock owner belongs to another host, boot, or PID namespace; its liveness is unknown',
        'PROJECT_WORKSPACE_LOCK_OWNER_UNKNOWN');
    }

    let processStartIdentity;
    try {
      processStartIdentity = readProcessStartIdentity(owner.pid);
    } catch (error) {
      if (error.code === 'ENOENT') {
        return { state: 'recovery_required', reason: 'owner_process_missing', owner, recoveryRequired: true };
      }
      throw error;
    }
    if (processStartIdentity !== owner.processStartIdentity) {
      return { state: 'recovery_required', reason: 'owner_process_replaced', owner, recoveryRequired: true };
    }
    return { state: 'locked', reason: 'owner_process_active', owner, recoveryRequired: false };
  }

  recover({ expectedToken, operatorId, reason, receiptStore } = {}) {
    if (typeof expectedToken !== 'string' || !expectedToken ||
        typeof operatorId !== 'string' || !operatorId.trim() || operatorId.length > 128 ||
        typeof reason !== 'string' || !reason.trim() || reason.length > 1024) {
      fail('Explicit lock recovery requires expectedToken, operatorId, and reason',
        'PROJECT_WORKSPACE_LOCK_RECOVERY_INPUT_INVALID');
    }
    const owner = readOwner(this.lockPath);
    if (owner.token !== expectedToken || owner.workspaceId !== this.workspaceId) {
      fail('Workspace lock identity changed; refusing recovery',
        'PROJECT_WORKSPACE_LOCK_RECOVERY_CONFLICT');
    }
    if (owner.hostname !== os.hostname() || owner.bootId !== readBootId() ||
        owner.pidNamespace !== readPidNamespace()) {
      fail('Lock owner belongs to another host, boot, or PID namespace; its liveness is unknown',
        'PROJECT_WORKSPACE_LOCK_OWNER_UNKNOWN');
    }

    let currentStartIdentity;
    try {
      currentStartIdentity = readProcessStartIdentity(owner.pid);
    } catch (error) {
      if (error.code === 'ENOENT') currentStartIdentity = null;
      else throw error;
    }
    if (currentStartIdentity === owner.processStartIdentity) {
      fail('The recorded owner process is still alive; stop it normally before recovery',
        'PROJECT_WORKSPACE_LOCK_OWNER_ACTIVE');
    }

    if (!receiptStore) {
      fail('Durable operation receipt storage is required for workspace recovery',
        'PROJECT_OPERATION_RECEIPT_STORE_REQUIRED');
    }

    const claim = acquireRecoveryClaim(this.lockPath, owner, this.workspaceId);
    let completed = false;
    let primaryError;
    try {
      const recovery = stageRecoveryDecision(
        this.lockPath,
        owner,
        operatorId.trim(),
        reason.trim()
      );
      const assertClaim = () => assertRecoveryClaim(claim.claimPath, claim.claim);
      const operation = new ProjectWorkspaceRecovery({
        workspaceRoot: this.workspaceRoot,
        receiptStore,
        assertClaim
      }).restore({
        owner,
        operatorId: operatorId.trim(),
        reason: reason.trim()
      });

      assertClaim();
      const quarantinePath = this.lockPath + '.quarantine.' + crypto.randomUUID();
      fs.renameSync(this.lockPath, quarantinePath);
      syncDirectory(this.lockDirectory);
      completed = true;
      return {
        recovered: true,
        quarantinePath,
        recovery,
        outcome: operation.outcome,
        receipt: operation.receipt
      };
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      if (!completed) {
        try {
          releaseRecoveryClaim(claim.claimPath, claim.claim, this.lockPath);
        } catch (cleanupError) {
          if (primaryError) {
            if (!Array.isArray(primaryError.cleanupErrors)) primaryError.cleanupErrors = [];
            primaryError.cleanupErrors.push(cleanupError);
          } else {
            throw cleanupError;
          }
        }
      }
    }
  }
}

module.exports = WorkspaceMutationLock;
