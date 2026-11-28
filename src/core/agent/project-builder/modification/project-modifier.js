const crypto = require('crypto');

class ProjectModifier {
  constructor({ workspace } = {}) {
    if (!workspace) {
      throw new TypeError('workspace is required');
    }

    this.workspace = workspace;
    this.transactions = new WeakMap();
  }

  async validateChange(change) {
    if (!change || typeof change !== 'object') {
      throw new TypeError('Change must be an object');
    }

    const {
      action,
      path,
      content = ''
    } = change;

    if (action !== 'create' && action !== 'update') {
      throw new TypeError(
        'Change action must be create or update'
      );
    }

    if (
      typeof path !== 'string' ||
      !path
    ) {
      throw new TypeError(
        'Change path is required'
      );
    }

    if (typeof content !== 'string') {
      throw new TypeError(
        'Change content must be a string'
      );
    }

    const exists =
      await this.workspace.exists(path);

    if (action === 'update' && !exists) {
      throw new Error(
        `File does not exist: ${path}`
      );
    }

    if (action === 'update') {
      const expectedContentSha256 = change.expectedContentSha256;
      if (typeof expectedContentSha256 !== 'string') {
        const error = new Error(`Update change requires a before-image SHA-256 digest: ${path}`);
        error.code = 'CHANGE_PRECONDITION_REQUIRED';
        throw error;
      }
      if (!/^[a-f0-9]{64}$/i.test(expectedContentSha256)) {
        const error = new Error(`Update change has an invalid before-image SHA-256 digest: ${path}`);
        error.code = 'CHANGE_PRECONDITION_INVALID';
        throw error;
      }

      const current = await this.workspace.readText(path);
      const actualHash = crypto.createHash('sha256').update(current).digest('hex');
      if (actualHash !== expectedContentSha256.toLowerCase()) {
        const error = new Error(
          `Change precondition failed: ${path} was modified after the proposal was created`
        );
        error.code = 'CHANGE_PRECONDITION_FAILED';
        error.expectedContentSha256 = expectedContentSha256.toLowerCase();
        error.actualContentSha256 = actualHash;
        throw error;
      }
    }

    if (action === 'create' && exists) {
      throw new Error(
        `File already exists: ${path}`
      );
    }

    return {
      action,
      path,
      content,
      ...(action === 'update' ? { expectedContentSha256: change.expectedContentSha256.toLowerCase() } : {})
    };
  }

  async createFile({
    path,
    content = ''
  }) {
    await this.workspace.writeText(
      path,
      content
    );

    return {
      action: 'create',
      path,
      content
    };
  }

  async updateFile({
    path,
    content
  }) {
    await this.workspace.writeText(
      path,
      content
    );

    return {
      action: 'update',
      path,
      content
    };
  }

  async snapshot(change) {
    const exists =
      await this.workspace.exists(
        change.path
      );

    if (!exists) {
      return {
        path: change.path,
        existed: false,
        content: null
      };
    }

    const metadata = typeof this.workspace.getFileMetadata === 'function'
      ? await this.workspace.getFileMetadata(change.path)
      : { type: 'regular', mode: 0o600 };
    if (metadata.type !== 'regular' ||
        !Number.isInteger(metadata.mode) ||
        metadata.mode < 0 || metadata.mode > 0o777) {
      const error = new Error('Workspace before-image must be a regular file with a valid permission mode');
      error.code = 'PROJECT_MODIFICATION_FILE_METADATA_INVALID';
      throw error;
    }
    return {
      path: change.path,
      existed: true,
      type: metadata.type,
      mode: metadata.mode,
      content:
        await this.workspace.readText(
          change.path
        )
    };
  }

  async rollback(modification) {
    const transaction = modification && this.transactions.get(modification);
    if (!transaction) {
      const error = new Error('Rollback requires the original in-memory modification transaction');
      error.code = 'PROJECT_MODIFICATION_TRANSACTION_UNKNOWN';
      throw error;
    }
    const result = await this.rollbackTransaction(transaction);
    this.transactions.delete(modification);
    return result;
  }

  async rollbackTransaction({ snapshots, attemptedChanges }) {
    const snapshotsByPath = new Map(snapshots.map(snapshot => [snapshot.path, snapshot]));
    const rollbackErrors = [];

    for (let index = attemptedChanges.length - 1; index >= 0; index -= 1) {
      const attempted = attemptedChanges[index];
      const snapshot = snapshotsByPath.get(attempted.path);
      if (!snapshot) {
        rollbackErrors.push({
          path: attempted.path,
          code: 'PROJECT_MODIFICATION_SNAPSHOT_MISSING',
          message: 'Before-image snapshot is missing'
        });
        continue;
      }

      try {
        const exists = await this.workspace.exists(attempted.path);
        if (!exists) {
          if (!snapshot.existed) continue;
          rollbackErrors.push({
            path: attempted.path,
            code: 'WORKSPACE_ROLLBACK_CONFLICT',
            message: 'The original file disappeared before rollback'
          });
          continue;
        }

        const current = await this.workspace.readText(attempted.path);
        const currentHash = crypto.createHash('sha256').update(current).digest('hex');
        const beforeHash = snapshot.existed
          ? crypto.createHash('sha256').update(snapshot.content).digest('hex')
          : null;

        // A failed write may not have changed the target at all. Leave that
        // state untouched; only reverse a file that still has our after-image.
        if (snapshot.existed && currentHash === beforeHash) continue;
        if (currentHash !== attempted.afterSha256) {
          rollbackErrors.push({
            path: attempted.path,
            code: 'WORKSPACE_ROLLBACK_CONFLICT',
            message: 'Current file content no longer matches this operation after-image'
          });
          continue;
        }

        if (snapshot.existed) {
          await this.workspace.writeText(attempted.path, snapshot.content);
        } else {
          await this.workspace.removeFile(attempted.path);
        }
      } catch (error) {
        rollbackErrors.push({
          path: attempted.path,
          code: error.code || 'WORKSPACE_ROLLBACK_FAILED',
          name: error.name,
          message: error.message
        });
      }
    }

    const reportedPaths = new Set(rollbackErrors.map(item => item.path));
    for (const snapshot of snapshots) {
      if (reportedPaths.has(snapshot.path)) continue;
      try {
        const exists = await this.workspace.exists(snapshot.path);
        if (!snapshot.existed) {
          if (exists) {
            rollbackErrors.push({
              path: snapshot.path,
              code: 'WORKSPACE_ROLLBACK_CONFLICT',
              message: 'A file exists where the recorded before-state was absent'
            });
          }
          continue;
        }
        if (!exists) {
          rollbackErrors.push({
            path: snapshot.path,
            code: 'WORKSPACE_ROLLBACK_CONFLICT',
            message: 'A file is missing where the recorded before-state existed'
          });
          continue;
        }
        const current = await this.workspace.readText(snapshot.path);
        const currentHash = crypto.createHash('sha256').update(current).digest('hex');
        const beforeHash = crypto.createHash('sha256').update(snapshot.content).digest('hex');
        if (currentHash !== beforeHash) {
          rollbackErrors.push({
            path: snapshot.path,
            code: 'WORKSPACE_ROLLBACK_CONFLICT',
            message: 'Workspace did not return to the complete recorded before-state'
          });
        }
      } catch (error) {
        rollbackErrors.push({
          path: snapshot.path,
          code: error.code || 'WORKSPACE_ROLLBACK_FAILED',
          name: error.name,
          message: error.message
        });
      }
    }

    if (rollbackErrors.length > 0) {
      const error = new Error('Rollback failed');
      error.code = 'PROJECT_MODIFICATION_ROLLBACK_FAILED';
      error.rollbackErrors = rollbackErrors;
      throw error;
    }

    return {
      rolledBack: true,
      restored: snapshots.map(snapshot => ({
        path: snapshot.path,
        existed: snapshot.existed,
        contentSha256: snapshot.existed
          ? crypto.createHash('sha256').update(snapshot.content).digest('hex')
          : null
      }))
    };
  }

  async assertSnapshotUnchanged(change, snapshot) {
    const exists = await this.workspace.exists(change.path);
    if (change.action === 'create') {
      if (exists) {
        const error = new Error(`Create precondition changed before write: ${change.path}`);
        error.code = 'CHANGE_PRECONDITION_FAILED';
        throw error;
      }
      return;
    }

    if (!exists) {
      const error = new Error(`Update target disappeared before write: ${change.path}`);
      error.code = 'CHANGE_PRECONDITION_FAILED';
      throw error;
    }
    const current = await this.workspace.readText(change.path);
    const currentHash = crypto.createHash('sha256').update(current).digest('hex');
    const snapshotHash = crypto.createHash('sha256').update(snapshot.content).digest('hex');
    if (currentHash !== snapshotHash) {
      const error = new Error(`Update target changed after before-image capture: ${change.path}`);
      error.code = 'CHANGE_PRECONDITION_FAILED';
      error.expectedContentSha256 = snapshotHash;
      error.actualContentSha256 = currentHash;
      throw error;
    }
  }

  async apply(changeSet, { beforeMutation = null } = {}) {
    if (
      !changeSet ||
      !Array.isArray(changeSet.changes)
    ) {
      throw new TypeError(
        'changeSet with changes is required'
      );
    }

    const validatedChanges = [];

    for (const change of changeSet.changes) {
      validatedChanges.push(await this.validateChange(change));
    }

    const paths = new Set();
    for (const change of validatedChanges) {
      if (paths.has(change.path)) {
        throw new Error(`Duplicate change path: ${change.path}`);
      }
      paths.add(change.path);
    }

    const snapshots = [];
    for (const change of validatedChanges) {
      snapshots.push(await this.snapshot(change));
    }

    // The snapshot is the durable recovery before-image. Recheck the proposal
    // digest against those exact bytes so a writer racing validation cannot
    // make the journal describe a different pre-mutation state.
    for (let index = 0; index < validatedChanges.length; index += 1) {
      const change = validatedChanges[index];
      const snapshot = snapshots[index];
      if (change.action === 'update') {
        const snapshotHash = snapshot.existed
          ? crypto.createHash('sha256').update(snapshot.content).digest('hex')
          : null;
        if (snapshotHash !== change.expectedContentSha256) {
          const error = new Error(`Change precondition failed while capturing before-image: ${change.path}`);
          error.code = 'CHANGE_PRECONDITION_FAILED';
          error.expectedContentSha256 = change.expectedContentSha256;
          error.actualContentSha256 = snapshotHash;
          throw error;
        }
      } else if (snapshot.existed) {
        const error = new Error(`Create precondition failed while capturing before-image: ${change.path}`);
        error.code = 'CHANGE_PRECONDITION_FAILED';
        throw error;
      }
      await this.assertSnapshotUnchanged(change, snapshot);
    }

    if (beforeMutation !== null && typeof beforeMutation !== 'function') {
      throw new TypeError('beforeMutation must be a function when provided');
    }
    if (beforeMutation) await beforeMutation({ snapshots, changes: validatedChanges });

    const results = [];
    const attemptedChanges = [];
    try {
      for (let index = 0; index < validatedChanges.length; index += 1) {
        const change = validatedChanges[index];
        await this.assertSnapshotUnchanged(change, snapshots[index]);
        attemptedChanges.push({
          path: change.path,
          afterSha256: crypto.createHash('sha256').update(change.content).digest('hex')
        });
        if (change.action === 'create') {
          results.push(await this.createFile(change));
        } else {
          results.push(await this.updateFile(change));
        }
      }
    } catch (error) {
      if (attemptedChanges.length > 0) {
        try {
          error.rollback = await this.rollbackTransaction({ snapshots, attemptedChanges });
        } catch (rollbackError) {
          const combinedError = new Error(
            `Modification failed and rollback failed: ${error.message}`
          );
          combinedError.code = 'PROJECT_MODIFICATION_ROLLBACK_FAILED';
          combinedError.cause = error;
          combinedError.rollbackError = rollbackError;
          throw combinedError;
        }
      }
      throw error;
    }

    const modification = {
      applied: true,
      rolledBack: false,
      changes: results
    };
    this.transactions.set(modification, { snapshots, attemptedChanges });
    return modification;
  }
}

module.exports = ProjectModifier;
