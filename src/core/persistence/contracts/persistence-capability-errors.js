'use strict';

class PersistenceCapabilityError extends Error {
  constructor({
    code, message, adapter, profile, phase, capability = null,
    guarantee = null, expected = null, actual = null, retryable = false
  }) {
    super(message);
    this.name = 'PersistenceCapabilityError';
    this.code = code;
    this.adapter = adapter || null;
    this.profile = profile || null;
    this.phase = phase || 'preflight';
    this.capability = capability;
    this.guarantee = guarantee;
    this.expected = expected;
    this.actual = actual;
    this.retryable = retryable === true;
  }

  toDiagnostic() {
    return Object.freeze({
      code: this.code,
      message: this.message,
      adapter: this.adapter,
      profile: this.profile,
      phase: this.phase,
      capability: this.capability,
      guarantee: this.guarantee,
      expected: this.expected,
      actual: this.actual,
      retryable: this.retryable
    });
  }
}

module.exports = PersistenceCapabilityError;
