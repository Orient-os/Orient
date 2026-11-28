# Project Doctor workspace mutation lock recovery

## Purpose and safety rule

The workspace lock serializes every governed project mutation across independent ORIENT processes. A process crash intentionally leaves the lock in place. This prevents a second operation from writing into a workspace whose previous mutation may have stopped between file replacement, verification, rollback, and durable receipt commit.

**Never delete a lock directory manually. Never reclaim a lock because it is old. Never use PID alone as proof that its owner is dead.** A retained lock is a safety stop, not a stale cache entry.

The recovery command only quarantines a lock after it proves that the recorded owner process is no longer the same process, on the same host and boot session. It preserves the original lock metadata and records the operator decision in the quarantine directory.

## Concurrency boundary

The lock coordinates ORIENT processes that use the same private application lock directory for the canonical `project.execute_change` tool. It is not a mandatory lock for arbitrary editors or unrelated processes that write directly into the workspace. Before-image validation runs after acquiring the ORIENT lock, and rollback checks that the current bytes still match the operation after-image before restoring them. A mismatch is treated as a rollback conflict and keeps the workspace locked.

There is no portable atomic compare-and-swap for arbitrary external file writers in the current Node filesystem API. If an environment requires protection against non-cooperating external writers racing in the narrow interval between a rollback comparison and replacement, keep governed writes disabled and isolate the workspace until an OS-enforced write boundary is deployed. Do not interpret the ORIENT lock as a host-wide filesystem lock.

## Supported environment

- Linux local filesystems with `/proc`, stable boot ID, atomic same-filesystem directory creation/rename, and private application storage.
- Android Termux uses the Linux process identity interface when the runtime exposes the required `/proc` records.
- Other platforms, shared network filesystems, host changes, boot-session changes, missing/corrupt owner metadata, and unknown process state fail closed. Do not work around those checks by deleting files.

The inspection output includes bounded before-image file contents from the private intent journal. Treat terminal output and copied incident records as sensitive source/configuration data; store them only in the approved private incident location.

## Recovery procedure

1. Stop the ORIENT service or worker that can access the affected workspace. Do not kill unrelated processes.
2. Preserve a backup/snapshot of the workspace and the application data directory containing operation receipts and pending intents. Keep the original lock untouched.
3. From the ORIENT repository, inspect the lock. Use the exact configured workspace and private lock directory; in the production composition the lock directory is under the configured agent data directory at `project-operation-receipts/workspace-locks`.

   ```bash
   node scripts/recover-project-workspace-lock.js \
     --workspace "/absolute/path/to/workspace" \
     --lock-directory "/absolute/path/to/agent-data/project-operation-receipts/workspace-locks" \
     --inspect
   ```

4. Record the returned `owner.token`, `owner.pid`, `owner.hostname`, `owner.bootId`, `owner.processStartIdentity`, `owner.operationId`, and `owner.tenantId`. The command also displays the matching `pendingIntent` and any terminal `receipt`. Confirm the service is stopped. The command itself independently checks the host, boot ID, PID, and process start identity; a live or uncertain owner is not recoverable.
5. Only after confirming the affected operation and stopping its service, run the explicit recovery command. Replace the values with the exact inspected token and an accountable operator/reason:

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

6. The command atomically renames the lock directory to a unique `.quarantine.*` path and writes `recovery.json` containing the owner evidence, operator, reason, and timestamp. It does not delete the evidence. Preserve this quarantine directory with the incident record.
7. Inspect `pendingIntent.changes` and the matching `receipt`. The journal contains each affected path, its `beforeExists` flag, the bounded `beforeContent` (when it existed), and the expected after-image hash. A pending intent without a terminal receipt (`verified` or `rolled_back`) means the operation outcome is unknown; **do not replay it**. For each path, leave it alone if it already matches the recorded before-image; restore the recorded before-content (or remove a newly created file) only when the current bytes match the recorded after-image; if neither state matches, stop and resolve the external conflict without overwriting it. Preserve the journal and all evidence.
8. Run the project audit and relevant tests. Re-enable governed writes only after the workspace is consistent and the incident is documented.

## When recovery refuses

- `PROJECT_WORKSPACE_LOCK_OWNER_ACTIVE`: the recorded process is still present. Stop it normally and retry inspection; do not force recovery.
- `PROJECT_WORKSPACE_LOCK_OWNER_UNKNOWN`: host/boot identity differs or process state cannot be proven. Preserve evidence and use a controlled manual incident process on the original host; do not remove the lock.
- `PROJECT_WORKSPACE_LOCK_CORRUPT`: owner metadata is missing, malformed, unsafe, or incomplete. Preserve the lock and workspace; recovery requires manual evidence review.
- `PROJECT_WORKSPACE_LOCK_UNSUPPORTED_PLATFORM`: this platform/filesystem does not provide the required proof. Keep writes disabled until a supported recovery path is provided.

There is deliberately no TTL-based auto-unlock, no automatic PID-only cleanup, and no command that recursively deletes lock or quarantine directories.
