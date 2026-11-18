'use strict';

const crypto = require('node:crypto');
const { canonicalJson } = require('./evidence-record');

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function digest(value) {
  return crypto.createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

class IndependentPlanExecutionGate {
  constructor({ verifier, clock = () => new Date(), maxPlanBytes = 2 * 1024 * 1024 } = {}) {
    if (!verifier || typeof verifier.validate !== 'function') {
      throw new TypeError('An independent plan verifier is required');
    }
    if (typeof clock !== 'function') throw new TypeError('clock must be a function');
    if (!Number.isSafeInteger(maxPlanBytes) || maxPlanBytes < 1) {
      throw new TypeError('maxPlanBytes must be a positive safe integer');
    }
    this.verifier = verifier;
    this.clock = clock;
    this.maxPlanBytes = maxPlanBytes;
    this.verifierId = 'ORIENT_INDEPENDENT_PLAN_VERIFIER';
    this.verifierVersion = '1';
  }

  verify({ plan, validation, executionId, tenantId, userId, workspaceId, agentId, planRevision = 1 } = {}) {
    if (typeof executionId !== 'string' || !executionId.trim()) {
      throw Object.assign(new Error('Execution identity is required by the plan gate'), {
        code: 'PLAN_GATE_EXECUTION_ID_REQUIRED'
      });
    }
    for (const [name, value] of Object.entries({ tenantId, userId, workspaceId })) {
      if (typeof value !== 'string' || !value.trim()) {
        throw Object.assign(new Error(name + ' identity is required by the plan gate'), {
          code: 'PLAN_GATE_IDENTITY_REQUIRED'
        });
      }
    }
    if (!Number.isSafeInteger(planRevision) || planRevision < 1) {
      throw Object.assign(new Error('Plan revision must be a positive integer'), {
        code: 'PLAN_GATE_REVISION_INVALID'
      });
    }
    if (!validation || validation.valid !== true || !Array.isArray(validation.steps)) {
      throw Object.assign(new Error('Planner validation is missing or invalid'), {
        code: 'PLAN_GATE_UPSTREAM_VALIDATION_INVALID'
      });
    }

    const planBytes = Buffer.byteLength(canonicalJson(plan), 'utf8');
    if (planBytes > this.maxPlanBytes) {
      throw Object.assign(new Error('Plan exceeds the independent verification size limit'), {
        code: 'PLAN_GATE_PLAN_TOO_LARGE'
      });
    }

    // This verifier runs independently of the planner's validation result.
    const independent = this.verifier.validate(plan);
    if (!independent || independent.valid !== true || !Array.isArray(independent.steps)) {
      throw Object.assign(new Error('Independent plan verification failed'), {
        code: 'PLAN_GATE_REJECTED'
      });
    }
    if (canonicalJson(independent.steps) !== canonicalJson(validation.steps)) {
      throw Object.assign(new Error('Planner and independent verifier disagree on normalized steps'), {
        code: 'PLAN_GATE_VALIDATION_DIVERGENCE'
      });
    }

    const verifiedPlan = deepFreeze({
      ...plan,
      steps: independent.steps
    });
    const identity = Object.freeze({
      executionId,
      tenantId,
      userId,
      workspaceId,
      agentId: typeof agentId === 'string' && agentId.trim() ? agentId : 'ORIENT_RUNTIME',
      planRevision
    });
    const planSha256 = digest(verifiedPlan);
    const verifiedAt = this.clock();
    const timestamp = verifiedAt instanceof Date ? verifiedAt : new Date(verifiedAt);
    if (Number.isNaN(timestamp.getTime())) {
      throw Object.assign(new Error('Plan gate clock returned an invalid timestamp'), {
        code: 'PLAN_GATE_CLOCK_INVALID'
      });
    }

    const receiptBody = {
      schemaVersion: 1,
      verifier: this.verifierId,
      verifierVersion: this.verifierVersion,
      identity,
      planSha256,
      verifiedAt: timestamp.toISOString(),
      verification: 'independent_revalidation',
      decision: 'allow'
    };
    const receipt = Object.freeze({
      ...receiptBody,
      receiptSha256: digest(receiptBody)
    });

    return Object.freeze({
      plan: verifiedPlan,
      validation: Object.freeze({ valid: true, steps: verifiedPlan.steps }),
      receipt
    });
  }
}

module.exports = IndependentPlanExecutionGate;
