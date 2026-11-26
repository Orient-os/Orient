'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const AgentService = require('../../../../src/application/agent/agent.service');

function createRuntime({ execute, status = 'completed', userId = 'owner-test' } = {}) {
  const records = new Map();
  const durableExecutions = new Map();
  let executions = 0;
  let currentStatus = status;
  const idempotency = {
    async findByKey(key) {
      return records.get(key) || null;
    },
    async begin(args) {
      const existing = records.get(args.operationId);
      if (existing) return { created: false, key: args.operationId, record: existing };
      const record = {
        key: args.operationId,
        ...args,
        status: 'running',
        result: null
      };
      records.set(args.operationId, record);
      return { created: true, key: args.operationId, record };
    },
    async complete(key, result) {
      const record = records.get(key);
      assert.ok(record);
      record.status = 'completed';
      record.result = result;
      return record;
    },
    async fail(key, error) {
      const record = records.get(key);
      assert.ok(record);
      record.status = 'failed';
      record.error = error;
      return record;
    }
  };
  const runtime = {
    tenantId: 'tenant-test',
    userId,
    persistence: { idempotency },
    async execute(goal, options = {}) {
      executions += 1;
      let result;
      try {
        result = execute ? await execute(goal, options) : { execution: { executionId: options.executionId || 'execution-1' } };
      } catch (error) {
        if (error?.code === 'APPROVAL_REQUIRED' && error.executionContext?.executionId) {
          durableExecutions.set(error.executionContext.executionId, true);
        }
        throw error;
      }
      const id = result?.execution?.executionId || result?.executionId;
      if (id) durableExecutions.set(id, true);
      return result;
    },
    async getExecutionStatus(id) {
      if (!durableExecutions.has(id)) {
        throw Object.assign(new Error('Execution not found: ' + id), { code: 'EXECUTION_NOT_FOUND' });
      }
      return {
        executionId: id,
        status: currentStatus,
        currentStep: 2,
        startedAt: '2026-10-10T10:00:00.000Z',
        updatedAt: '2026-10-10T10:00:02.000Z',
        completedAt: status === 'completed' ? '2026-10-10T10:00:02.000Z' : null,
        cancellationRequested: false,
        agentLifecycle: status === 'awaiting_approval' ? 'paused' : 'completed',
        tenantId: 'tenant-test'
      };
    }
  };
  return {
    service: new AgentService(runtime),
    runtime,
    records,
    setStatus(nextStatus) { currentStatus = nextStatus; },
    get executions() { return executions; }
  };
}

test('unified task creation is durably idempotent and returns a sanitized task summary', async () => {
  const fixture = createRuntime();
  const first = await fixture.service.createTask({
    goal: '  summarize my tasks  ',
    idempotencyKey: 'request-key-0001'
  });
  const replay = await fixture.service.createTask({
    goal: 'summarize my tasks',
    idempotencyKey: 'request-key-0001'
  });

  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.task, first.task);
  assert.equal(first.task.id, fixture.records.values().next().value.executionId);
  assert.equal(first.task.status, 'completed');
  assert.equal(Object.hasOwn(first.task, 'tenantId'), false);
  assert.equal(fixture.executions, 1);
});

test('unified task creation rejects reuse of one idempotency key for a different goal', async () => {
  const fixture = createRuntime();
  await fixture.service.createTask({ goal: 'first goal', idempotencyKey: 'request-key-0002' });
  await assert.rejects(
    fixture.service.createTask({ goal: 'different goal', idempotencyKey: 'request-key-0002' }),
    error => error.code === 'IDEMPOTENCY_KEY_REUSED'
  );
  assert.equal(fixture.executions, 1);
});

test('existing reservation is not redispatched when durable execution lookup is uncertain', async () => {
  const fixture = createRuntime();
  const crypto = require('node:crypto');
  const digest = crypto.createHash('sha256').update('request-key-0003').digest('hex');
  const ownerScopeDigest = crypto.createHash('sha256')
    .update(JSON.stringify(['tenant-test', 'owner-test', digest]), 'utf8')
    .digest('hex');
  const operationId = 'api-v1-task-create:tenant-test:' + ownerScopeDigest;
  const requestDigest = crypto.createHash('sha256').update('still running').digest('hex');
  fixture.records.set(operationId, {
    key: operationId,
    executionId: 'reserved-existing-execution',
    tool: 'api.v1.tasks.create:' + requestDigest,
    status: 'running',
    result: null
  });
  fixture.runtime.getExecutionStatus = async () => {
    throw Object.assign(new Error('database temporarily unavailable'), { code: 'EXECUTION_STORAGE_UNAVAILABLE' });
  };

  await assert.rejects(
    fixture.service.createTask({ goal: 'still running', idempotencyKey: 'request-key-0003' }),
    error => error.code === 'TASK_EXECUTION_RECONCILIATION_REQUIRED'
  );
  assert.equal(fixture.executions, 0);
});

test('unified task creation requires durable idempotency storage', async () => {
  const service = new AgentService({
    tenantId: 'tenant-test',
    persistence: {},
    async execute() { assert.fail('must not execute without durable idempotency'); }
  });
  await assert.rejects(
    service.createTask({ goal: 'run safely', idempotencyKey: 'request-key-0004' }),
    error => error.code === 'TASK_IDEMPOTENCY_STORAGE_REQUIRED'
  );
});

test('ambiguous runtime failure retains the reserved execution identity for safe retry', async () => {
  const seenExecutionIds = [];
  let attempts = 0;
  const fixture = createRuntime({
    execute: async (_goal, options) => {
      attempts += 1;
      seenExecutionIds.push(options.executionId);
      if (attempts === 1) {
        throw Object.assign(new Error('runtime transport interrupted'), { code: 'RUNTIME_UNAVAILABLE' });
      }
      return { execution: { executionId: options.executionId } };
    }
  });
  await assert.rejects(
    fixture.service.createTask({ goal: 'a task', idempotencyKey: 'request-key-0005' }),
    error => error.code === 'RUNTIME_UNAVAILABLE'
  );
  const recovered = await fixture.service.createTask({ goal: 'a task', idempotencyKey: 'request-key-0005' });
  assert.equal(recovered.replayed, true);
  assert.equal(recovered.task.id, seenExecutionIds[0]);
  assert.equal(seenExecutionIds[1], seenExecutionIds[0]);
  assert.equal(fixture.executions, 2);
  assert.equal(fixture.records.values().next().value.status, 'completed');
});


test('a stale approval-required signal cannot override a terminal durable execution state', async t => {
  for (const terminalStatus of ['completed', 'failed', 'cancelled']) {
    await t.test(terminalStatus, async () => {
      let setStatus;
      const fixture = createRuntime({
        status: 'awaiting_approval',
        execute: async (_goal, options) => {
          setStatus(terminalStatus);
          throw Object.assign(new Error('Owner approval was required before the concurrent terminal transition'), {
            code: 'APPROVAL_REQUIRED',
            executionContext: { executionId: options.executionId }
          });
        }
      });
      setStatus = fixture.setStatus;

      const result = await fixture.service.createTask({
        goal: 'run a task with a concurrent approval resolution',
        idempotencyKey: 'approval-terminal-race-' + terminalStatus + '-001'
      });

      assert.equal(result.task.status, terminalStatus);
      assert.equal(result.replayed, false);
      assert.equal(fixture.executions, 1);
    });
  }
});

test('approval-required execution is accepted as a durable task and does not retry the high-risk action', async () => {
  const fixture = createRuntime({
    status: 'awaiting_approval',
    execute: async (_goal, options) => {
      throw Object.assign(new Error('Owner approval is required'), {
        code: 'APPROVAL_REQUIRED',
        executionContext: { executionId: options.executionId }
      });
    }
  });

  const first = await fixture.service.createTask({
    goal: 'inspect and propose a project change, then execute it with owner approval',
    idempotencyKey: 'request-key-approval-0001'
  });
  const replay = await fixture.service.createTask({
    goal: 'inspect and propose a project change, then execute it with owner approval',
    idempotencyKey: 'request-key-approval-0001'
  });

  assert.equal(first.task.id, fixture.records.values().next().value.executionId);
  assert.equal(first.task.status, 'awaiting_approval');
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.task, first.task);
  assert.equal(fixture.executions, 1);
});


test('task reconciliation distinguishes an authorized resume from a newer pending approval challenge', async t => {
  await t.test('an approval authorization supersedes its earlier persisted challenge', async () => {
    const fixture = createRuntime({
      status: 'running',
      execute: async (_goal, options) => {
        throw Object.assign(new Error('The original approval-required signal raced with resume'), {
          code: 'APPROVAL_REQUIRED',
          executionContext: { executionId: options.executionId }
        });
      }
    });
    fixture.runtime.getExecutionStatus = async id => ({
      executionId: id,
      status: 'running',
      currentStep: 1,
      tenantId: 'tenant-test',
      metadata: {
        planRevision: 1,
        pendingStepInputs: { 1: { tool: 'danger.write', operationId: 'operation-1' } }
      },
      events: [
        { type: 'approval.challenge.persisted', data: { step: 1, planRevision: 1, operationId: 'operation-1' } },
        { type: 'approval.resume.authorized', data: { step: 1, planRevision: 1, operationId: 'operation-1' } }
      ]
    });

    await assert.rejects(
      fixture.service.createTask({ goal: 'resume an approved task', idempotencyKey: 'approval-resume-authorized-001' }),
      error => error.code === 'TASK_EXECUTION_IN_PROGRESS'
    );
    assert.equal(fixture.executions, 1, 'a resumed active execution must not be redispatched');
  });

  await t.test('a later approval challenge remains pending after an earlier authorization', async () => {
    const fixture = createRuntime({
      status: 'running',
      execute: async (_goal, options) => {
        throw Object.assign(new Error('A new approval is required'), {
          code: 'APPROVAL_REQUIRED',
          executionContext: { executionId: options.executionId }
        });
      }
    });
    fixture.runtime.getExecutionStatus = async id => ({
      executionId: id,
      status: 'running',
      currentStep: 2,
      tenantId: 'tenant-test',
      metadata: {
        planRevision: 1,
        pendingStepInputs: {
          1: { tool: 'danger.write', operationId: 'operation-1' },
          2: { tool: 'danger.publish', operationId: 'operation-2' }
        }
      },
      events: [
        { type: 'approval.challenge.persisted', data: { step: 1, planRevision: 1, operationId: 'operation-1' } },
        { type: 'approval.resume.authorized', data: { step: 1, planRevision: 1, operationId: 'operation-1' } },
        { type: 'approval.challenge.persisted', data: { step: 2, planRevision: 1, operationId: 'operation-2' } }
      ]
    });

    const result = await fixture.service.createTask({
      goal: 'resume and request a second approval',
      idempotencyKey: 'approval-resume-next-challenge-001'
    });
    assert.equal(result.task.status, 'awaiting_approval');
  });
});

test('task idempotency keys are isolated between owners in the same tenant', async () => {
  const fixture = createRuntime();
  const first = await fixture.service.createTask({
    goal: 'same owner-independent goal',
    idempotencyKey: 'same-key-across-owners'
  });
  fixture.runtime.userId = 'different-owner';
  const second = await fixture.service.createTask({
    goal: 'same owner-independent goal',
    idempotencyKey: 'same-key-across-owners'
  });

  assert.equal(first.replayed, false);
  assert.equal(second.replayed, false);
  assert.notEqual(first.task.id, second.task.id);
  assert.equal(fixture.records.size, 2);
  assert.equal(fixture.executions, 2);
});


test('legacy tenant-only idempotency reservation fails closed instead of creating a duplicate', async () => {
  const fixture = createRuntime();
  const crypto = require('node:crypto');
  const digest = crypto.createHash('sha256').update('legacy-key-0001').digest('hex');
  const legacyOperationId = 'api-v1-task-create:tenant-test:' + digest;
  fixture.records.set(legacyOperationId, {
    key: legacyOperationId,
    executionId: 'legacy-reservation-with-unbound-runtime-id',
    tool: 'api.v1.tasks.create:' + crypto.createHash('sha256').update('legacy task').digest('hex'),
    status: 'running',
    result: null
  });

  await assert.rejects(
    fixture.service.createTask({ goal: 'legacy task', idempotencyKey: 'legacy-key-0001' }),
    error => error.code === 'TASK_LEGACY_IDEMPOTENCY_KEY_UNRESOLVED'
  );
  assert.equal(fixture.executions, 0);
});


test('active durable execution remains recoverable and is never redispatched', async () => {
  const fixture = createRuntime({ status: 'running' });
  await assert.rejects(
    fixture.service.createTask({ goal: 'long-running task', idempotencyKey: 'running-task-key-001' }),
    error => error.code === 'TASK_EXECUTION_IN_PROGRESS'
  );
  await assert.rejects(
    fixture.service.createTask({ goal: 'long-running task', idempotencyKey: 'running-task-key-001' }),
    error => error.code === 'TASK_EXECUTION_IN_PROGRESS'
  );
  assert.equal(fixture.executions, 1);
  assert.equal(fixture.records.values().next().value.status, 'running');
});

test('runtime cannot substitute a different execution ID for the reserved task identity', async () => {
  const fixture = createRuntime({
    execute: async () => ({ execution: { executionId: 'different-runtime-execution-id' } })
  });
  await assert.rejects(
    fixture.service.createTask({ goal: 'identity-bound task', idempotencyKey: 'identity-mismatch-key-001' }),
    error => error.code === 'TASK_EXECUTION_ID_MISMATCH'
  );
  assert.equal(fixture.executions, 1);
  assert.equal(fixture.records.values().next().value.status, 'running');
});
