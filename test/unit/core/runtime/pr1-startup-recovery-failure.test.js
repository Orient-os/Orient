'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const RuntimeInfrastructureCoordinator =
  require('../../../../src/core/runtime/runtime-infrastructure-coordinator');
const ExecutionRecoveryCoordinator =
  require('../../../../src/core/runtime/execution-recovery-coordinator');
const cleanupStartupFailure =
  require('../../../../src/core/runtime/startup-failure-cleanup');

test('startup retries after an idempotent tenant quota initialization failure before recovery', async () => {
  let quotaAttempts = 0;
  let recoveryAttempts = 0;
  const coordinator = new RuntimeInfrastructureCoordinator({
    persistence: {
      tenantQuotas: {
        async ensureTenant() {
          quotaAttempts += 1;
          if (quotaAttempts === 1) throw new Error('temporary quota store failure');
        }
      },
      workflows: { findAll() { return []; } }
    },
    tenantId: 'tenant-pr1-quota-retry',
    deferStartup: true
  });
  coordinator.workflowScheduler.recoverPersisted = () => {
    recoveryAttempts += 1;
    return 0;
  };

  await assert.rejects(coordinator.start(), /temporary quota store failure/);
  await assert.doesNotReject(coordinator.start());

  assert.equal(quotaAttempts, 2);
  assert.equal(recoveryAttempts, 1);
  assert.equal(coordinator.started, true);
  await coordinator.shutdown();
});

test('partial workflow recovery permanently rejects coordinator restart with an operator diagnostic', async () => {
  let recoveryAttempts = 0;
  const coordinator = new RuntimeInfrastructureCoordinator({
    persistence: { workflows: { findAll() { return []; } } },
    tenantId: 'tenant-pr1-partial-recovery',
    deferStartup: true
  });
  coordinator.workflowScheduler.recoverPersisted = () => {
    recoveryAttempts += 1;
    if (recoveryAttempts === 1) {
      throw Object.assign(new Error('failure after one workflow was recovered'), {
        code: 'WORKFLOW_RECOVERY_WRITE_FAILED'
      });
    }
    return 0;
  };

  const isTerminalRecoveryError = error =>
    error.code === 'PERSISTENCE_RECOVERY_PARTIAL_FAILURE' &&
    /partial/i.test(error.message) &&
    /cannot be restarted/i.test(error.message) &&
    /new Runtime/i.test(error.message) &&
    /application process must be restarted before resuming work/i.test(error.message);

  await assert.rejects(coordinator.start(), isTerminalRecoveryError);
  await assert.rejects(coordinator.start(), isTerminalRecoveryError);
  assert.equal(recoveryAttempts, 1);
  assert.equal(coordinator.started, false);
});

test('recovery classifier failure still commits the original execution failure', async () => {
  const originalError = new Error('agent step failed');
  const classifierError = Object.assign(new Error('recovery classifier unavailable'), {
    code: 'RECOVERY_CLASSIFIER_UNAVAILABLE'
  });
  const records = [];
  const checkpoints = [];
  let failedWith;
  const context = {
    isActive: () => true,
    canTransitionAgentTo: state => state === 'recovering',
    transitionAgentTo() {},
    record(type, payload) { records.push({ type, payload }); },
    fail(error) { failedWith = error; }
  };
  const coordinator = new ExecutionRecoveryCoordinator({
    agentOrchestrator: {
      async recover() { throw classifierError; }
    },
    async persistExecution() {},
    async persistEvents() {},
    async checkpoint(...args) {
      checkpoints.push(args);
      return { snapshot: { status: 'failed', cancellationRequested: false } };
    }
  });

  const result = await coordinator.fail({ context, error: originalError });

  assert.equal(failedWith, originalError);
  assert.equal(checkpoints.length, 1);
  assert.equal(records.some(item =>
    item.type === 'recovery.classification_failed' &&
    item.payload.code === 'RECOVERY_CLASSIFIER_UNAVAILABLE'
  ), true);
  assert.equal(result.action, 'abort');
  assert.equal(result.reason, 'recovery_classifier_failed');
});

test('startup failure cleanup unsubscribes observations before Runtime and persistence cleanup', async () => {
  const order = [];
  const failures = await cleanupStartupFailure({
    eventStoreSubscriber: {
      stop() { order.push('observations'); }
    },
    runtime: {
      async shutdown() { order.push('runtime'); }
    },
    persistenceRuntime: {
      async close() { order.push('persistence'); }
    }
  });

  assert.deepEqual(failures, []);
  assert.deepEqual(order, ['observations', 'runtime', 'persistence']);
});
