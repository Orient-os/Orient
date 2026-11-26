# JSON EventRepository Filesystem Security Boundary

## Supported deployment model

The JSON EventRepository is a local-development and single-host persistence adapter. It is not the production multi-instance persistence backend and must not be placed on a network/shared filesystem. Production deployments requiring concurrent instances must use the PostgreSQL persistence adapter.

The adapter validates the complete existing canonical ancestor chain before creating or using its data directory (including platform aliases such as Android `/data/data`). The resulting directory must be a real canonical directory owned by the ORIENT service user with POSIX mode `0700`. Every ancestor must have a trusted owner and must not be group/world writable unless a trusted sticky-directory policy protects directory entries (for example, a private child under `/tmp`). The adapter fails closed when these assumptions cannot be established.

Safe event-file reads require Node.js `O_NOFOLLOW`, a regular-file descriptor, exactly one hard link, service-user ownership, POSIX mode `0600`, and a bounded read (64 MiB). The same descriptor-based checks run during initialization and every read. Writes serialize and size-check the complete payload before creating a temporary file, fsync the temporary file, atomically rename it, and fsync the containing directory. A directory-fsync failure after rename is reported as a durability-uncertain outcome; the committed event remains readable and event-id idempotency permits a safe retry. Standard Windows Node.js builds without `O_NOFOLLOW` are unsupported by this JSON adapter until a reparse-point-safe implementation is provided. Do not replace this with an `lstat`-then-open fallback.

## Lock lifecycle

Writers acquire an atomic directory lock and create a per-acquisition random owner marker inside it. The marker path is the cleanup capability. Release removes only that exact marker and then uses non-recursive `rmdir`.

Stale, malformed, and legacy locks are never reclaimed automatically. Lock timeout is fail-closed: leave the existing lock untouched and require operator recovery. This avoids check-then-rename races and accidental deletion of a successor's lock.

## Operator recovery

1. Stop every ORIENT process that can write to the JSON data directory.
2. Confirm the data directory is local, private, canonical, owned by the service user, and not shared across hosts.
3. Inspect the lock directory and its contents without following symlinks. Unexpected, missing, malformed, or duplicate owner markers require escalation.
4. Confirm no process can still be using the lock. Do not infer staleness from age alone.
5. Remove only the exact owner marker after independent verification, then use non-recursive directory removal. Never use recursive deletion.
6. Restart ORIENT and verify event history and execution recovery before allowing further writes.

A stale lock is an availability issue, not permission to risk cross-process corruption. If ownership cannot be established, leave it in place and escalate.


## Verification coverage

The focused security suite covers hard-link rejection, permissive file-mode rejection, validation of writable grandparent directories before storage creation, directory fsync after atomic replacement, and recovery after an fsync failure that occurs after rename. Run:

```sh
node --test test/unit/infrastructure/persistence/json/event-repository.security.test.js
node --test test/unit/infrastructure/event-repository-hardening.test.js test/unit/infrastructure/event-repository.test.js test/unit/infrastructure/event-repository-concurrency.test.js
```

The complete repository test suite and required CI checks remain release gates; focused tests alone do not authorize enabling production workers or merging this change.
