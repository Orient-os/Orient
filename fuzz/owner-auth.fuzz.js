'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const OwnerIdentityService = require('../src/core/security/owner-identity-service');

const SESSION_TTL_MS = 30 * 60 * 1000;
const VALID_TOKEN = 'orient-fuzz-owner-session-token-00000000000000000000';
const VALID_CSRF = 'orient-fuzz-csrf-sentinel';
const SESSION_ID = '11111111-1111-4111-8111-111111111111';
let now = 1_000_000;

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-owner-identity-fuzz-'));
const auth = new OwnerIdentityService({
  stateFile: path.join(directory, 'owner.json'),
  bootstrapPassword: 'orient-fuzz-owner-bootstrap-password-2026!',
  sessionTtlMs: SESSION_TTL_MS,
  now: () => now
});

// This target isolates session/token invariants. Persistence and crash semantics
// remain covered by the deterministic filesystem and restart regression suites.
auth.save = () => {};

process.on('exit', () => {
  try { fs.rmSync(directory, { recursive: true, force: true }); } catch {}
});

const tokenDigest = crypto.createHash('sha256').update(VALID_TOKEN).digest('hex');

function seedActiveSession() {
  auth.sessions.clear();
  auth.sessions.set(tokenDigest, {
    csrfToken: VALID_CSRF,
    expiresAt: now + SESSION_TTL_MS,
    sessionId: SESSION_ID
  });
}

module.exports.fuzz = function fuzz(data) {
  now = 1_000_000;
  seedActiveSession();

  const separator = data.indexOf(0x7c);
  const tokenInput = (separator < 0 ? data : data.subarray(0, separator)).toString('utf8');
  const csrfInput = separator < 0 ? '' : data.subarray(separator + 1).toString('utf8');

  const authenticated = auth.authenticate(tokenInput);
  if (tokenInput === VALID_TOKEN) {
    if (!authenticated || authenticated.sessionId !== SESSION_ID) {
      throw new Error('Valid owner token did not resolve to its exact session');
    }
  } else if (authenticated !== null) {
    throw new Error('Unknown token authenticated as owner');
  }

  const csrfAccepted = auth.verifyCsrf(authenticated, csrfInput);
  if (csrfAccepted !== (tokenInput === VALID_TOKEN && csrfInput === VALID_CSRF)) {
    throw new Error('CSRF verification accepted a token outside its authenticated session');
  }

  if (!auth.isActiveSession(SESSION_ID)) throw new Error('Non-expired owner session is inactive');

  const loggedOut = auth.logout(tokenInput);
  if (loggedOut !== (tokenInput === VALID_TOKEN)) throw new Error('Logout affected a non-matching token');

  const remaining = auth.authenticate(VALID_TOKEN);
  if (tokenInput === VALID_TOKEN ? remaining !== null
    : !remaining || remaining.sessionId !== SESSION_ID) {
    throw new Error('Logout did not preserve exact session ownership');
  }

  now += SESSION_TTL_MS;
  seedActiveSession();
  now += SESSION_TTL_MS;
  if (auth.authenticate(VALID_TOKEN) !== null || auth.isActiveSession(SESSION_ID)) {
    throw new Error('Session remained active at or beyond its expiry boundary');
  }
};
