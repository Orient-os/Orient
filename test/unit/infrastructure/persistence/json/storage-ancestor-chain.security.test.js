'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ApprovalRepository = require('../../../../../src/infrastructure/persistence/json/approval.repository');
const CheckpointRepository = require('../../../../../src/infrastructure/persistence/json/checkpoint.repository');
const ExecutionRepository = require('../../../../../src/infrastructure/persistence/json/execution.repository');
const IdempotencyRepository = require('../../../../../src/infrastructure/persistence/json/idempotency.repository');
const WorkflowLeaseRepository = require('../../../../../src/infrastructure/persistence/json/workflow-lease.repository');
const WorkflowRepository = require('../../../../../src/infrastructure/persistence/json/workflow.repository');
const JsonMemoryRepository = require('../../../../../src/infrastructure/memory/json-memory.repository');
const MemoryAuditRepository = require('../../../../../src/infrastructure/memory/memory-audit.repository');
const ProjectOperationReceiptStore = require('../../../../../src/infrastructure/execution/project-operation-receipt-store');
const JsonAccessAuditRepository = require('../../../../../src/infrastructure/security/json-access-audit.repository');
const OwnerChatConversationStore = require('../../../../../src/infrastructure/persistence/owner-chat-conversation-store');
const OwnerWorkProfileStore = require('../../../../../src/infrastructure/persistence/owner-work-profile-store');
const OwnerIdentityService = require('../../../../../src/core/security/owner-identity-service');
const MemoryTransactionCoordinator = require('../../../../../src/infrastructure/memory/memory-transaction-coordinator');
const SqliteDatabase = require('../../../../../src/infrastructure/persistence/sqlite/sqlite-database');

const storageFactories = [
  ['approval', file => new ApprovalRepository(file)],
  ['checkpoint', file => new CheckpointRepository(file)],
  ['execution', file => new ExecutionRepository(file)],
  ['idempotency', file => new IdempotencyRepository(file)],
  ['workflow lease', file => new WorkflowLeaseRepository(file)],
  ['workflow', file => new WorkflowRepository(file)],
  ['JSON memory', file => new JsonMemoryRepository(file)],
  ['memory audit', file => new MemoryAuditRepository(file)],
  ['project operation receipts', file => new ProjectOperationReceiptStore({ directory: path.dirname(file) }).ensureDirectory()],
  ['access audit', async file => new JsonAccessAuditRepository(file).initialize()],
  ['owner chat', async file => new OwnerChatConversationStore({ filePath: file }).writeRecord({ version: 1, messages: [] })],
  ['owner profile', async file => new OwnerWorkProfileStore({ filePath: file }).update({ displayName: 'Owner' })],
  ['owner identity', file => new OwnerIdentityService({ stateFile: file, bootstrapPassword: 'SecureBootstrapPassword123!' })],
  ['memory transaction journal', file => new MemoryTransactionCoordinator({ memoryFile: file, auditFile: file + '.audit', journalFile: file + '.journal' })],
  ['SQLite database', file => new SqliteDatabase(file)]
];

for (const [name, initialize] of storageFactories) {
  test(name + ' rejects a writable non-sticky grandparent before creating storage', async t => {
    if (process.platform === 'win32' || typeof process.getuid !== 'function') {
      t.skip('POSIX ownership and mode checks are not available');
      return;
    }

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-storage-ancestor-'));
    const untrusted = path.join(root, 'untrusted');
    const privateParent = path.join(untrusted, 'private-parent');
    const storage = path.join(privateParent, 'storage');
    fs.mkdirSync(privateParent, { recursive: true, mode: 0o700 });
    fs.chmodSync(untrusted, 0o777);

    t.after(() => {
      fs.chmodSync(untrusted, 0o700);
      fs.rmSync(root, { recursive: true, force: true });
    });

    const file = path.join(storage, 'state.json');
    await assert.rejects(
      async () => initialize(file),
      error => error && /_PARENT_UNTRUSTED$/.test(error.code || '')
    );
    assert.equal(fs.existsSync(storage), false, 'storage must not be created below an untrusted ancestor');
  });
}
