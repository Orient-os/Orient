'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const ProjectModifier = require('../../../../../src/core/agent/project-builder/modification/project-modifier');
const BuildExecutionService = require('../../../../../src/core/agent/project-builder/execution/build-execution-service');

test('modifier revalidates the exact snapshot immediately before creating the durable intent', async () => {
  let reads = 0;
  let writes = 0;
  const workspace = {
    exists: async () => true,
    readText: async () => {
      reads += 1;
      return reads === 1 ? 'before' : 'external-change-before-snapshot';
    },
    writeText: async () => { writes += 1; },
    removeFile: async () => {}
  };
  const modifier = new ProjectModifier({ workspace });
  await assert.rejects(
    () => modifier.apply({
      changes: [{
        action: 'update',
        path: 'config.json',
        content: 'after',
        expectedContentSha256: crypto.createHash('sha256').update('before').digest('hex')
      }]
    }),
    { code: 'CHANGE_PRECONDITION_FAILED' }
  );
  assert.equal(writes, 0);
});

test('execution service invokes the durable intent hook with validated snapshots before the first write', async () => {
  const files = new Map([['config.json', 'before']]);
  let intentPrepared = false;
  const workspace = {
    exists: async filePath => files.has(filePath),
    readText: async filePath => files.get(filePath),
    writeText: async (filePath, content) => {
      assert.equal(intentPrepared, true);
      files.set(filePath, content);
    },
    removeFile: async filePath => { files.delete(filePath); }
  };
  const modifier = new ProjectModifier({ workspace });
  const service = new BuildExecutionService({
    modifier,
    verifier: { verify: async () => ({ status: 'passed', failed: 0, passed: 1 }) }
  });
  const result = await service.execute({
    changeSet: {
      changes: [{
        action: 'update',
        path: 'config.json',
        content: 'after',
        expectedContentSha256: crypto.createHash('sha256').update('before').digest('hex')
      }]
    },
    beforeMutation: async ({ snapshots, changes }) => {
      assert.equal(snapshots[0].content, 'before');
      assert.equal(changes[0].content, 'after');
      intentPrepared = true;
    }
  });
  assert.equal(result.status, 'verified');
  assert.equal(files.get('config.json'), 'after');
});

test('verification rollback refuses to overwrite an external change made after ORIENT applied its after-image', async () => {
  const files = new Map([['config.json', 'before']]);
  const workspace = {
    exists: async filePath => files.has(filePath),
    readText: async filePath => files.get(filePath),
    writeText: async (filePath, content) => { files.set(filePath, content); },
    removeFile: async filePath => { files.delete(filePath); }
  };
  const modifier = new ProjectModifier({ workspace });
  const verifier = {
    verify: async () => {
      files.set('config.json', 'external-writer-change');
      return { status: 'failed', failed: 1, passed: 0 };
    }
  };
  const service = new BuildExecutionService({ modifier, verifier });

  const result = await service.execute({
    changeSet: {
      changes: [{
        action: 'update',
        path: 'config.json',
        content: 'after',
        expectedContentSha256: crypto.createHash('sha256').update('before').digest('hex')
      }]
    },
    checks: [{ id: 'forced-failure' }]
  });

  assert.equal(files.get('config.json'), 'external-writer-change');
  assert.equal(result.status, 'rollback-failed');
  assert.equal(result.rollback?.rolledBack, false);
  assert.equal(result.rollback?.rollbackErrors?.[0]?.code, 'WORKSPACE_ROLLBACK_CONFLICT');
});

test('verification exceptions trigger rollback before the workspace lock can be released', async () => {
  const files = new Map([['settings.json', 'before']]);
  const workspace = {
    exists: async filePath => files.has(filePath),
    readText: async filePath => files.get(filePath),
    writeText: async (filePath, content) => { files.set(filePath, content); },
    removeFile: async filePath => { files.delete(filePath); }
  };
  const modifier = new ProjectModifier({ workspace });
  const service = new BuildExecutionService({
    modifier,
    verifier: { verify: async () => { throw new Error('verification infrastructure failed'); } }
  });

  const result = await service.execute({
    changeSet: {
      changes: [{
        action: 'update',
        path: 'settings.json',
        content: 'after',
        expectedContentSha256: crypto.createHash('sha256').update('before').digest('hex')
      }]
    }
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.rollback?.rolledBack, true);
  assert.equal(files.get('settings.json'), 'before');
  assert.equal(result.error.message, 'verification infrastructure failed');
});

test('rollback refuses a terminal rolled-back outcome when an untouched file changed externally', async () => {
  const files = new Map([
    ['first.txt', 'before-first'],
    ['second.txt', 'before-second']
  ]);
  const workspace = {
    exists: async filePath => files.has(filePath),
    readText: async filePath => files.get(filePath),
    writeText: async (filePath, content) => { files.set(filePath, content); },
    removeFile: async filePath => { files.delete(filePath); }
  };
  const modifier = new ProjectModifier({ workspace });
  const service = new BuildExecutionService({
    modifier,
    verifier: { verify: async () => ({ status: 'failed', failed: 1, passed: 0 }) }
  });

  const result = await service.execute({
    changeSet: {
      changes: [
        {
          action: 'update',
          path: 'first.txt',
          content: 'after-first',
          expectedContentSha256: crypto.createHash('sha256').update('before-first').digest('hex')
        },
        {
          action: 'update',
          path: 'second.txt',
          content: 'after-second',
          expectedContentSha256: crypto.createHash('sha256').update('before-second').digest('hex')
        }
      ]
    },
    beforeMutation: async () => { files.set('second.txt', 'external-change'); }
  });

  assert.equal(result.status, 'rollback-failed');
  assert.equal(result.rollback?.rolledBack, false);
  assert.equal(files.get('first.txt'), 'before-first');
  assert.equal(files.get('second.txt'), 'external-change');
  assert.equal(result.rollback?.rollbackErrors?.[0]?.code, 'WORKSPACE_ROLLBACK_CONFLICT');
});

test('partial apply rollback only touches files whose current bytes still match this operation after-image', async () => {
  const files = new Map([
    ['first.txt', 'before-first'],
    ['second.txt', 'before-second']
  ]);
  const workspace = {
    exists: async filePath => files.has(filePath),
    readText: async filePath => files.get(filePath),
    writeText: async (filePath, content) => {
      if (filePath === 'second.txt') {
        files.set('first.txt', 'external-writer-change');
        throw new Error('simulated second write failure');
      }
      files.set(filePath, content);
    },
    removeFile: async filePath => { files.delete(filePath); }
  };
  const modifier = new ProjectModifier({ workspace });

  await assert.rejects(
    () => modifier.apply({
      changes: [
        {
          action: 'update',
          path: 'first.txt',
          content: 'after-first',
          expectedContentSha256: crypto.createHash('sha256').update('before-first').digest('hex')
        },
        { action: 'update', path: 'second.txt', content: 'after-second',
          expectedContentSha256: crypto.createHash('sha256').update('before-second').digest('hex') }
      ]
    }),
    error => {
      assert.equal(error.code, 'PROJECT_MODIFICATION_ROLLBACK_FAILED');
      assert.equal(error.rollbackError?.rollbackErrors?.[0]?.code, 'WORKSPACE_ROLLBACK_CONFLICT');
      return true;
    }
  );

  assert.equal(files.get('first.txt'), 'external-writer-change');
  assert.equal(files.get('second.txt'), 'before-second');
});
