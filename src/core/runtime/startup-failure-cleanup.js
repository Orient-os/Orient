'use strict';

async function cleanupStartupFailure({
  eventStoreSubscriber = null,
  runtime,
  persistenceRuntime = null,
  onCleanupError = () => {}
} = {}) {
  const failures = [];
  const attempt = async (stage, operation) => {
    try {
      await operation();
    } catch (error) {
      failures.push({ stage, error });
      try {
        onCleanupError(stage, error);
      } catch (_) {
        // Cleanup diagnostics must not prevent later cleanup stages.
      }
    }
  };

  if (eventStoreSubscriber && typeof eventStoreSubscriber.stop === 'function') {
    await attempt('observations', () => eventStoreSubscriber.stop());
  }
  if (runtime && typeof runtime.shutdown === 'function') {
    await attempt('runtime', () => runtime.shutdown({ cancelQueued: false }));
  }
  if (typeof persistenceRuntime?.close === 'function') {
    await attempt('persistence', () => persistenceRuntime.close());
  }
  return failures;
}

module.exports = cleanupStartupFailure;
