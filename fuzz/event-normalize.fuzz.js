'use strict';

const EventRepository = require('../src/infrastructure/persistence/json/event.repository');

const repository = Object.create(EventRepository.prototype);

module.exports.fuzz = function fuzz(data) {
  let candidate;
  try {
    candidate = JSON.parse(data.toString('utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) return;
    throw error;
  }

  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return;

  const normalized = repository.normalize(candidate);
  if (!normalized || typeof normalized !== 'object' ||
      (candidate.id ? normalized.id !== candidate.id : typeof normalized.id !== 'string' || normalized.id.length === 0) ||
      !normalized.data || typeof normalized.data !== 'object' ||
      Array.isArray(normalized.data)) {
    throw new Error('Normalized event violated the event envelope contract');
  }

  const tenantA = { data: { tenantId: 'tenant-a' } };
  const tenantB = { data: { tenantId: 'tenant-b' } };
  const unscoped = { data: {} };
  if (repository.belongsToTenant(tenantA, 'tenant-a') !== true ||
      repository.belongsToTenant(tenantA, 'tenant-b') !== false ||
      repository.belongsToTenant(tenantB, 'tenant-a') !== false ||
      repository.belongsToTenant(unscoped, 'tenant-a') !== false ||
      repository.belongsToTenant(unscoped, 'local') !== true) {
    throw new Error('Event tenant predicate violated isolation invariants');
  }
};
