'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

function spawnToolWorker({ workspaceRoot, receiptDirectory, operationId, mode = 'contender' }) {
  const source = `
    const fs = require('node:fs/promises');
    const path = require('node:path');
    const ProjectBuilderAgent = require(path.resolve('src/core/agent/project-builder/project-builder-agent'));
    const createProjectTools = require(path.resolve('src/application/tools/project.tools'));
    const ReceiptStore = require(path.resolve('src/infrastructure/execution/project-operation-receipt-store'));
    const root = process.argv[1];
    const receiptDirectory = process.argv[2];
    const operationId = process.argv[3];
    const mode = process.argv[4];
    const proposal = JSON.parse(process.argv[5]);
    (async () => {
      if (mode === 'holder') {
        ProjectBuilderAgent.prototype.execute = async function () {
          await fs.writeFile(path.join(root, proposal.path), proposal.content);
          process.stdout.write('MUTATED\\n');
          await new Promise(resolve => process.stdin.once('data', resolve));
          return {
            status: 'verified',
            verification: { status: 'passed', failed: 0 },
            toJSON() {
              return { status: 'verified', verification: { status: 'passed', failed: 0 } };
            }
          };
        };
      }
      const store = new ReceiptStore({ directory: receiptDirectory });
      const tool = createProjectTools({
        projectRoot: root,
        policy: { allowRead: true, allowWrite: true, allowCommands: false, allowGit: false },
        operationReceiptStore: store
      }).find(item => item.name === 'project.execute_change');
      try {
        const result = await tool.execute({ proposals: [proposal] }, { operationId, tenantId: 'tenant-lock-test' });
        process.stdout.write(JSON.stringify({ result: result.toJSON ? result.toJSON() : result }) + '\\n');
      } catch (error) {
        process.stdout.write(JSON.stringify({ error: error.code || null, message: error.message }) + '\\n');
        process.exitCode = 2;
      }
    })().catch(error => {
      process.stderr.write(error.stack || error.message);
      process.exitCode = 3;
    });
  `;
  const proposal = {
    action: 'update',
    path: 'target.txt',
    content: 'after',
    expectedContentSha256: crypto.createHash('sha256').update('before').digest('hex')
  };
  return spawn(process.execPath, ['-e', source, workspaceRoot, receiptDirectory, operationId, mode, JSON.stringify(proposal)], {
    cwd: path.resolve(__dirname, '../..'),
    stdio: ['pipe', 'pipe', 'pipe']
  });
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise(resolve => child.once('exit', resolve));
}

function nextLine(child) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    child.stdout.setEncoding('utf8');
    const onData = chunk => {
      buffer += chunk;
      const index = buffer.indexOf('\\n');
      if (index >= 0) {
        child.stdout.off('data', onData);
        resolve(buffer.slice(0, index));
      }
    };
    child.stdout.on('data', onData);
    child.once('error', reject);
    child.once('exit', code => {
      if (!buffer.includes('\\n')) reject(new Error('worker exited without a result; code=' + code));
    });
  });
}

test('canonical project tool holds the workspace lock through receipt commit and revalidates after release', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'orient-project-transaction-'));
  const root = path.join(base, 'workspace');
  const receiptDirectory = path.join(base, 'agent-data', 'project-operation-receipts');
  await fs.mkdir(root);
  await fs.mkdir(receiptDirectory, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(root, 'target.txt'), 'before');
  let holder;
  let contender;
  let stale;
  try {
    holder = spawnToolWorker({ workspaceRoot: root, receiptDirectory, operationId: 'operation-holder', mode: 'holder' });
    assert.equal(await nextLine(holder), 'MUTATED');

    contender = spawnToolWorker({ workspaceRoot: root, receiptDirectory, operationId: 'operation-contender' });
    const blocked = JSON.parse(await nextLine(contender));
    assert.equal(blocked.error, 'PROJECT_WORKSPACE_MUTATION_LOCKED');
    await waitForExit(contender);

    holder.stdin.write('continue');
    const committed = JSON.parse(await nextLine(holder));
    assert.equal(committed.result.status, 'verified');
    await waitForExit(holder);

    stale = spawnToolWorker({ workspaceRoot: root, receiptDirectory, operationId: 'operation-stale' });
    const staleResult = JSON.parse(await nextLine(stale));
    assert.equal(staleResult.result.status, 'failed');
    assert.equal(staleResult.result.error.code, 'CHANGE_PRECONDITION_FAILED');
    await waitForExit(stale);
    assert.equal(await fs.readFile(path.join(root, 'target.txt'), 'utf8'), 'after');
  } finally {
    for (const child of [holder, contender, stale]) {
      if (child && child.exitCode === null) child.kill('SIGKILL');
    }
    await fs.rm(base, { recursive: true, force: true });
  }
});
