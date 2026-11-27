const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { isDeepStrictEqual } = require('node:util');
const ensurePrivateStorageDirectory = require('../../filesystem/private-storage-directory');

const MAX_EVENT_FILE_BYTES = 64 * 1024 * 1024;
const PRIVATE_FILE_MODE = 0o600;

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

function validatePrivateEventFile(stats) {
  if (!stats.isFile() || stats.nlink !== 1n) {
    fail('Event storage must be a single-link regular file', 'EVENT_STORAGE_CORRUPT');
  }
  if (process.platform !== 'win32' && typeof process.getuid === 'function') {
    if (stats.uid !== BigInt(process.getuid())) {
      fail('Event storage file must be owned by the application user', 'EVENT_STORAGE_FILE_OWNER_INVALID');
    }
    if ((stats.mode & 0o7777n) !== BigInt(PRIVATE_FILE_MODE)) {
      fail('Event storage file must have private mode 0600', 'EVENT_STORAGE_FILE_PERMISSIONS_INVALID');
    }
  }
}

function fail(message, code) { const error = new Error(message); error.code = code; throw error; }

function readBoundedFile(fd, maxBytes) {
  const buffer = Buffer.allocUnsafe(maxBytes + 1);
  let total = 0;
  while (total < buffer.length) { const count = fs.readSync(fd, buffer, total, buffer.length - total, null); if (count === 0) break; total += count; }
  if (total > maxBytes) fail('Event storage exceeds its maximum permitted size', 'EVENT_STORAGE_TOO_LARGE');
  return buffer.subarray(0, total).toString('utf8');
}

class EventRepository {
  constructor(filePath, { lockTimeoutMs = 30000 } = {}) {
    if (!filePath) {
      throw new TypeError('filePath is required');
    }
    if (!Number.isInteger(lockTimeoutMs) || lockTimeoutMs < 1) {
      throw new TypeError('lockTimeoutMs must be a positive integer');
    }

    this.lockTimeoutMs = lockTimeoutMs;
    this.directory = path.resolve(path.dirname(filePath));
    this.filePath = path.join(this.directory, path.basename(filePath));
    this.lockPath = this.filePath + '.lock';
    this.ensureStorage();
  }

  ensureStorage() {
    if (typeof fs.constants.O_NOFOLLOW !== 'number') {
      fail('Safe JSON event storage is unsupported on this platform', 'EVENT_STORAGE_UNSAFE_FILESYSTEM');
    }

    this.directory = ensurePrivateStorageDirectory(this.directory, {
      mode: 0o700,
      repairPermissions: true,
      errorCodes: {
        directoryInvalid: 'EVENT_STORAGE_DIRECTORY_INVALID',
        directoryOwnerInvalid: 'EVENT_STORAGE_DIRECTORY_OWNER_INVALID',
        directoryPermissionsInvalid: 'EVENT_STORAGE_DIRECTORY_PERMISSIONS_INVALID',
        parentInvalid: 'EVENT_STORAGE_DIRECTORY_INVALID',
        parentUntrusted: 'EVENT_STORAGE_PARENT_UNTRUSTED'
      }
    });
    this.filePath = path.join(this.directory, path.basename(this.filePath));
    this.lockPath = this.filePath + '.lock';

    this.withLock(() => {
      try {
        const descriptor = fs.openSync(this.filePath, 'wx', PRIVATE_FILE_MODE);
        try {
          fs.writeFileSync(descriptor, '[]\n', 'utf8');
          fs.fsyncSync(descriptor);
        } finally {
          fs.closeSync(descriptor);
        }
        syncDirectory(this.directory);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
  
      let descriptor;
      try {
        descriptor = fs.openSync(this.filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        validatePrivateEventFile(fs.fstatSync(descriptor, { bigint: true }));
      } catch (error) {
        if (error.code === 'ELOOP') {
          fail('Event storage must not be a symbolic link', 'EVENT_STORAGE_CORRUPT');
        }
        throw error;
      } finally {
        if (descriptor !== undefined) {
          try { fs.closeSync(descriptor); } catch {}
        }
      }
    });
  }

  read() {
    let descriptor;
    try {
      descriptor = fs.openSync(this.filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const stats = fs.fstatSync(descriptor, { bigint: true });
      validatePrivateEventFile(stats);
      if (stats.size > MAX_EVENT_FILE_BYTES) fail('Event storage exceeds its maximum permitted size', 'EVENT_STORAGE_TOO_LARGE');
      const raw = readBoundedFile(descriptor, MAX_EVENT_FILE_BYTES);
      if (!raw.trim()) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) fail('Event storage root must be an array', 'EVENT_STORAGE_CORRUPT');
      return parsed;
    } catch (error) {
      if (error.code === 'ELOOP') fail('Event storage must not be a symbolic link', 'EVENT_STORAGE_CORRUPT');
      if (['EVENT_STORAGE_CORRUPT','EVENT_STORAGE_TOO_LARGE','EVENT_STORAGE_UNSAFE_FILESYSTEM'].includes(error.code)) throw error;
      if (error instanceof SyntaxError) { const invalid = new Error('Event storage contains invalid JSON'); invalid.code = 'EVENT_STORAGE_CORRUPT'; invalid.cause = error; throw invalid; }
      throw error;
    } finally { if (descriptor !== undefined) { try { fs.closeSync(descriptor); } catch {} } }
  }

  write(events) {
    const serialized = Buffer.from(JSON.stringify(events, null, 2) + '\n', 'utf8');
    if (serialized.length > MAX_EVENT_FILE_BYTES) {
      fail('Event storage exceeds its maximum permitted size', 'EVENT_STORAGE_TOO_LARGE');
    }

    const temporaryFile = this.filePath + '.tmp.' + crypto.randomUUID();
    let descriptor;
    let created = false;
    let renamed = false;
    try {
      descriptor = fs.openSync(temporaryFile, 'wx', PRIVATE_FILE_MODE);
      created = true;
      fs.writeFileSync(descriptor, serialized);
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(temporaryFile, this.filePath);
      renamed = true;
      syncDirectory(this.directory);
    } catch (error) {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor); } catch (cleanupError) {
          error.cleanupErrors = [...(error.cleanupErrors || []), cleanupError];
        }
      }
      if (created && !renamed) {
        try { fs.unlinkSync(temporaryFile); } catch (cleanupError) {
          if (cleanupError.code !== 'ENOENT') {
            error.cleanupErrors = [...(error.cleanupErrors || []), cleanupError];
          }
        }
      }
      if (renamed) {
        error.code = error.code || 'EVENT_STORAGE_DURABILITY_UNCERTAIN';
        error.durabilityUncertain = true;
      }
      throw error;
    }
  }

  withLock(operation) {
    const deadline = Date.now() + this.lockTimeoutMs;
    while (true) {
      const token = crypto.randomUUID();
      try {
        fs.mkdirSync(this.lockPath, { mode: 0o700 });
      } catch (error) {
        if (error.code !== 'EEXIST' && error.code !== 'ENOTEMPTY') throw error;
        if (Date.now() >= deadline) {
          const lockError = new Error('Event storage lock timeout; existing lock was left untouched');
          lockError.code = 'EVENT_STORAGE_LOCK_TIMEOUT';
          throw lockError;
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        continue;
      }

      const ownerPath = path.join(this.lockPath, 'owner.' + token + '.json');
      let ownerFd;
      try {
        ownerFd = fs.openSync(ownerPath, 'wx', 0o600);
        fs.writeFileSync(ownerFd, JSON.stringify({ token, pid: process.pid, acquiredAt: new Date().toISOString() }) + '\n', 'utf8');
        fs.fsyncSync(ownerFd);
      } catch (error) {
        if (ownerFd !== undefined) { try { fs.closeSync(ownerFd); } catch {} }
        // An incomplete lock is retained; never recursively remove by pathname.
        throw error;
      }
      fs.closeSync(ownerFd);

      try {
        return operation();
      } finally {
        // Only the unique marker proves ownership. If it is absent, leave the
        // lock directory untouched rather than risking a successor's lock.
        fs.unlinkSync(ownerPath);
        fs.rmdirSync(this.lockPath);
      }
    }
  }
  normalize(event) {
    if (!event || typeof event !== 'object') {
      throw new TypeError('event must be an object');
    }

    return {
      id: event.id || crypto.randomUUID(),
      type: event.type,
      executionId: event.executionId || null,
      goalId: event.goalId || null,
      aggregateId: event.aggregateId || event.workflowId || null,
      sequence: event.sequence == null ? null : Number(event.sequence),
      timestamp: event.timestamp || new Date().toISOString(),
      data:
        event.data && typeof event.data === 'object'
          ? { ...event.data }
          : {}
    };
  }

  append(event, { tenantId = null } = {}) {
    const normalized = this.normalize(event);
    if (tenantId && normalized.data?.tenantId && normalized.data.tenantId !== tenantId) throw Object.assign(new Error('Event tenant mismatch'), { code: 'EVENT_TENANT_MISMATCH' });
    if (tenantId && !normalized.data?.tenantId) normalized.data.tenantId = tenantId;
    return this.withLock(() => {
      const events = this.read();
      const existing = events.find(event => event.id === normalized.id);
      const effectiveTenantId = normalized.data?.tenantId || tenantId;
      if (existing && !this.belongsToTenant(existing, effectiveTenantId)) {
        throw Object.assign(new Error('Event tenant mismatch'), { code: 'EVENT_TENANT_MISMATCH' });
      }
      if (!existing) {
        events.push(normalized);
        this.write(events);
      }
      return normalized;
    });
  }

  appendMany(events, { tenantId = null } = {}) {
    if (!Array.isArray(events)) {
      throw new TypeError('events must be an array');
    }

    if (!events.length) {
      return [];
    }

    const normalized = events.map(event => {
      const item = this.normalize(event);
      if (tenantId && item.data?.tenantId && item.data.tenantId !== tenantId) throw Object.assign(new Error('Event tenant mismatch'), { code: 'EVENT_TENANT_MISMATCH' });
      if (tenantId && !item.data?.tenantId) item.data.tenantId = tenantId;
      return item;
    });

    return this.withLock(() => {
      const current = this.read();
      const existingById = new Map(current.map(event => [event.id, event]));
      const incomingById = new Map();
      const unique = [];
      for (const event of normalized) {
        const effectiveTenantId = event.data?.tenantId || tenantId;
        const existing = existingById.get(event.id) || incomingById.get(event.id);
        if (existing) {
          if (!this.belongsToTenant(existing, effectiveTenantId)) {
            throw Object.assign(new Error('Event tenant mismatch'), { code: 'EVENT_TENANT_MISMATCH' });
          }
          continue;
        }
        incomingById.set(event.id, event);
        unique.push(event);
      }
      if (unique.length) {
        current.push(...unique);
        this.write(current);
      }
      return unique;
    });
  }

  findAll({ tenantId = null } = {}) {
    return this.read().filter(event => !tenantId || event.data?.tenantId === tenantId || (tenantId === 'local' && !event.data?.tenantId));
  }

  findByExecutionId(executionId, { tenantId = null } = {}) {
    if (!executionId) return [];
    return this.findAll({ tenantId }).filter(event => event.executionId === executionId);
  }

  findByGoalId(goalId, { tenantId = null } = {}) {
    if (!goalId) return [];
    return this.findAll({ tenantId }).filter(event => event.goalId === goalId);
  }

  belongsToTenant(event, tenantId) {
    if (!tenantId) return true;
    const eventTenantId = event?.data?.tenantId || null;
    return tenantId === 'local'
      ? !eventTenantId || eventTenantId === 'local'
      : eventTenantId === tenantId;
  }

  appendMissionEvent(event, { tenantId = null, workerPrincipal = null } = {}) {
    if (workerPrincipal) {
      throw Object.assign(new Error('JSON persistence cannot verify worker sessions and lease fencing for mission-event writes'), {
        code: 'WORKER_DURABLE_FENCING_UNSUPPORTED', status: 503
      });
    }
    if (!event?.aggregateId) throw new TypeError('aggregateId is required');
    const compareTimestamp = typeof event.timestamp === 'string' && event.timestamp.length > 0;
    return this.withLock(() => {
      const current = this.read();
      const normalized = this.normalize({ ...event });
      if (tenantId && normalized.data?.tenantId && normalized.data.tenantId !== tenantId) {
        throw Object.assign(new Error('Event tenant mismatch'), { code: 'EVENT_TENANT_MISMATCH' });
      }
      if (tenantId && !normalized.data?.tenantId) normalized.data.tenantId = tenantId;
      // Event metadata is authoritative when the caller omits the tenant option.
      const effectiveTenantId = normalized.data?.tenantId || tenantId;

      const existing = current.find(item => item.id === normalized.id);
      if (existing) {
        if (!this.belongsToTenant(existing, effectiveTenantId)) {
          throw Object.assign(new Error('Event tenant mismatch'), { code: 'EVENT_TENANT_MISMATCH' });
        }
        if (existing.aggregateId !== normalized.aggregateId ||
            existing.type !== normalized.type ||
            existing.executionId !== normalized.executionId ||
            existing.goalId !== normalized.goalId ||
            (compareTimestamp && existing.timestamp !== normalized.timestamp) ||
            (normalized.sequence != null && Number(existing.sequence) !== normalized.sequence) ||
            !isDeepStrictEqual(existing.data || {}, normalized.data || {})) {
          throw Object.assign(new Error('Mission event identity conflict'), { code: 'MISSION_EVENT_ID_CONFLICT' });
        }
        return existing;
      }

      const aggregateEvents = current.filter(item =>
        item.aggregateId === normalized.aggregateId && this.belongsToTenant(item, effectiveTenantId)
      );
      const expected = aggregateEvents.length ? Math.max(...aggregateEvents.map(item => Number(item.sequence) || 0)) + 1 : 1;
      if (normalized.sequence != null && normalized.sequence !== expected) {
        const error = new Error('Mission event sequence conflict');
        error.code = 'MISSION_EVENT_SEQUENCE_CONFLICT';
        throw error;
      }
      normalized.sequence = expected;
      current.push(normalized);
      this.write(current);
      return normalized;
    });
  }

  findByAggregateId(aggregateId, { tenantId = null } = {}) {
    if (!aggregateId) return [];
    return this.findAll({ tenantId })
      .filter(event => event.aggregateId === aggregateId)
      .sort((a, b) => Number(a.sequence) - Number(b.sequence));
  }

  findByType(type, { tenantId = null } = {}) {
    if (!type) return [];
    return this.findAll({ tenantId }).filter(event => event.type === type);
  }

  count() {
    return this.read().length;
  }

  clear() {
    this.withLock(() => this.write([]));
  }
}

module.exports = EventRepository;
