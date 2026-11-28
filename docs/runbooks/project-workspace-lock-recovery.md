# Project Doctor workspace mutation lock recovery

## Purpose and safety rule

The canonical workspace mutation lock serializes governed ORIENT project writes across independent processes. A crashed owner intentionally leaves the lock in place. The lock must not be released until the interrupted operation is either proven already committed or fully restored to its before-image and a durable terminal receipt has been written and read back.

**Never delete a workspace lock manually. Never reclaim it because it is old. Never use PID alone as proof that its owner is dead.** A retained lock is a safety stop, not a stale cache entry.

The supported recovery path is the CLI below. It verifies the original owner using PID, process start identity, host boot ID, and PID namespace. It then acquires an exclusive, restartable recovery claim, reconciles the operation journal, verifies every affected path, and only then moves the lock to a unique quarantine directory.

## Concurrency boundary

The lock coordinates ORIENT processes that use the same private application lock directory for the canonical `project.execute_change` tool. It is not a mandatory lock for arbitrary editors or unrelated processes that write directly into the workspace.

For each journaled path, recovery classifies the current state:

- Current file matches the before-image (content and mode), or a created path is absent: no-op.
- Current file matches the operation after-image (content and expected mode): restore the before-image, or remove a newly created file.
- Any other state: conflict; never overwrite it.

The workspace lock cannot provide atomic compare-and-swap against arbitrary external writers in the narrow interval between a comparison and replacement. Any mismatch that is observed fails closed. Do not interpret this as a host-wide filesystem lock.

## Supported environment and journal limits

- Linux local filesystems only, with `/proc`, stable boot ID, process namespace identity, atomic same-filesystem hard-link/rename operations, and private application storage.
- Recovery must run in the same host boot and PID namespace as the recorded owner. Unknown process state fails closed.
- The intent must be version 3 and contain a complete before-image journal. Legacy version 1/2 intents are readable for historical purposes but are not restorable.
- Recovery accepts only bounded UTF-8 regular files, maximum 256 KiB per file, single-link, owned by the service UID, with no special permission bits. Symlinks, hardlinks, binary/invalid UTF-8, oversized files, and unsupported file types fail closed.
- The current journal is bounded to at most 10 changes and the receipt store enforces its own total intent/receipt size limits.

## Inspect the lock

1. Stop the ORIENT service or worker that can access the affected workspace. Do not kill unrelated processes.
2. Preserve a backup/snapshot of the workspace and the application data directory containing operation receipts and pending intents. Keep the original lock untouched.
3. Inspect the lock using the exact configured workspace and private lock directory. In the production composition, the lock directory is under the configured agent data directory at `project-operation-receipts/workspace-locks`; the receipt/intent directory is its parent.

   ```bash
   node scripts/recover-project-workspace-lock.js \
     --workspace "/absolute/path/to/workspace" \
     --lock-directory "/absolute/path/to/agent-data/project-operation-receipts/workspace-locks" \
     --inspect
   ```

4. Review `classification.state` and `classification.reason`. For a valid owner record, record the owner token, PID, hostname, boot ID, PID namespace, process start identity, operation ID, and tenant ID. The command also displays the matching pending intent and any terminal receipt. Treat before-image contents as sensitive source/configuration data; store inspection output only in the approved private incident location.
5. If owner metadata is missing or incomplete, `owner` is null, or classification is corrupt/unknown, do not attempt token-based recovery. Preserve the lock and evidence for a separately reviewed procedure.

## Execute recovery

Only after the affected operation is identified and its service is stopped, run:

```bash
node scripts/recover-project-workspace-lock.js \
  --workspace "/absolute/path/to/workspace" \
  --lock-directory "/absolute/path/to/agent-data/project-operation-receipts/workspace-locks" \
  --recover \
  --expected-token "TOKEN-FROM-INSPECT" \
  --operator "operator-id" \
  --reason "Process crash confirmed; workspace and pending operation reviewed" \
  --confirm-recovery RECOVER-WORKSPACE-LOCK
```

The CLI resolves the receipt/intent store from the parent of the supplied lock directory. The recovery protocol then:

1. Confirms the recorded owner is no longer the same process using PID + process start identity + boot ID + PID namespace. A live or uncertain owner is never reclaimed.
2. Publishes an exclusive recovery claim. If a recovery process crashes, a later invocation may advance the claim generation only after proving the previous claim owner is dead. There is no TTL-based takeover.
3. Requires the owner’s tenant-scoped, version-3 before-image intent. A missing journal, legacy intent, invalid receipt, or different staged operator decision fails closed.
4. For each path, restores only from an exact after-image match; already-restored before-images are safe no-ops. A newly created file is removed only if its content and expected mode still match the operation after-image. Every restore uses a same-directory temporary file, file fsync, atomic rename, and recovery-only parent-directory fsync. Original file modes are preserved.
5. Re-reads and verifies every before-image. It then writes a durable `rolled_back` receipt, reads it back, validates its identity and journal binding, and verifies the workspace again.
6. Only after those steps does it atomically move the canonical lock directory to a unique `.quarantine.*` path and sync the lock directory’s parent.

If a terminal receipt already exists, recovery does not reverse the operation: it verifies the corresponding after-images for a verified receipt or before-images for a rolled-back receipt, then completes lock release.

## Retry and conflict handling

- If recovery is interrupted after restoring some paths but before receipt commit, the lock remains. Re-run the same command with the same operator ID and reason. Paths already at their before-image are re-verified and synced; remaining exact after-images are restored. This is restartable and idempotent.
- If receipt commit/read-back fails, the lock remains. Re-run the same decision after checking the receipt and workspace; the command reconciles from durable state.
- If a path matches neither its before-image nor its after-image, recovery reports a conflict and keeps the lock. Do not overwrite the third state. Preserve the evidence and resolve the external change through a separately reviewed procedure; then retry using the same operator ID and reason.
- If a recovery claim is active, another recovery process is refused. If its owner has died, the next invocation proves that using process identity and creates the next claim generation.
- A successful recovery leaves the quarantined lock metadata, recovery decision, and claim chain as incident evidence. Preserve the quarantine directory with the incident record.

## When recovery refuses

- `PROJECT_WORKSPACE_LOCK_OWNER_ACTIVE`: the recorded owner process is still present. Stop it normally and retry inspection; do not force recovery.
- `PROJECT_WORKSPACE_LOCK_OWNER_UNKNOWN`: host/boot/PID namespace differs or process state cannot be proven. Preserve evidence and escalate.
- `PROJECT_WORKSPACE_LOCK_RECOVERY_IN_PROGRESS`: another recovery process owns the active claim. Do not run a second recovery concurrently.
- `PROJECT_OPERATION_INTENT_REQUIRED` or `PROJECT_OPERATION_INTENT_INCOMPLETE`: no complete version-3 before-image journal is available. The workspace cannot be automatically restored from hashes alone.
- `PROJECT_WORKSPACE_LOCK_RECOVERY_CONFLICT`: at least one path matches neither before nor after image, or a path/type/mode is unsafe. Keep the lock and do not overwrite.
- `PROJECT_OPERATION_RECEIPT_COMMIT_UNCONFIRMED`: the rollback receipt could not be read back and validated. Keep the lock.
- `PROJECT_WORKSPACE_LOCK_CORRUPT`: owner, claim, or recovery decision metadata is malformed, symlinked, or unsafe. Preserve evidence and escalate.
- `PROJECT_WORKSPACE_LOCK_UNSUPPORTED_PLATFORM` or `PROJECT_WORKSPACE_LOCK_UNSUPPORTED_FILESYSTEM`: required Linux/local-filesystem guarantees are unavailable. Keep writes disabled.

The receipt store’s per-operation write lock (`<receipt>.json.lock`) is a separate lock from this workspace mutation lock. Its policy is documented in [Project Operation Receipt Lock Recovery](../security/PROJECT-OPERATION-RECEIPT-LOCK-RECOVERY.md). Do not use the receipt-lock procedure to release a workspace mutation lock.
