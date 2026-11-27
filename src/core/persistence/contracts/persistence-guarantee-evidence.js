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
        testName: 'PostgreSQL mission event identity is idempotent and cannot be rebound across tenants'
      })
    ])
  })
});

const CAPABILITY_EVIDENCE = Object.freeze({
  json: Object.freeze({
    'workflow.ephemeral': Object.freeze({
      'workflow.persistence.ephemeral': Object.freeze([Object.freeze({
        file: 'test/unit/infrastructure/persistence-factory.test.js',
        testName: 'JSON persistence exposes no durable workflow repositories'
      })])
    }),
    'execution.cancellation': Object.freeze({
      'execution.cancellation.durability': Object.freeze([Object.freeze({
        file: 'test/unit/infrastructure/persistence/json/execution-repository.cancellation.test.js',
        testName: 'execution cancellation is durable, tenant-scoped, and idempotent'
      })])
    })
  }),
  sqlite: Object.freeze({
    'approval.durable': Object.freeze({
      'approval.decision.atomicity': Object.freeze([Object.freeze({
        file: 'test/unit/infrastructure/sqlite-persistence.test.js',
        testName: 'SQLite approval storage survives restart and remains single-use'
      })])
    }),
    'workflow.durable': Object.freeze({
      'workflow.state.durability': Object.freeze([Object.freeze({
        file: 'test/unit/infrastructure/sqlite-persistence.test.js',
        testName: 'SQLite workflow outbox is bounded, tenant-scoped, and revision-checked'
      }), Object.freeze({
        file: 'test/unit/infrastructure/sqlite-persistence.test.js',
        testName: 'SQLite workflow repair uses revision compare-and-set and rejects stale writers'
      })])
    })
  }),
  postgres: Object.freeze({
    'approval.durable': Object.freeze({
      'approval.decision.atomicity': Object.freeze([Object.freeze({
        file: 'test/integration/postgres-persistence.integration.test.js',
        testName: 'PostgreSQL approval authorization is durable, tenant-scoped and replay-safe'
      })])
    }),
    'execution.resumeLease': Object.freeze({
      'execution.resume.lease-ownership': Object.freeze([Object.freeze({
        file: 'test/integration/postgres-persistence.integration.test.js',
        testName: 'PostgreSQL resume leases are atomic, tenant-scoped, and releasable only by the owner'
      })])
    }),
    'worker.fencing': Object.freeze({
      'worker.lease.fencing': Object.freeze([Object.freeze({
        file: 'test/integration/postgres-persistence.integration.test.js',
        testName: 'PostgreSQL fencing rejects stale writes after a lease takeover'
      })])
    }),
    'workflow.durable': Object.freeze({
      'workflow.state.durability': Object.freeze([Object.freeze({
        file: 'test/integration/postgres-persistence.integration.test.js',
        testName: 'PostgreSQL async mission recovery repairs then verifies a durable workflow snapshot'
      })])
    }),
    'execution.cancellation': Object.freeze({
      'execution.cancellation.durability': Object.freeze([Object.freeze({
        file: 'test/integration/postgres-persistence.integration.test.js',
        testName: 'PostgreSQL execution cancellation is durable and tenant-scoped'
      }), Object.freeze({
        file: 'test/integration/postgres-persistence.integration.test.js',
        testName: 'PostgreSQL cancellation wins terminal completion race'
      })])
    })
  })
});

function getPersistenceCapabilityGuaranteeEvidence(adapter, capability, guarantees) {
  const declarations = CAPABILITY_EVIDENCE[adapter]?.[capability];
  if (!declarations) return null;
  const resolved = {};
  for (const guarantee of guarantees || []) {
    const evidence = declarations[guarantee];
    if (!Array.isArray(evidence) || evidence.length === 0) return null;
    resolved[guarantee] = Object.freeze(evidence.map(item => Object.freeze({
      file: item.file,
      testName: item.testName
    })));
  }
  return Object.freeze(resolved);
}

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

module.exports = { EVIDENCE, CAPABILITY_EVIDENCE, getPersistenceGuaranteeEvidence, getPersistenceCapabilityGuaranteeEvidence };
