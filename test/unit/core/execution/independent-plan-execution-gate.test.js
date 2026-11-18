'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const PlanValidator = require('../../../../src/core/planning/validation/plan-validator');
const IndependentPlanExecutionGate = require('../../../../src/core/execution/independent-plan-execution-gate');
const { canonicalJson } = require('../../../../src/core/execution/evidence-record');

function createGate(options = {}) {
  return new IndependentPlanExecutionGate({
    verifier: new PlanValidator(),
    clock: () => new Date('2026-11-18T16:00:00.000Z'),
    ...options
  });
}

function request(plan = { intent: 'test', steps: [{ tool: 'noop', input: { value: 1 } }] }) {
  return {
    plan,
    validation: new PlanValidator().validate(plan),
    executionId: 'exec-1',
    tenantId: 'tenant-1',
    userId: 'user-1',
    workspaceId: 'workspace-1',
    agentId: 'ORIENT_RUNTIME',
    planRevision: 1
  };
}

test('independently revalidates, binds receipt to execution identity and plan digest', () => {
  const result = createGate().verify(request());
  assert.equal(result.receipt.decision, 'allow');
  assert.equal(result.receipt.verification, 'independent_revalidation');
  assert.equal(result.receipt.identity.executionId, 'exec-1');
  assert.match(result.receipt.planSha256, /^[a-f0-9]{64}$/);
  assert.equal(result.receipt.verifiedAt, '2026-11-18T16:00:00.000Z');
  const { receiptSha256, ...body } = result.receipt;
  const expected = crypto.createHash('sha256').update(canonicalJson(body)).digest('hex');
  assert.equal(receiptSha256, expected);
});

test('does not trust planner validation when independent normalized steps differ', () => {
  const input = request();
  input.validation = { valid: true, steps: [{ step: 1, tool: 'different', input: null, dependsOn: null }] };
  assert.throws(() => createGate().verify(input), error => error.code === 'PLAN_GATE_VALIDATION_DIVERGENCE');
});

test('rejects missing execution ownership identity', () => {
  const input = request();
  input.tenantId = '';
  assert.throws(() => createGate().verify(input), error => error.code === 'PLAN_GATE_IDENTITY_REQUIRED');
});

test('rejects invalid upstream validation even when the plan itself is valid', () => {
  const input = request();
  input.validation = { valid: false, steps: [] };
  assert.throws(() => createGate().verify(input), error => error.code === 'PLAN_GATE_UPSTREAM_VALIDATION_INVALID');
});

test('passes only a deeply frozen normalized plan to execution', () => {
  const input = request();
  const result = createGate().verify(input);
  assert.notEqual(result.plan, input.plan);
  assert.equal(Object.isFrozen(result.plan), true);
  assert.equal(Object.isFrozen(result.plan.steps), true);
  assert.equal(Object.isFrozen(result.plan.steps[0]), true);
  assert.equal(Object.isFrozen(result.plan.steps[0].input), true);
  assert.throws(() => { result.plan.steps[0].input.value = 2; }, TypeError);
});

test('rejects plans above the configured canonical size bound', () => {
  const input = request({ intent: 'test', steps: [{ tool: 'noop', input: { value: 'x'.repeat(1024) } }] });
  assert.throws(
    () => createGate({ maxPlanBytes: 128 }).verify(input),
    error => error.code === 'PLAN_GATE_PLAN_TOO_LARGE'
  );
});

test('rejects malformed and non-canonical plan values instead of signing them', () => {
  const input = request();
  input.plan.steps[0].input = { get value() { return 1; } };
  input.validation = new PlanValidator().validate({ intent: 'test', steps: [{ tool: 'noop' }] });
  assert.throws(() => createGate().verify(input), /accessors|canonical/i);
});
