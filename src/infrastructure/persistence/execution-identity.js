'use strict';

const { isDeepStrictEqual } = require('node:util');

const IDENTITY_FIELDS = Object.freeze([
  'id',
  'executionId',
  'requestId',
  'goalId',
  'parentExecutionId',
  'executionVersion',
  'tenantId',
  'userId',
  'workspaceId'
]);
const METADATA_IDENTITY_FIELDS = Object.freeze(['tenantId', 'userId', 'workspaceId']);

function identityConflict(executionId, field) {
  const error = new Error(`Execution identity field "${field}" is immutable`);
  error.code = 'EXECUTION_IDENTITY_CONFLICT';
  error.status = 409;
  error.executionId = executionId;
  error.field = field;
  return error;
}

function assertExecutionIdentityUnchanged(current, patch) {
  for (const field of IDENTITY_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(patch, field) &&
        !isDeepStrictEqual(patch[field], current[field])) {
      throw identityConflict(current.executionId, field);
    }
  }

  if (patch.metadata && typeof patch.metadata === 'object' && !Array.isArray(patch.metadata)) {
    for (const field of METADATA_IDENTITY_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(patch.metadata, field)) continue;
      const currentValue = current.metadata?.[field] ?? current[field] ?? null;
      if (!isDeepStrictEqual(patch.metadata[field], currentValue)) {
        throw identityConflict(current.executionId, `metadata.${field}`);
      }
    }
  }
}

function preserveExecutionIdentity(current, patch) {
  const identity = {};
  for (const field of IDENTITY_FIELDS) identity[field] = current[field];
  identity.metadata = {
    ...(current.metadata && typeof current.metadata === 'object' ? current.metadata : {}),
    ...(patch.metadata && typeof patch.metadata === 'object' && !Array.isArray(patch.metadata)
      ? patch.metadata
      : {})
  };
  for (const field of METADATA_IDENTITY_FIELDS) {
    const value = current.metadata?.[field] ?? current[field];
    if (value !== undefined && value !== null) identity.metadata[field] = value;
  }
  return identity;
}

module.exports = { assertExecutionIdentityUnchanged, preserveExecutionIdentity };
