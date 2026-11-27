'use strict';

const WorkflowScheduler = require('../workflow/workflow-scheduler');
const AsyncWorkflowScheduler = require('../workflow/async-workflow-scheduler');
const MissionEventRecovery = require('../workflow/mission-event-recovery');
const DurableMissionEventSink = require('../workflow/durable-mission-event-sink');
const PostgresTenantQuotaRepository = require('../../infrastructure/persistence/postgres/postgres-tenant-quota-repository');
const WorkflowLeaseStore = require('../workflow/workflow-lease-store');
const TenantQuotaPolicy = require('../security/tenant-quota-policy');
const TenantQuotaService = require('../security/tenant-quota-service');

class RuntimeInfrastructureCoordinator {
  constructor({
    persistence = null,
    workflowScheduler = null,
    tenantId = 'local',
    maxConcurrent = 1,
    maxQueueDepth = 1000,
    workflowDispatchWindow = 2,
    workflowAgingQuantumMs = 30000,
    maxRetries = 2,
    leaseDurationMs = 30000,
    maxInputChars = 100000,
    maxToolInputChars = 50000,
    quotaPolicy = null,
    quotaService = null,
    deferStartup = false,
    workflowPersistenceEnabled = true
  } = {}) {
    this.persistence = persistence;
    this.deferStartup = deferStartup === true;
    this.started = false;
    this.startPromise = null;
    this.startFailure = null;
    this.recoveryStarted = false;
    this.ownsWorkflowScheduler = !workflowScheduler;
    this.tenantId = tenantId || 'local';
    this.workflowPersistenceEnabled = workflowPersistenceEnabled === true;

    this.workflowRepository = this.workflowPersistenceEnabled ? persistence?.workflows || null : null;
    this.missionEventSink = this.workflowPersistenceEnabled && persistence?.events?.appendMissionEvent
      ? new DurableMissionEventSink({
          eventRepository: persistence.events,
          workflowRepository: this.workflowRepository,
          tenantId: this.tenantId
        })
      : null;
    this.missionEventRecovery = this.workflowPersistenceEnabled && persistence?.events?.findByAggregateId &&
      this.workflowRepository?.findById && this.workflowRepository?.repair
      ? new MissionEventRecovery({
          eventRepository: persistence.events,
          workflowRepository: this.workflowRepository
        })
      : null;
    this.tenantQuotaRepository = this.workflowPersistenceEnabled
      ? persistence?.tenantQuotas ||
      (persistence?.isAsync && persistence?.db
        ? new PostgresTenantQuotaRepository(persistence.db)
        : null)
      : null;

    this.tenantQuotaPolicy =
      quotaPolicy instanceof TenantQuotaPolicy || (quotaPolicy && typeof quotaPolicy.toJSON === 'function')
        ? quotaPolicy
        : new TenantQuotaPolicy({
            maxConcurrent,
            maxQueued: maxQueueDepth,
            maxInputChars,
            maxToolInputChars,
            maxRetries
          });

    this.workflowScheduler =
      workflowScheduler ||
      (this.workflowPersistenceEnabled && persistence?.isAsync
        ? new AsyncWorkflowScheduler({
            maxConcurrent,
            maxQueueDepth,
            dispatchWindow: workflowDispatchWindow,
            agingQuantumMs: workflowAgingQuantumMs,
            maxRetries,
            leaseDurationMs,
            tenantId: this.tenantId,
            workflowRepository: this.workflowRepository,
            missionEventRecovery: this.missionEventRecovery,
            missionEventSink: this.missionEventSink,
            leaseRepository: persistence.workflowLeases,
            quotaRepository: this.tenantQuotaRepository,
            quotaPolicy: this.tenantQuotaPolicy
          })
        : new WorkflowScheduler({
            maxConcurrent,
            maxQueueDepth,
            maxRetries,
            leaseDurationMs,
            tenantId: this.tenantId,
            workflowRepository: this.workflowRepository,
            leaseStore: this.workflowPersistenceEnabled && persistence?.workflowLeases
              ? new WorkflowLeaseStore({
                  repository: persistence.workflowLeases,
                  tenantId: this.tenantId
                })
              : null
          }));

    if (this.workflowScheduler?.async) {
      this.workflowScheduler.missionEventRecovery = this.missionEventRecovery;
      this.workflowScheduler.missionEventSink = this.missionEventSink;
      this.workflowScheduler.quotaPolicy = this.tenantQuotaPolicy;
      this.workflowScheduler.quotaRepository = this.tenantQuotaRepository;
    }

    this.tenantQuotaService =
      quotaService ||
      new TenantQuotaService({
        tenantId: this.tenantId,
        policy: this.tenantQuotaPolicy,
        scheduler: this.workflowScheduler
      });

    if (this.tenantQuotaService.scheduler !== this.workflowScheduler) {
      this.tenantQuotaService.scheduler = this.workflowScheduler;
    }

    this.quotaReady = this.deferStartup
      ? Promise.resolve()
      : this.tenantQuotaRepository?.ensureTenant
        ? this.tenantQuotaRepository.ensureTenant(this.tenantId, this.tenantQuotaPolicy)
        : Promise.resolve();

    this.recoveryReady = this.deferStartup
      ? Promise.resolve(0)
      : !workflowScheduler && !persistence?.isAsync && this.workflowRepository?.findAll
        ? Promise.resolve(this.workflowScheduler.recoverPersisted())
        : Promise.resolve(0);

    if (!this.deferStartup) this.started = true;
  }

  start() {
    if (this.startFailure) return Promise.reject(this.startFailure);
    if (this.started) return Promise.resolve(this.recoveryReady).then(recovered => ({ started: true, recovered }));
    if (this.startPromise) return this.startPromise;

    const operation = (async () => {
      // Tenant quota initialization is an idempotent upsert. A failure before
      // workflow recovery begins is therefore safe to retry on this coordinator.
      this.quotaReady = this.tenantQuotaRepository?.ensureTenant
        ? Promise.resolve().then(() => this.tenantQuotaRepository.ensureTenant(this.tenantId, this.tenantQuotaPolicy))
        : Promise.resolve();
      await this.quotaReady;

      const shouldRecoverPersistedWorkflows =
        this.ownsWorkflowScheduler && !this.workflowScheduler?.async && this.workflowRepository?.findAll;

      if (!shouldRecoverPersistedWorkflows) {
        this.recoveryReady = Promise.resolve(0);
        this.started = true;
        return { started: true, recovered: 0 };
      }

      // Recovery may mutate durable workflow state and in-memory scheduler
      // queues incrementally. Once entered, an unknown partial failure cannot
      // be retried safely on this coordinator.
      this.recoveryStarted = true;
      try {
        this.recoveryReady = Promise.resolve().then(() => this.workflowScheduler.recoverPersisted());
        const recovered = await this.recoveryReady;
        this.started = true;
        return { started: true, recovered };
      } catch (cause) {
        const error = new Error(
          'Workflow persistence recovery failed after partial side effects. ' +
          'This coordinator is permanently failed and cannot be restarted. ' +
          'Discard the current Runtime and create a new Runtime; restart the application process ' +
          'if safe Runtime replacement is unavailable.'
        );
        error.name = 'PersistenceRecoveryPartialFailure';
        error.code = 'PERSISTENCE_RECOVERY_PARTIAL_FAILURE';
        error.phase = 'runtime-startup';
        error.retryable = false;
        error.tenantId = this.tenantId;
        error.cause = cause;
        this.startFailure = error;
        throw error;
      }
    })();

    this.startPromise = operation;
    operation.catch(() => {
      // Only failures before workflow recovery starts are retryable. Keep the
      // rejected operation and terminal diagnostic after a recovery failure.
      if (this.startPromise === operation && !this.startFailure) {
        this.startPromise = null;
      }
    });
    return operation;
  }

  shutdown(options = {}) {
    return this.workflowScheduler?.shutdown
      ? this.workflowScheduler.shutdown(options)
      : null;
  }
}

module.exports = RuntimeInfrastructureCoordinator;
