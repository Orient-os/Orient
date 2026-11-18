const test = require('node:test');
const assert = require('node:assert/strict');

const AgentExecutionCoordinator = require('../../../../src/core/runtime/agent-execution-coordinator');
const PlanValidator = require('../../../../src/core/planning/validation/plan-validator');
const IndependentPlanExecutionGate = require('../../../../src/core/execution/independent-plan-execution-gate');

const verifier = new PlanValidator();
const gate = new IndependentPlanExecutionGate({ verifier });

function validated(plan) {
  return verifier.validate(plan);
}

function contextStub() {
  return {
    executionId: 'exec-1',
    requestId: 'req-1',
    input: 'hello',
    tenantId: 'tenant-1',
    userId: 'user-1',
    workspaceId: 'workspace-1',
    metadata: {},
    observations: [],
    record() {},
    transitionAgentTo() {},
    setPlan() {},
    getAgentLifecycle: () => 'planning'
  };
}

test('runs only the independently verified immutable plan and returns terminal state', async () => {
  const context = contextStub();
  const plan = { intent: 'test', steps: [{ tool: 'noop', input: { value: 1 } }] };
  let executedPlan;
  const coordinator = new AgentExecutionCoordinator({
    agentOrchestrator: {
      decideReplanning() {
        return { nextAction: 'complete', toJSON: () => ({ nextAction: 'complete' }) };
      }
    },
    agentLoop: {
      async run({ plan: candidate }) {
        executedPlan = candidate;
        return { stepsExecuted: 1, evaluation: { success: true }, result: { ok: true } };
      }
    },
    checkpoint: async () => {},
    planExecutionGate: gate,
    validateReplannedPlan: () => ({ valid: true, fingerprint: 'next' })
  });

  const result = await coordinator.run({
    context,
    plan,
    validation: validated(plan),
    previousFingerprint: 'initial',
    tenantId: 'tenant-1'
  });

  assert.notEqual(result.plan, plan);
  assert.equal(Object.isFrozen(executedPlan), true);
  assert.equal(Object.isFrozen(executedPlan.steps[0].input), true);
  assert.equal(result.planRevision, 1);
  assert.equal(result.replans, 0);
  assert.deepEqual(result.loopResult.result, { ok: true });
  assert.equal(result.replanningDecision.nextAction, 'complete');
});

test('re-verifies each changed plan revision before its execution', async () => {
  const context = contextStub();
  const firstPlan = { intent: 'first', steps: [{ tool: 'noop', input: { n: 1 } }] };
  const nextPlan = { intent: 'second', steps: [{ tool: 'noop', input: { n: 2 } }] };
  let decisions = 0;
  let executed = 0;
  const coordinator = new AgentExecutionCoordinator({
    agentOrchestrator: {
      decideReplanning() {
        decisions += 1;
        return {
          nextAction: decisions === 1 ? 'replan' : 'complete',
          toJSON: () => ({ nextAction: decisions === 1 ? 'replan' : 'complete' })
        };
      },
      async replan() {
        return { plan: nextPlan, validation: validated(nextPlan) };
      }
    },
    agentLoop: {
      async run() {
        executed += 1;
        return { stepsExecuted: 1, evaluation: {}, result: { executed } };
      }
    },
    checkpoint: async () => {},
    planExecutionGate: gate,
    validateReplannedPlan: (candidate, previous) => ({
      valid: candidate !== firstPlan && previous === 'initial',
      fingerprint: 'next'
    })
  });

  const result = await coordinator.run({
    context,
    plan: firstPlan,
    validation: validated(firstPlan),
    previousFingerprint: 'initial',
    tenantId: 'tenant-1'
  });

  assert.equal(result.planRevision, 2);
  assert.equal(result.replans, 1);
  assert.equal(executed, 2);
  assert.equal(decisions, 2);
});

test('persists the independent gate receipt before the execution loop starts', async () => {
  const context = contextStub();
  const order = [];
  context.record = (type, data) => order.push({ type, data });
  const plan = { intent: 'checkpoint-order', steps: [{ tool: 'noop' }] };
  const coordinator = new AgentExecutionCoordinator({
    agentOrchestrator: {
      decideReplanning() {
        return { nextAction: 'complete', toJSON: () => ({ nextAction: 'complete' }) };
      }
    },
    agentLoop: {
      async run() {
        order.push({ type: 'agent-loop.started' });
        return { stepsExecuted: 1, evaluation: {}, result: { ok: true } };
      }
    },
    checkpoint: async (_context, mode, reason) => {
      order.push({ type: 'checkpoint', mode, reason });
    },
    planExecutionGate: gate,
    validateReplannedPlan: () => ({ valid: true, fingerprint: 'next' })
  });

  await coordinator.run({
    context,
    plan,
    validation: validated(plan),
    previousFingerprint: 'initial',
    tenantId: 'tenant-1'
  });

  const approvalIndex = order.findIndex(item => item.type === 'plan.execution_gate.approved');
  const checkpointIndex = order.findIndex(item => item.type === 'checkpoint' &&
    item.reason.startsWith('plan_execution_gate_approved'));
  const loopIndex = order.findIndex(item => item.type === 'agent-loop.started');
  assert.ok(approvalIndex >= 0);
  assert.ok(checkpointIndex > approvalIndex);
  assert.ok(loopIndex > checkpointIndex);
  assert.match(order[approvalIndex].data.planSha256, /^[a-f0-9]{64}$/);
});

test('checkpoint failure after gate approval prevents all tool execution', async () => {
  const context = contextStub();
  const plan = { intent: 'checkpoint-failure', steps: [{ tool: 'noop' }] };
  let loopCalls = 0;
  const coordinator = new AgentExecutionCoordinator({
    agentOrchestrator: {},
    agentLoop: {
      async run() {
        loopCalls += 1;
        return { stepsExecuted: 1, evaluation: {}, result: null };
      }
    },
    checkpoint: async () => {
      throw Object.assign(new Error('durable store unavailable'), { code: 'CHECKPOINT_WRITE_FAILED' });
    },
    planExecutionGate: gate,
    validateReplannedPlan: () => ({ valid: true, fingerprint: 'next' })
  });

  await assert.rejects(
    () => coordinator.run({
      context,
      plan,
      validation: validated(plan),
      previousFingerprint: 'initial',
      tenantId: 'tenant-1'
    }),
    error => error.code === 'CHECKPOINT_WRITE_FAILED'
  );
  assert.equal(loopCalls, 0);
});
