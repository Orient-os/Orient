const test = require('node:test');
const assert = require('node:assert/strict');

const AgentExecutionCoordinator = require('../../../../src/core/runtime/agent-execution-coordinator');
const PlanValidator = require('../../../../src/core/planning/validation/plan-validator');
const IndependentPlanExecutionGate = require('../../../../src/core/execution/independent-plan-execution-gate');

const validator = new PlanValidator();
const gate = new IndependentPlanExecutionGate({ verifier: validator });
function createContext(requestId, lifecycle, transitions = []) {
  return {
    executionId: 'exec-' + requestId,
    requestId,
    input: 'resume',
    tenantId: 'tenant-1',
    userId: 'user-1',
    workspaceId: 'workspace-1',
    metadata: {},
    observations: [],
    getAgentLifecycle: () => lifecycle,
    record() {},
    transitionAgentTo(state) { transitions.push(state); },
    setPlan() {}
  };
}

test('does not repeat the executing lifecycle transition during resume', async () => {
  const transitions = [];
  const context = createContext('resume-1', 'executing', transitions);
  const plan = { intent: 'resume', steps: [{ tool: 'noop' }] };
  const coordinator = new AgentExecutionCoordinator({
    agentOrchestrator: {
      decideReplanning() {
        return { nextAction: 'complete', toJSON: () => ({ nextAction: 'complete' }) };
      }
    },
    agentLoop: {
      async run() {
        return { stepsExecuted: 1, evaluation: {}, result: { resumed: true } };
      }
    },
    checkpoint: async () => {},
    planExecutionGate: gate,
    validateReplannedPlan: () => ({ valid: true, fingerprint: 'next' })
  });

  const result = await coordinator.run({
    context,
    plan,
    validation: validator.validate(plan),
    previousFingerprint: 'initial',
    tenantId: 'tenant-1',
    resumed: true
  });

  assert.equal(result.loopResult.result.resumed, true);
  assert.ok(!transitions.includes('executing'));
  assert.deepEqual(transitions, ['observing', 'evaluating']);
});

test('renews a durable resume lease before persisting each resume checkpoint', async () => {
  const order = [];
  const context = createContext('resume-renew-1', 'executing');
  const plan = { intent: 'resume', steps: [{ tool: 'noop' }] };
  const coordinator = new AgentExecutionCoordinator({
    agentOrchestrator: {
      decideReplanning() {
        return { nextAction: 'complete', toJSON: () => ({ nextAction: 'complete' }) };
      }
    },
    agentLoop: {
      async run({ runtimeContext }) {
        await runtimeContext.onCheckpoint({ step: 1, planRevision: 1 });
        return { stepsExecuted: 1, evaluation: {}, result: { resumed: true } };
      }
    },
    checkpoint: async () => { order.push('checkpoint'); },
    planExecutionGate: gate,
    validateReplannedPlan: () => ({ valid: true, fingerprint: 'next' })
  });

  await coordinator.run({
    context,
    plan,
    validation: validator.validate(plan),
    previousFingerprint: 'initial',
    tenantId: 'tenant-1',
    resumed: true,
    renewResumeLease: async () => { order.push('renew'); }
  });

  assert.deepEqual(order, ['checkpoint', 'renew', 'checkpoint']);
});
