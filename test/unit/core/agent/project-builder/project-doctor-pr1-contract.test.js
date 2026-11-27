'use strict';

const test = require('node:test');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const ProposalValidator = require('../../../../../src/core/agent/project-builder/change-proposal/proposal-validator');
const ProjectModifier = require('../../../../../src/core/agent/project-builder/modification/project-modifier');
const ProjectVerifier = require('../../../../../src/core/agent/project-builder/verification/project-verifier');
const ChangeSet = require('../../../../../src/core/agent/project-builder/modification/change-set');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function workspaceWith(content = 'before') {
  return {
    exists: async () => true,
    readText: async () => content,
    writeText: async () => {},
    removeFile: async () => {}
  };
}

test('proposal validator rejects update proposals without a before-image digest', async () => {
  const validator = new ProposalValidator({ workspace: workspaceWith() });
  const result = await validator.validate({
    proposals: [{ action: 'update', path: 'src/file.js', content: 'after' }]
  });

  assert.equal(result.valid, false);
  assert.equal(result.errors[0].code, 'CHANGE_PRECONDITION_REQUIRED');
});

test('proposal validator rejects malformed update digests', async () => {
  const validator = new ProposalValidator({ workspace: workspaceWith() });
  for (const expectedContentSha256 of ['', 'abc', 'g'.repeat(64), 42, null]) {
    const result = await validator.validate({
      proposals: [{
        action: 'update',
        path: 'src/file.js',
        content: 'after',
        expectedContentSha256
      }]
    });
    assert.equal(result.valid, false, `accepted digest: ${String(expectedContentSha256)}`);
  }
});

test('proposal validator accepts a matching SHA-256 before-image digest', async () => {
  const validator = new ProposalValidator({ workspace: workspaceWith('before') });
  const result = await validator.validate({
    proposals: [{
      action: 'update',
      path: 'src/file.js',
      content: 'after',
      expectedContentSha256: sha256('before')
    }]
  });

  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test('project modifier independently requires and validates update before-image digests', async () => {
  const modifier = new ProjectModifier({ workspace: workspaceWith('before') });

  await assert.rejects(
    modifier.validateChange({ action: 'update', path: 'src/file.js', content: 'after' }),
    error => error.code === 'CHANGE_PRECONDITION_REQUIRED'
  );
  await assert.rejects(
    modifier.validateChange({
      action: 'update',
      path: 'src/file.js',
      content: 'after',
      expectedContentSha256: 'not-a-sha256'
    }),
    error => error.code === 'CHANGE_PRECONDITION_INVALID'
  );
  await assert.doesNotReject(
    modifier.validateChange({
      action: 'update',
      path: 'src/file.js',
      content: 'after',
      expectedContentSha256: sha256('before')
    })
  );
});

test('project verifier fails closed for undefined, null, primitives and malformed results', async () => {
  const verifier = new ProjectVerifier({ workspace: workspaceWith() });
  const invalidResults = [undefined, null, true, false, 'passed', 1, {}, { passed: 'yes' }, []];

  for (const result of invalidResults) {
    const verification = await verifier.verify({
      definitionOfDone: ['verification must be explicit'],
      checks: [{ id: 'invalid-result', run: async () => result }]
    });

    assert.equal(verification.status, 'failed', `accepted result: ${String(result)}`);
    assert.equal(verification.failed, 1);
    assert.equal(verification.definitionOfDoneSatisfied, false);
  }
});

test('project verifier accepts only an explicit passed true result', async () => {
  const verifier = new ProjectVerifier({ workspace: workspaceWith() });
  const verification = await verifier.verify({
    definitionOfDone: ['verification must be explicit'],
    checks: [{ id: 'explicit-pass', run: async () => ({ passed: true, evidence: 'verified' }) }]
  });

  assert.equal(verification.status, 'passed');
  assert.equal(verification.passed, 1);
  assert.equal(verification.failed, 0);
  assert.equal(verification.definitionOfDoneSatisfied, true);
});

test('project verifier reports an empty check set as failed, not passed', async () => {
  const verifier = new ProjectVerifier({ workspace: workspaceWith() });
  const verification = await verifier.verify({
    definitionOfDone: ['at least one real check'],
    checks: []
  });

  assert.equal(verification.status, 'failed');
  assert.equal(verification.passed, 0);
  assert.equal(verification.failed, 0);
  assert.equal(verification.definitionOfDoneSatisfied, false);
});


test('owner dashboard visibly renders the truthful concurrency limitation from the approval summary', () => {
  const source = fs.readFileSync(require.resolve('../../../../../src/interfaces/http/owner-dashboard.js'), 'utf8');
  assert.match(source, /summary\.reviewNotice/);
  assert.match(source, /card\.append\(reviewNotice\)/);
  assert.match(source, /expectedContentSha256 !== 'string' \|\| !\/\^\[a-f0-9\]\{64\}\$\/i\.test/);
});


test('change set preserves the update before-image digest for the modifier boundary', () => {
  const expectedContentSha256 = sha256('before');
  const changeSet = new ChangeSet({
    changes: [{
      action: 'update',
      path: 'src/file.js',
      content: 'after',
      expectedContentSha256
    }]
  });

  assert.equal(changeSet.changes[0].expectedContentSha256, expectedContentSha256);
});
