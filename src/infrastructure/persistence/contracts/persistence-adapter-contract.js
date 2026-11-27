'use strict';

const { resolvePersistenceCapabilities, verifyPersistenceAdapter } =
  require('../../../core/persistence/contracts/persistence-capability-validator');

function preflightPersistence({ mode = 'json', profile = 'local', enabledCapabilities = [] } = {}) {
  return resolvePersistenceCapabilities({
    adapter: mode,
    profile,
    enabledCapabilities
  });
}

function verifyInitializedPersistence({ mode = 'json', persistence, resolved } = {}) {
  return verifyPersistenceAdapter({
    adapter: mode,
    persistence,
    resolved
  });
}

module.exports = {
  preflightPersistence,
  verifyInitializedPersistence
};
