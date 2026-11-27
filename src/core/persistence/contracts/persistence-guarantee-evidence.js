'use strict';

// Behavioral evidence is executed by Strict CI. Runtime interface inspection
// must never promote these references to a behavioral proof by itself.
const EVIDENCE = Object.freeze({
  json: Object.freeze({
    'tenant.isolation': Object.freeze([
      Object.freeze({
        file: 'test/unit/infrastructure/persistence/json/event-repository-tenant-boundaries.test.js',
        testName: 'an event id owned by another tenant cannot be replayed or overwritten'
      })
    ]),
    'execution.identity.stability': Object.freeze([
      Object.freeze({
        file: 'test/unit/infrastructure/persistence/json/execution-repository.terminal-integrity.test.js',
        testName: 'JSON execution identity cannot be rebound by updates'
      })
    ]),
    'execution.terminal.integrity': Object.freeze([
      Object.freeze({
        file: 'test/unit/infrastructure/persistence/json/execution-repository.terminal-integrity.test.js',
        testName: 'JSON execution terminal states are immutable across retries and repository restart'
      }),
      Object.freeze({
        file: 'test/unit/infrastructure/persistence/json/execution-repository.terminal-integrity.test.js',
        testName: 'JSON terminal integrity includes durable failure details, not only status'
      })
    ]),
    'idempotency.terminal.protection': Object.freeze([
      Object.freeze({
        file: 'test/unit/infrastructure/idempotency-integrity.test.js',
        testName: 'completed idempotency record is immutable and conflicting completion is rejected'
      }),
      Object.freeze({
        file: 'test/unit/infrastructure/idempotency-integrity.test.js',
        testName: 'completed idempotency record cannot transition to failed'
      })
    ]),
    'event.identity.idempotency': Object.freeze([
      Object.freeze({
        file: 'test/unit/infrastructure/persistence/json/event-repository.security.test.js',
        testName: 'append replay for the same tenant and event id remains idempotent'
      })
    ])
  }),
  sqlite: Object.freeze({
    'tenant.isolation': Object.freeze([
      Object.freeze({
        file: 'test/unit/infrastructure/sqlite-persistence.test.js',
        testName: 'SQLite execution pages and event replay are bounded and tenant-scoped'
      })
    ]),
    'execution.identity.stability': Object.freeze([
      Object.freeze({
        file: 'test/unit/infrastructure/persistence/sqlite-execution-terminal.test.js',
        testName: 'SQLite execution identity cannot be rebound by updates'
      })
    ]),
    'execution.terminal.integrity': Object.freeze([
      Object.freeze({
        file: 'test/unit/infrastructure/persistence/sqlite-execution-terminal.test.js',
        testName: 'SQLite execution terminal states are immutable and tenant-scoped'
      }),
      Object.freeze({
        file: 'test/unit/infrastructure/persistence/sqlite-execution-terminal.test.js',
        testName: 'SQLite cancellation committed after the read wins the terminal compare-and-set'
      })
    ]),
    'idempotency.terminal.protection': Object.freeze([
      Object.freeze({
        file: 'test/unit/infrastructure/persistence/sqlite-idempotency-terminal.test.js',
        testName: 'SQLite idempotency terminal transitions are immutable and tenant-scoped'
      })
    ]),
    'event.identity.idempotency': Object.freeze([
      Object.freeze({
        file: 'test/unit/infrastructure/sqlite-persistence.test.js',
        testName: 'SQLite mission event append assigns stable tenant-scoped sequences and rejects ID reuse'
      })
    ])
  }),
  postgres: Object.freeze({
    'tenant.isolation': Object.freeze([
      Object.freeze({
        file: 'test/integration/postgres-persistence.integration.test.js',
        testName: 'PostgreSQL durable mission events serialize aggregate sequences and isolate tenants'
      })
    ]),
    'execution.identity.stability': Object.freeze([
      Object.freeze({
        file: 'test/integration/postgres-persistence.integration.test.js',
        testName: 'PostgreSQL execution identity cannot be rebound across durable updates'
      })
    ]),
    'execution.terminal.integrity': Object.freeze([
      Object.freeze({
        file: 'test/integration/postgres-persistence.integration.test.js',
        testName: 'PostgreSQL terminal execution snapshots are immutable and exact retries are idempotent'
      })
    ]),
    'idempotency.terminal.protection': Object.freeze([
      Object.freeze({
        file: 'test/integration/postgres-task-idempotency.integration.test.js',
        testName: 'PostgreSQL task idempotency is durable, tenant-scoped, and terminal-state safe'
      }),
      Object.freeze({
        file: 'test/integration/postgres-task-idempotency.integration.test.js',
        testName: 'PostgreSQL concurrent terminal writes permit only one idempotency outcome'
      })
    ]),
    'event.identity.idempotency': Object.freeze([
      Object.freeze({
        file: 'test/integration/postgres-persistence.integration.test.js',
        testName: 'PostgreSQL durable mission events serialize aggregate sequences and isolate tenants'
      })
    ])
  })
});

function getPersistenceGuaranteeEvidence(adapter, guarantees) {
  const adapterEvidence = EVIDENCE[adapter];
  if (!adapterEvidence) return null;

  const resolved = {};
  for (const guarantee of guarantees || []) {
    const evidence = adapterEvidence[guarantee];
    if (!Array.isArray(evidence) || evidence.length === 0) return null;
    resolved[guarantee] = Object.freeze(evidence.map(item => Object.freeze({
      file: item.file,
      testName: item.testName
    })));
  }
  return Object.freeze(resolved);
}

module.exports = { EVIDENCE, getPersistenceGuaranteeEvidence };
