'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const OrientRuntime = require('../../../../src/core/runtime/orient-runtime');

function createRuntime({ deferPersistenceStartup = true, workflowScheduler = null } = {}) {
  return new OrientRuntime({
    toolRegistry: {
      has: () => false,
      get: () => null
    },
    agentOrchestrator: {
      recover: async error => { throw error; }
    },
    deferPersistenceStartup,
    workflowScheduler
  });
}

test('runtime exposes the single-use lifecycle state transitions', async () => {
  const scheduler = { shutdown: async () => ({ stopped: true }) };
  const runtime = createRuntime({ workflowScheduler: scheduler });

  assert.equal(runtime.state, 'CREATED');
  await runtime.start();
  assert.equal(runtime.state, 'READY');
  await runtime.shutdown();
  assert.equal(runtime.state, 'STOPPED');

  await assert.rejects(
    runtime.start(),
    error => error.code === 'RUNTIME_STOPPED'
  );
});

test('execute, executeWorkflow, and resume reject before READY without delegation', async () => {
  const runtime = createRuntime();
  let executeCalls = 0;
  let workflowCalls = 0;
  let resumeCalls = 0;

  runtime.requestExecutionCoordinator.execute = async () => {
    executeCalls += 1;
    return { accepted: true };
  };
  runtime.workflowExecutionCoordinator.execute = async () => {
    workflowCalls += 1;
    return { accepted: true };
  };
  runtime.requestExecutionCoordinator.resume = async () => {
    resumeCalls += 1;
    return { accepted: true };
  };

  for (const operation of [
    () => runtime.execute({ goal: 'must not run' }),
    () => runtime.executeWorkflow({ goal: 'must not run' }),
    () => runtime.resume('execution-not-ready')
  ]) {
    await assert.rejects(operation, error => error.code === 'RUNTIME_NOT_READY');
  }

  assert.deepEqual(
    { executeCalls, workflowCalls, resumeCalls },
    { executeCalls: 0, workflowCalls: 0, resumeCalls: 0 }
  );
});

test('runtime rejects new execution while shutdown is in progress', async () => {
  let releaseShutdown;
  const scheduler = {
    shutdown: () => new Promise(resolve => { releaseShutdown = resolve; })
  };
  const runtime = createRuntime({ workflowScheduler: scheduler });
  await runtime.start();

  let executeCalls = 0;
  runtime.requestExecutionCoordinator.execute = async () => {
    executeCalls += 1;
    return { accepted: true };
  };

  const stopping = runtime.shutdown();
  await assert.rejects(
    runtime.execute({ goal: 'must not enter during shutdown' }),
    error => error.code === 'RUNTIME_NOT_READY'
  );
  assert.equal(executeCalls, 0);

  releaseShutdown({ stopped: true });
  await stopping;
  assert.equal(runtime.state, 'STOPPED');
});

test('safe startup failure is retryable and transitions to READY after a successful retry', async () => {
  const runtime = createRuntime();
  let attempts = 0;
  runtime.infrastructureCoordinator.start = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('quota initialization failed before recovery');
    return { started: true, recovered: 0 };
  };

  await assert.rejects(runtime.start(), /quota initialization failed/);
  assert.equal(runtime.state, 'FAILED_RETRYABLE');

  await runtime.start();
  assert.equal(runtime.state, 'READY');
  assert.equal(attempts, 2);
});

test('partial persistence recovery failure is terminal and maps to FAILED_TERMINAL', async () => {
  const runtime = createRuntime();
  const failure = Object.assign(new Error('partial workflow recovery'), {
    code: 'PERSISTENCE_RECOVERY_PARTIAL_FAILURE',
    retryable: false
  });
  runtime.infrastructureCoordinator.start = async () => { throw failure; };

  await assert.rejects(runtime.start(), error => error === failure);
  assert.equal(runtime.state, 'FAILED_TERMINAL');

  await assert.rejects(
    runtime.start(),
    error => error.code === 'PERSISTENCE_RECOVERY_PARTIAL_FAILURE'
  );
});
