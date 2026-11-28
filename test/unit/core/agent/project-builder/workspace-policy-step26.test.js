const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const WorkspacePolicy =
  require('../../../../../src/core/agent/project-builder/workspace/workspace-policy');

const FileWorkspace =
  require('../../../../../src/core/agent/project-builder/workspace/file-workspace');

function makePolicy(root) {
  return new WorkspacePolicy({
    allowedRoot: root,
    allowWrite: true
  });
}

test('rejects a broken symlink write target', () => {
  if (process.platform === 'win32') return;

  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'orient-broken-symlink-')
  );
  const root = path.join(dir, 'root');
  fs.mkdirSync(root);
  fs.symlinkSync(
    path.join(dir, 'missing.txt'),
    path.join(root, 'target.txt')
  );

  const policy = makePolicy(root);

  assert.throws(
    () => policy.assertWrite('target.txt'),
    /Workspace path escapes allowed root|symbolic link and is denied/
  );

  fs.rmSync(dir, { recursive: true, force: true });
});

test('rejects a symlinked parent before a write can reach outside the workspace', async () => {
  if (process.platform === 'win32') return;

  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'orient-symlink-parent-')
  );
  const root = path.join(dir, 'root');
  const outside = path.join(dir, 'outside');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  fs.writeFileSync(
    path.join(outside, 'target.txt'),
    'protected'
  );
  fs.symlinkSync(
    outside,
    path.join(root, 'linked'),
    'dir'
  );

  const workspace = new FileWorkspace({
    policy: makePolicy(root)
  });

  await assert.rejects(
    workspace.writeText(
      'linked/target.txt',
      'pwned'
    ),
    /Workspace path escapes allowed root|symbolic link and is denied/
  );

  assert.equal(
    fs.readFileSync(
      path.join(outside, 'target.txt'),
      'utf8'
    ),
    'protected'
  );

  fs.rmSync(dir, { recursive: true, force: true });
});

test('pins the parent directory so a post-validation symlink swap cannot redirect the write', () => {
  if (process.platform !== 'linux') return;

  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'orient-toctou-')
  );
  const root = path.join(dir, 'root');
  const outside = path.join(dir, 'outside');
  const workspaceDir = path.join(root, 'workspace');
  const movedDir = path.join(dir, 'workspace-original');

  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(
    path.join(workspaceDir, 'target.txt'),
    'original'
  );
  fs.writeFileSync(
    path.join(outside, 'target.txt'),
    'protected'
  );

  const policy = makePolicy(root);
  const resolved = path.join(
    root,
    'workspace',
    'target.txt'
  );

  const originalAssertWrite =
    policy.assertWrite.bind(policy);

  policy.assertWrite = () => {
    fs.renameSync(workspaceDir, movedDir);
    fs.symlinkSync(outside, workspaceDir, 'dir');
    return resolved;
  };

  assert.throws(
    () => policy.writeFile(
      'workspace/target.txt',
      'pwned'
    ),
    /ELOOP|ENOTDIR|symbolic link|too many levels/
  );

  policy.assertWrite = originalAssertWrite;

  assert.equal(
    fs.readFileSync(
      path.join(outside, 'target.txt'),
      'utf8'
    ),
    'protected'
  );

  fs.rmSync(dir, { recursive: true, force: true });
});

test('FileWorkspace writes through the policy-owned secure write path', async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'orient-secure-write-')
  );
  const workspace = new FileWorkspace({
    policy: makePolicy(root)
  });

  const target = await workspace.writeText(
    'nested/target.txt',
    'safe'
  );

  assert.equal(
    target,
    path.join(root, 'nested', 'target.txt')
  );
  assert.equal(
    fs.readFileSync(target, 'utf8'),
    'safe'
  );

  fs.rmSync(root, { recursive: true, force: true });
});


test('writeFile preserves existing regular-file permissions across atomic replacement', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-preserve-mode-'));
  try {
    const target = path.join(root, 'executable.sh');
    fs.writeFileSync(target, '#!/bin/sh\necho before\n', { mode: 0o755 });
    fs.chmodSync(target, 0o755);
    const policy = makePolicy(root);
    policy.writeFile('executable.sh', '#!/bin/sh\necho after\n');
    assert.equal(fs.statSync(target).mode & 0o777, 0o755);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ProjectModifier rollback preserves the original file permissions', async () => {
  const ProjectModifier = require('../../../../../src/core/agent/project-builder/modification/project-modifier');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-rollback-mode-'));
  try {
    const target = path.join(root, 'config.json');
    fs.writeFileSync(target, '{"state":"before"}\n');
    fs.chmodSync(target, 0o644);
    const workspace = new FileWorkspace({ policy: makePolicy(root) });
    const modifier = new ProjectModifier({ workspace });
    const modification = await modifier.apply({
      changes: [{
        action: 'update',
        path: 'config.json',
        content: '{"state":"after"}\n',
        expectedContentSha256: require('node:crypto').createHash('sha256').update('{"state":"before"}\n').digest('hex')
      }]
    }, {
      beforeMutation: async ({ snapshots }) => {
        assert.equal(snapshots[0].type, 'regular');
        assert.equal(snapshots[0].mode, 0o644);
      }
    });
    assert.equal(fs.statSync(target).mode & 0o777, 0o644);
    await modifier.rollback(modification);
    assert.equal(fs.readFileSync(target, 'utf8'), '{"state":"before"}\n');
    assert.equal(fs.statSync(target).mode & 0o777, 0o644);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
