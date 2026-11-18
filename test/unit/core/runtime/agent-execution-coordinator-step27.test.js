const test = require('node:test');
const assert = require('node:assert/strict');

const AgentExecutionCoordinator = require('../../../../src/core/runtime/agent-execution-coordinator');
const PlanValidator = require('../../../../src/core/planning/validation/plan-validator');
const IndependentPlanExecutionGate = require('../../../../src/core/execution/independent-plan-execution-gate');

function createCoordinator() {
  let loopCalls = 0;
  const records = [];
  const gate = new IndependentPlanExecutionGate({ verifier: new PlanValidator() });
  const coordinator = new AgentExecutionCoordinator({
    agentOrchestrator: {},
    agentLoop: { run: async () => { loopCalls += 1; return { result: null, evaluation: { outcome: 'done' }, stepsExecuted: 0 }; } },
    checkpoint: async () => {},
    planExecutionGate: gate,
    validateReplannedPlan: () => ({ valid: true, fingerprint: 'next' })
  });
  return { coordinator, records, get loopCalls() { return loopCalls; } };
}

function context(records, lifecycle = 'planning') {
  return {
    executionId: 'exec-1',
    requestId: 'req-1',
    input: 'test',
    tenantId: 'tenant-1',
    userId: 'user-1',
    workspaceId: 'workspace-1',
    metadata: {},
    record: (type, data) => records.push({ type, data }),
    transitionAgentTo: () => {},
    getAgentLifecycle: () => lifecycle,
    setPlan: () => {}
  };
}

test('rejects an invalid plan before the execution loop can run', async () => {
  const harness = createCoordinator();
  await assert.rejects(
    harness.coordinator.run({
      context: context(harness.records),
      plan: { intent: 'test', steps: [] },
      validation: { valid: false, steps: [] }
    }),
    error => error.code === 'INVALID_PLAN_VALIDATION'
  );
  assert.equal(harness.loopCalls, 0);
  assert.equal(harness.records.at(-1).type, 'plan.validation.rejected');
});

test('rejects an invalid resumed plan before the execution loop can run', async () => {
  const harness = createCoordinator();
  await assert.rejects(
    harness.coordinator.run({
      context: context(harness.records, 'executing'),
      plan: { intent: 'test', steps: [] },
      validation: { valid: false, steps: [] },
      resumed: true
    }),
    error => error.code === 'INVALID_RESUME_PLAN'
  );
  assert.equal(harness.loopCalls, 0);
  assert.equal(harness.records.at(-1).data.resumed, true);
});
