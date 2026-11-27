'use strict';

const {
  PERSISTENCE_CONTRACT_VERSION,
  CAPABILITY_STATUS,
  CORE_GUARANTEES
} = require('./persistence-capability.constants');
const PROFILE_REQUIREMENTS = require('./persistence-profile-requirements');
const { getPersistenceManifest } = require('../../../infrastructure/persistence/manifests/persistence-manifest-registry');
const PersistenceCapabilityError = require('./persistence-capability-errors');

function fail(code, message, details = {}) {
  throw new PersistenceCapabilityError({ code, message, ...details });
}

function validateManifestShape(manifest, profile) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) ||
      typeof manifest.adapter !== 'string' ||
      typeof manifest.contractVersion !== 'string' ||
      !Array.isArray(manifest.guarantees) ||
      !manifest.capabilities || typeof manifest.capabilities !== 'object' ||
      Array.isArray(manifest.capabilities)) {
    fail('PERSISTENCE_MANIFEST_INVALID', 'Persistence manifest has an invalid shape', {
      adapter: manifest?.adapter, profile, phase: 'preflight', expected: 'valid-manifest'
    });
  }

  if (manifest.contractVersion !== PERSISTENCE_CONTRACT_VERSION) {
    fail('PERSISTENCE_CONTRACT_VERSION_UNSUPPORTED', 'Persistence contract version is not supported', {
      adapter: manifest.adapter, profile, phase: 'preflight',
      expected: PERSISTENCE_CONTRACT_VERSION, actual: manifest.contractVersion
    });
  }

  if (new Set(manifest.guarantees).size !== manifest.guarantees.length ||
      manifest.guarantees.some(value => typeof value !== 'string' || !value)) {
    fail('PERSISTENCE_MANIFEST_INVALID', 'Persistence manifest contains invalid guarantee declarations', {
      adapter: manifest.adapter, profile, phase: 'preflight', expected: 'unique-non-empty-guarantees'
    });
  }

  for (const [name, entry] of Object.entries(manifest.capabilities)) {
    if (!entry || !Object.values(CAPABILITY_STATUS).includes(entry.status) ||
        !Array.isArray(entry.guarantees) || !Array.isArray(entry.interfaces)) {
      fail('PERSISTENCE_MANIFEST_INVALID', 'Persistence capability declaration is invalid', {
        adapter: manifest.adapter, profile, phase: 'preflight', capability: name
      });
    }
  }
}

function resolvePersistenceCapabilities({ adapter, profile = 'local', enabledCapabilities = [] } = {}) {
  const manifest = getPersistenceManifest(adapter);
  const requirements = PROFILE_REQUIREMENTS[profile];

  if (!manifest) {
    fail('PERSISTENCE_MANIFEST_INVALID', 'No trusted persistence manifest is registered for this adapter', {
      adapter, profile, phase: 'preflight', expected: 'registered-adapter'
    });
  }
  if (!requirements) {
    fail('PERSISTENCE_PROFILE_INCOMPATIBLE', 'Persistence profile is not registered', {
      adapter, profile, phase: 'preflight', expected: Object.keys(PROFILE_REQUIREMENTS)
    });
  }
  if (!Array.isArray(enabledCapabilities) ||
      enabledCapabilities.some(value => typeof value !== 'string' || !value)) {
    fail('PERSISTENCE_MANIFEST_INVALID', 'Enabled persistence capabilities must be a list of names', {
      adapter, profile, phase: 'preflight', expected: 'array-of-capability-names'
    });
  }

  validateManifestShape(manifest, profile);
  if (manifest.adapter !== adapter) {
    fail('PERSISTENCE_MANIFEST_INVALID', 'Trusted manifest adapter identity does not match the selected adapter', {
      adapter, profile, phase: 'preflight', expected: adapter, actual: manifest.adapter
    });
  }

  for (const requested of enabledCapabilities) {
    if (!Object.prototype.hasOwnProperty.call(requirements.optionalCapabilities, requested)) {
      fail('PERSISTENCE_CAPABILITY_MISSING', 'Requested persistence capability is not defined by this profile', {
        adapter, profile, phase: 'preflight', capability: requested,
        expected: Object.keys(requirements.optionalCapabilities), actual: requested
      });
    }
  }

  for (const guarantee of requirements.requiredGuarantees) {
    if (!manifest.guarantees.includes(guarantee)) {
      fail('PERSISTENCE_GUARANTEE_UNSATISFIED', 'A required persistence guarantee is not declared', {
        adapter, profile, phase: 'preflight', guarantee,
        expected: 'declared-and-proven', actual: 'missing'
      });
    }
  }

  const resolved = {};
  for (const [name, policy] of Object.entries(requirements.optionalCapabilities)) {
    const declaration = manifest.capabilities[name] || {
      status: CAPABILITY_STATUS.UNSUPPORTED, guarantees: [], interfaces: []
    };
    const requested = enabledCapabilities.includes(name);

    if (requested && declaration.status === CAPABILITY_STATUS.UNSUPPORTED) {
      fail('PERSISTENCE_CAPABILITY_MISSING', 'An enabled persistence capability is unsupported', {
        adapter, profile, phase: 'preflight', capability: name,
        expected: CAPABILITY_STATUS.SUPPORTED, actual: declaration.status
      });
    }

    if (requested && declaration.status === CAPABILITY_STATUS.DEGRADED && !policy.degradationAllowed) {
      fail('PERSISTENCE_GUARANTEE_UNSATISFIED', 'The profile does not permit this capability to run degraded', {
        adapter, profile, phase: 'preflight', capability: name,
        expected: CAPABILITY_STATUS.SUPPORTED, actual: declaration.status
      });
    }

    resolved[name] = Object.freeze({
      status: declaration.status,
      enabled: declaration.status === CAPABILITY_STATUS.SUPPORTED ||
        (requested && declaration.status === CAPABILITY_STATUS.DEGRADED),
      guarantees: declaration.guarantees,
      interfaces: declaration.interfaces
    });
  }

  return Object.freeze({
    adapter,
    profile,
    contractVersion: manifest.contractVersion,
    guarantees: manifest.guarantees,
    capabilities: Object.freeze(resolved)
  });
}

function verifyPersistenceAdapter({ adapter, persistence, resolved, phase = 'post-initialization' } = {}) {
  const requiredInterfaces = {
    executions: ['findById', 'insert', 'update'],
    events: ['append'],
    idempotency: ['begin', 'complete', 'fail']
  };

  for (const [repositoryName, methods] of Object.entries(requiredInterfaces)) {
    const repository = persistence?.[repositoryName];
    for (const method of methods) {
      if (typeof repository?.[method] !== 'function') {
        fail('PERSISTENCE_CAPABILITY_MISMATCH', 'Initialized persistence adapter does not implement its required runtime interface', {
          adapter, profile: resolved?.profile, phase,
          capability: repositoryName, guarantee: method,
          expected: 'function', actual: typeof repository?.[method]
        });
      }
    }
  }

  for (const [name, entry] of Object.entries(resolved?.capabilities || {})) {
    if (!entry.enabled) continue;
    for (const interfaceName of entry.interfaces || []) {
      const [repositoryName, method] = interfaceName.split('.');
      if (typeof persistence?.[repositoryName]?.[method] !== 'function') {
        fail('PERSISTENCE_CAPABILITY_MISMATCH', 'Enabled persistence capability is missing a required runtime interface', {
          adapter, profile: resolved.profile, phase,
          capability: name, guarantee: interfaceName,
          expected: 'function', actual: typeof persistence?.[repositoryName]?.[method]
        });
      }
    }
  }

  return Object.freeze({ ...resolved, verified: true });
}

function getCoreGuarantees() {
  return [...CORE_GUARANTEES];
}

module.exports = { resolvePersistenceCapabilities, verifyPersistenceAdapter, getCoreGuarantees };
