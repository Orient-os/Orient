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

    return {
      path: change.path,
      existed: true,
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

    if (rollbackErrors.length > 0) {
      const error = new Error('Rollback failed');
      error.code = 'PROJECT_MODIFICATION_ROLLBACK_FAILED';
      error.rollbackErrors = rollbackErrors;
      throw error;
    }

    return {
      rolledBack: true,
      restored: attemptedChanges.map(attempted => {
        const snapshot = snapshotsByPath.get(attempted.path);
        return {
          path: attempted.path,
          existed: snapshot.existed,
          contentSha256: snapshot.existed
            ? crypto.createHash('sha256').update(snapshot.content).digest('hex')
            : null
        };
      })
    };
  }

  async apply(changeSet) {
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

    const results = [];
    const attemptedChanges = [];
    try {
      for (const change of validatedChanges) {
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
