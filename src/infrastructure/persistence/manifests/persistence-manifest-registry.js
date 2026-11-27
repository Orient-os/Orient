'use strict';

const { PERSISTENCE_CONTRACT_VERSION, CAPABILITY_STATUS } =
  require('../../../core/persistence/contracts/persistence-capability.constants');

const { SUPPORTED, DEGRADED, UNSUPPORTED } = CAPABILITY_STATUS;

function capability(status, guarantees = [], interfaces = []) {
  return Object.freeze({
    status,
    guarantees: Object.freeze([...guarantees]),
    interfaces: Object.freeze([...interfaces])
  });
}

// This registry is the only authority for adapter capability declarations.
// Adapters cannot add capabilities dynamically at runtime.
const MANIFESTS = Object.freeze({
  json: Object.freeze({
    adapter: 'json',
    implementationVersion: '0.12.x',
    contractVersion: PERSISTENCE_CONTRACT_VERSION,
    guarantees: Object.freeze([
      'tenant.isolation',
      'execution.identity.stability',
      'execution.terminal.integrity',
      'idempotency.terminal.protection',
      'event.identity.idempotency'
    ]),
    capabilities: Object.freeze({
      'approval.durable': capability(UNSUPPORTED),
      'execution.resumeLease': capability(UNSUPPORTED),
      'worker.fencing': capability(UNSUPPORTED),
      'workflow.durable': capability(UNSUPPORTED),
      'workflow.ephemeral': capability(DEGRADED, ['workflow.persistence.unavailable']),
      'execution.cancellation': capability(SUPPORTED, [], ['executions.requestCancellation'])
    })
  }),
  sqlite: Object.freeze({
    adapter: 'sqlite',
    implementationVersion: '0.12.x',
    contractVersion: PERSISTENCE_CONTRACT_VERSION,
    guarantees: Object.freeze([
      'tenant.isolation',
      'execution.identity.stability',
      'execution.terminal.integrity',
      'event.identity.idempotency'
    ]),
    capabilities: Object.freeze({
      'approval.durable': capability(SUPPORTED),
      'execution.resumeLease': capability(UNSUPPORTED),
      'worker.fencing': capability(UNSUPPORTED),
      'workflow.durable': capability(SUPPORTED),
      'workflow.ephemeral': capability(UNSUPPORTED),
      'execution.cancellation': capability(UNSUPPORTED)
    })
  }),
  postgres: Object.freeze({
    adapter: 'postgres',
    implementationVersion: '0.12.x',
    contractVersion: PERSISTENCE_CONTRACT_VERSION,
    guarantees: Object.freeze([
      'tenant.isolation',
      'execution.identity.stability',
      'execution.terminal.integrity',
      'idempotency.terminal.protection',
      'event.identity.idempotency'
    ]),
    capabilities: Object.freeze({
      'approval.durable': capability(SUPPORTED),
      'execution.resumeLease': capability(SUPPORTED),
      'worker.fencing': capability(SUPPORTED),
      'workflow.durable': capability(SUPPORTED),
      'workflow.ephemeral': capability(UNSUPPORTED),
      'execution.cancellation': capability(SUPPORTED)
    })
  })
});

function getPersistenceManifest(adapter) {
  return MANIFESTS[adapter] || null;
}

module.exports = { MANIFESTS, getPersistenceManifest };
