# Gitleaks reviewed baseline

This file documents the exact historical Gitleaks fingerprints listed in the
repository-root `.gitleaksignore`. Entries are commit-specific; no rule,
directory, filename, or secret pattern is broadly allowlisted.

## Reviewed findings

| Fingerprint location | Classification | Rationale |
| --- | --- | --- |
| `.github/workflows/sonarcloud-pr-diagnostics.yml:37` at `4fc766b0516b0a96c2d32e30e32a2c75de583dfe` | Public project identifier | `SONAR_PROJECT_KEY` is the public SonarCloud project slug, not an authentication token. |
| `test/unit/application/agent/agent.service.task-create.test.js:596` at `8e5f0fb3accddc8765b22ba510f1f46d9a070d51` | Test idempotency fixture | A fixed, non-authentication idempotency key used to test owner isolation. |
| `test/integration/http-owner-sse-reconnect.test.js:11` at `b43f7c2a68f0571921838db74f085c1fd6512fec` and `eb4c5436d8a9258c8e58ea67f097a7045bd69f4b` | Local test credential | A hard-coded credential used only to initialize an isolated test OwnerAuthService; it is not sourced from or used against a deployed account. |
| `test/integration/high-risk-failure-recovery-mission.test.js:348` at `b5b1c7f034278f625577229ede36dcebc7043c6b` | Local test credential | A test-only password passed to an isolated OwnerAuthService fixture. |
| `test/unit/interfaces/http/owner-console.test.js:9` at `43e6f74b1d5c180b3742f234448ad38a3c6c1c2b` and `bcb556d2154689b97bfcf4d156877199abd49bdf` | Local test credential | A test-only password used by the owner-console unit-test server fixture. |

## Review policy

- These entries suppress only the exact fingerprints emitted by the pinned
  Gitleaks scanner during the reviewed full-history scan.
- New commits, changed lines, different rules, and different fingerprints
  remain detectable.
- Do not add a fingerprint until the finding has been inspected and classified.
- If any fixture credential is ever reused outside isolated tests, remove the
  exception and rotate the affected credential immediately.
- This baseline is not a substitute for revoking a real exposed credential.
