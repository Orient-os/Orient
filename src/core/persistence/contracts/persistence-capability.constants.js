'use strict';

const PERSISTENCE_CONTRACT_VERSION = '1.0.0';

const CAPABILITY_STATUS = Object.freeze({
  SUPPORTED: 'SUPPORTED',
  DEGRADED: 'DEGRADED',
  UNSUPPORTED: 'UNSUPPORTED'
});

const CORE_GUARANTEES = Object.freeze([
  'tenant.isolation',
  'execution.identity.stability',
  'execution.terminal.integrity',
  'idempotency.terminal.protection',
  'event.identity.idempotency'
]);

module.exports = {
  PERSISTENCE_CONTRACT_VERSION,
  CAPABILITY_STATUS,
  CORE_GUARANTEES
};
