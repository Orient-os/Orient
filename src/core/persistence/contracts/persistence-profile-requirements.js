'use strict';

const { CORE_GUARANTEES } = require('./persistence-capability.constants');

const PROFILE_REQUIREMENTS = Object.freeze({
  local: Object.freeze({
    requiredGuarantees: CORE_GUARANTEES,
    optionalCapabilities: Object.freeze({
      'workflow.durable': Object.freeze({ degradationAllowed: true }),
      'workflow.ephemeral': Object.freeze({ degradationAllowed: true }),
      'approval.durable': Object.freeze({ degradationAllowed: false }),
      'execution.resumeLease': Object.freeze({ degradationAllowed: false }),
      'worker.fencing': Object.freeze({ degradationAllowed: false }),
      'execution.cancellation': Object.freeze({ degradationAllowed: false })
    })
  }),
  postgres: Object.freeze({
    requiredGuarantees: CORE_GUARANTEES,
    optionalCapabilities: Object.freeze({
      'workflow.durable': Object.freeze({ degradationAllowed: false }),
      'workflow.ephemeral': Object.freeze({ degradationAllowed: false }),
      'approval.durable': Object.freeze({ degradationAllowed: false }),
      'execution.resumeLease': Object.freeze({ degradationAllowed: false }),
      'worker.fencing': Object.freeze({ degradationAllowed: false }),
      'execution.cancellation': Object.freeze({ degradationAllowed: false })
    })
  })
});

module.exports = PROFILE_REQUIREMENTS;
