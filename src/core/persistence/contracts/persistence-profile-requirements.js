'use strict';

const { CORE_GUARANTEES } = require('./persistence-capability.constants');

function capabilityPolicy(degradationAllowed, requiredGuarantees) {
  return Object.freeze({
    degradationAllowed,
    requiredGuarantees: Object.freeze([...requiredGuarantees])
  });
}

const PROFILE_REQUIREMENTS = Object.freeze({
  local: Object.freeze({
    requiredGuarantees: CORE_GUARANTEES,
    optionalCapabilities: Object.freeze({
      'workflow.durable': capabilityPolicy(true, ['workflow.state.durability']),
      'workflow.ephemeral': capabilityPolicy(true, ['workflow.persistence.ephemeral']),
      'approval.durable': capabilityPolicy(false, ['approval.decision.atomicity']),
      'execution.resumeLease': capabilityPolicy(false, ['execution.resume.lease-ownership']),
      'worker.fencing': capabilityPolicy(false, ['worker.lease.fencing']),
      'execution.cancellation': capabilityPolicy(false, ['execution.cancellation.durability'])
    })
  }),
  postgres: Object.freeze({
    requiredGuarantees: CORE_GUARANTEES,
    optionalCapabilities: Object.freeze({
      'workflow.durable': capabilityPolicy(false, ['workflow.state.durability']),
      'workflow.ephemeral': capabilityPolicy(false, ['workflow.persistence.ephemeral']),
      'approval.durable': capabilityPolicy(false, ['approval.decision.atomicity']),
      'execution.resumeLease': capabilityPolicy(false, ['execution.resume.lease-ownership']),
      'worker.fencing': capabilityPolicy(false, ['worker.lease.fencing']),
      'execution.cancellation': capabilityPolicy(false, ['execution.cancellation.durability'])
    })
  })
});

module.exports = PROFILE_REQUIREMENTS;
