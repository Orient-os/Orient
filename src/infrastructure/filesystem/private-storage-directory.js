'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ANDROID_SYSTEM_WRITABLE_ANCESTORS = new Set([
  '/data',
  '/data/user/0'
]);

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function androidSystemAncestorAllowed(candidate, stats) {
  if (process.platform !== 'android' ||
      !ANDROID_SYSTEM_WRITABLE_ANCESTORS.has(candidate) ||
      typeof process.getgid !== 'function' ||
      typeof process.getgroups !== 'function') return false;

  const groups = new Set([process.getgid(), ...process.getgroups()]);
  const mode = stats.mode & 0o7777n;
  return stats.uid === 1000n &&
    stats.gid === 1000n &&
    (mode & 0o0020n) !== 0n &&
    (mode & 0o0002n) === 0n &&
    (mode & 0o1000n) === 0n &&
    !groups.has(1000);
}

function androidAppFilesAncestorAllowed(candidate, stats) {
  if (process.platform !== 'android' ||
      path.basename(candidate) !== 'files' ||
      typeof process.getuid !== 'function' ||
      typeof process.getgid !== 'function') return false;

  const appRoot = path.dirname(candidate);
  if (!['/data/data', '/data/user/0'].includes(path.dirname(appRoot))) return false;

  let parent;
  try { parent = fs.lstatSync(appRoot, { bigint: true }); } catch { return false; }
  const uid = BigInt(process.getuid());
  const gid = BigInt(process.getgid());
  return uid === gid &&
    stats.uid === uid && stats.gid === gid &&
    (stats.mode & 0o7777n) === 0o0771n &&
    parent.isDirectory() &&
    parent.uid === uid && parent.gid === gid &&
    (parent.mode & 0o7777n) === 0o0700n;
}

function ensurePrivateStorageDirectory(directory, {
  mode = 0o700,
  repairPermissions = false,
  errorPrefix = 'EVENT_STORAGE'
} = {}) {
  if (typeof directory !== 'string' || !directory.trim()) {
    throw new TypeError('directory is required');
  }

  const requested = path.resolve(directory);
  if (requested === path.parse(requested).root) {
    fail(errorPrefix + '_DIRECTORY_INVALID', 'Filesystem root cannot be application storage');
  }

  // A configured storage leaf must never be a symlink, even if its target is trusted.
  try {
    const leaf = fs.lstatSync(requested, { bigint: true });
    if (leaf.isSymbolicLink() || !leaf.isDirectory()) {
      fail(errorPrefix + '_DIRECTORY_INVALID', 'Storage leaf must be a real directory');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  // Resolve the nearest existing ancestor first. Descendants are created only
  // after the complete canonical ancestor chain has passed the trust checks.
  let existing = requested;
  const missing = [];
  while (true) {
    try {
      const stats = fs.lstatSync(existing, { bigint: true });
      if (!stats.isDirectory() && !stats.isSymbolicLink()) {
        fail(errorPrefix + '_PARENT_UNTRUSTED', 'Storage ancestor is not a directory');
      }
      const canonical = fs.realpathSync(existing);
      if (!fs.statSync(canonical, { bigint: true }).isDirectory()) {
        fail(errorPrefix + '_PARENT_UNTRUSTED', 'Canonical storage ancestor is not a directory');
      }
      existing = canonical;
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      missing.unshift(path.basename(existing));
      existing = parent;
    }
  }

  const posix = process.platform !== 'win32' && typeof process.getuid === 'function';
  const serviceUid = posix ? BigInt(process.getuid()) : null;
  const root = path.parse(existing).root;
  const components = existing.slice(root.length).split(path.sep).filter(Boolean);
  let current = root;

  const validateAncestor = candidate => {
    const stats = fs.lstatSync(candidate, { bigint: true });
    if (!stats.isDirectory() || stats.isSymbolicLink() ||
        fs.realpathSync(candidate) !== candidate) {
      fail(errorPrefix + '_PARENT_UNTRUSTED', 'Storage ancestor is not canonical');
    }
    if (!posix) return;

    if (stats.uid !== 0n && stats.uid !== serviceUid &&
        !(process.platform === 'android' && stats.uid === 1000n)) {
      fail(errorPrefix + '_PARENT_UNTRUSTED', 'Storage ancestor has an untrusted owner');
    }

    const permissions = stats.mode & 0o7777n;
    if ((permissions & 0o022n) !== 0n && (permissions & 0o1000n) === 0n &&
        !androidSystemAncestorAllowed(candidate, stats) &&
        !androidAppFilesAncestorAllowed(candidate, stats)) {
      fail(errorPrefix + '_PARENT_UNTRUSTED', 'Storage ancestor is writable by group or other users');
    }
  };

  validateAncestor(current);
  for (const component of components) {
    current = path.join(current, component);
    const isTarget = missing.length === 0 && current === existing;
    if (isTarget) break;
    validateAncestor(current);
  }

  if (missing.length === 0) {
    const target = fs.lstatSync(existing, { bigint: true });
    if (!target.isDirectory() || target.isSymbolicLink() || target.uid !== serviceUid) {
      fail(errorPrefix + '_DIRECTORY_OWNER_INVALID', 'Storage directory must be owned by the application user');
    }
    if ((target.mode & 0o7777n) !== BigInt(mode)) {
      if (!repairPermissions) {
        fail(errorPrefix + '_DIRECTORY_PERMISSIONS_INVALID', 'Storage directory permissions are not private');
      }
      fs.chmodSync(existing, mode);
      const repaired = fs.lstatSync(existing, { bigint: true });
      if (repaired.uid !== serviceUid || (repaired.mode & 0o7777n) !== BigInt(mode)) {
        fail(errorPrefix + '_DIRECTORY_PERMISSIONS_INVALID', 'Storage directory permissions could not be secured');
      }
    }
    return existing;
  }

  for (let index = 0; index < missing.length; index += 1) {
    const next = path.join(current, missing[index]);
    try { fs.mkdirSync(next, { mode }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }

    const stats = fs.lstatSync(next, { bigint: true });
    if (!stats.isDirectory() || stats.isSymbolicLink() || fs.realpathSync(next) !== next) {
      fail(errorPrefix + '_DIRECTORY_INVALID', 'Created storage path is not a canonical directory');
    }
    if (posix && stats.uid !== serviceUid) {
      fail(errorPrefix + '_DIRECTORY_OWNER_INVALID', 'Created storage directory has an unexpected owner');
    }
    if (index === missing.length - 1 && posix && (stats.mode & 0o7777n) !== BigInt(mode)) {
      if (!repairPermissions) fail(errorPrefix + '_DIRECTORY_PERMISSIONS_INVALID', 'Storage directory permissions are not private');
      fs.chmodSync(next, mode);
      if ((fs.lstatSync(next, { bigint: true }).mode & 0o7777n) !== BigInt(mode)) {
        fail(errorPrefix + '_DIRECTORY_PERMISSIONS_INVALID', 'Storage directory permissions could not be secured');
      }
    }
    current = next;
  }
  return current;
}

module.exports = ensurePrivateStorageDirectory;
