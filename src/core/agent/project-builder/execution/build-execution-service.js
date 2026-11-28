const BuildExecutionResult =
  require('./build-execution-result');

class BuildExecutionService {
  constructor({
    modifier,
    verifier
  } = {}) {
    if (!modifier) {
      throw new TypeError('modifier is required');
    }

    if (!verifier) {
      throw new TypeError('verifier is required');
    }

    this.modifier = modifier;
    this.verifier = verifier;
  }

  async execute({
    plan = null,
    changeSet,
    definitionOfDone,
    checks = [],
    beforeMutation = null
  } = {}) {
    if (
      !changeSet ||
      !Array.isArray(changeSet.changes)
    ) {
      throw new TypeError(
        'changeSet with changes is required'
      );
    }

    let modification;
    let snapshots = [];
    const supportsRollback =
      typeof this.modifier.rollback === 'function';
    const usesTransactionRollback =
      typeof this.modifier.rollbackTransaction === 'function';

    try {
      // ProjectModifier owns the before-images and binds them to the exact
      // applied after-images. Do not take a second, potentially inconsistent
      // snapshot in the execution service.
      if (supportsRollback && !usesTransactionRollback &&
          typeof this.modifier.snapshot === 'function') {
        for (const change of changeSet.changes) {
          snapshots.push(await this.modifier.snapshot(change));
        }
      }

      if (beforeMutation !== null && typeof beforeMutation !== 'function') {
        throw new TypeError('beforeMutation must be a function when provided');
      }
      if (beforeMutation && !usesTransactionRollback) await beforeMutation();
      modification = usesTransactionRollback
        ? await this.modifier.apply(changeSet, { beforeMutation })
        : await this.modifier.apply(changeSet);

      let verification;
      try {
        verification = await this.verifier.verify({
          definitionOfDone,
          checks
        });
      } catch (verificationError) {
        if (!supportsRollback) {
          return new BuildExecutionResult({
            status: 'failed',
            plan,
            changeSet,
            modification,
            error: {
              name: verificationError.name,
              code: verificationError.code,
              message: verificationError.message
            }
          });
        }
        try {
          const rollback = usesTransactionRollback
            ? await this.modifier.rollback(modification)
            : await this.modifier.rollback(snapshots);
          return new BuildExecutionResult({
            status: 'failed',
            plan,
            changeSet,
            modification,
            error: {
              name: verificationError.name,
              code: verificationError.code,
              message: verificationError.message
            },
            rollback
          });
        } catch (rollbackError) {
          return new BuildExecutionResult({
            status: 'rollback-failed',
            plan,
            changeSet,
            modification,
            error: {
              name: rollbackError.name,
              code: rollbackError.code,
              message: rollbackError.message,
              verificationError: verificationError.message
            },
            rollback: {
              rolledBack: false,
              rollbackErrors: rollbackError.rollbackErrors || []
            }
          });
        }
      }

      const verificationPassed =
        verification?.status === 'passed' &&
        verification?.failed === 0;

      if (!verificationPassed) {
        if (!supportsRollback) {
          return new BuildExecutionResult({
            status: 'failed',
            plan,
            changeSet,
            modification,
            verification
          });
        }

        try {
          const rollback = usesTransactionRollback
            ? await this.modifier.rollback(modification)
            : await this.modifier.rollback(snapshots);

          return new BuildExecutionResult({
            status: 'failed',
            plan,
            changeSet,
            modification,
            verification,
            rollback
          });
        } catch (rollbackError) {
          return new BuildExecutionResult({
            status: 'rollback-failed',
            plan,
            changeSet,
            modification,
            verification,
            error: {
              name: rollbackError.name,
              code: rollbackError.code,
              message: rollbackError.message
            },
            rollback: {
              rolledBack: false,
              rollbackErrors: rollbackError.rollbackErrors ||
                rollbackError.rollbackError?.rollbackErrors || []
            }
          });
        }
      }

      return new BuildExecutionResult({
        status: 'verified',
        plan,
        changeSet,
        modification,
        verification
      });
    } catch (error) {
      if (typeof error.code === 'string' && error.code.startsWith('PROJECT_OPERATION_')) throw error;
      const rollbackFailed =
        error.code === 'PROJECT_MODIFICATION_ROLLBACK_FAILED';
      return new BuildExecutionResult({
        status: rollbackFailed ? 'rollback-failed' : 'failed',
        plan,
        changeSet,
        error: {
          name: error.name,
          code: error.code,
          message: error.message
        },
        ...(rollbackFailed ? {
          rollback: {
            rolledBack: false,
            rollbackErrors: error.rollbackError?.rollbackErrors || []
          }
        } : error.rollback ? { rollback: error.rollback } : {})
      });
    }
  }
}

module.exports = BuildExecutionService;
