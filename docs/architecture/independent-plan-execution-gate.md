# Independent Plan Execution Gate

## Status

Implemented in the runtime execution path. This gate is an additional deterministic verification boundary; it does not replace tool authorization, capability governance, human approval, idempotency, or execution recovery.

## Security objective

Prevent a planner-provided `validation.valid === true` value from being sufficient to start tool execution. Before every plan revision enters the agent loop, ORIENT independently revalidates the plan, compares the normalized steps with the planner's validation output, binds the decision to the execution owner and revision, freezes the exact verified plan, and checkpoints a digest-bearing receipt.

## Trust boundaries and responsibilities

1. **Planner** proposes intent and steps. It is untrusted input and cannot authorize execution.
2. **PlanValidator (planner-side)** performs early structural validation. Its result is useful feedback, not execution authority.
3. **IndependentPlanExecutionGate** invokes a separately instantiated deterministic PlanValidator. It verifies the complete canonical plan, validates required execution/tenant/user/workspace identity, compares normalized steps, and produces an integrity-digested receipt.
4. **AgentExecutionCoordinator** is the enforcement point. It must obtain an allow receipt and persist the gate event/checkpoint before calling AgentLoop. Missing gate, verifier failure, identity failure, mismatch, or checkpoint failure prevents tool execution.
5. **AuthorizationService / capability governance / ToolRegistry** continue to authorize each actual tool operation. A plan-gate receipt is not a tool permission.
6. **ApprovalService** continues to provide owner approval for sensitive/high-risk operations. A gate receipt is not human consent.
7. **ExecutionContext and persistence** retain the event containing verifier identity, execution identity, plan revision, plan digest, decision, and receipt digest.

## Execution sequence

```text
Planner
  -> planner-side PlanValidator
  -> AgentExecutionCoordinator
  -> IndependentPlanExecutionGate
       -> canonicalize and size-bound plan
       -> independently validate
       -> compare normalized steps
       -> bind execution + tenant + user + workspace + agent + revision
       -> freeze verified plan
       -> produce SHA-256 receipt
  -> record plan.execution_gate.approved
  -> durable checkpoint
  -> set immutable plan on ExecutionContext
  -> AgentLoop
       -> per-tool authorization / capability checks
       -> human approval where policy requires it
       -> idempotency and tool execution
       -> observations and evidence
```

A rejection records `plan.execution_gate.rejected`, checkpoints that rejection, and throws before the agent loop. A checkpoint failure also stops execution. Every replan revision is independently verified again. A resumed plan is not trusted merely because it was previously accepted; it is reverified before resumed tool execution.

## Receipt contents

- schema version and verifier identity/version
- execution ID, tenant ID, user ID, workspace ID, agent ID
- plan revision
- SHA-256 digest of the complete canonical normalized plan
- verification timestamp and method
- allow decision
- SHA-256 digest of the receipt body

The receipt digest detects accidental or unauthorized modification when independently recomputed. It is not a digital signature and does not establish non-repudiation against an attacker who can rewrite both the event and its digest. Stronger tamper evidence requires an append-only/WORM event store or externally anchored signing key and key-rotation policy; that is deliberately not simulated here.

## Failure and concurrency behavior

- **Fail closed:** malformed plans, unsupported canonical values, excessive plan size, missing identity, upstream validation failure, independent rejection, normalized-step disagreement, invalid clock, or persistence/checkpoint failure block execution.
- **TOCTOU reduction:** the exact independently normalized plan is deeply frozen and is the object passed to the agent loop. The digest covers all plan fields, not just the step list.
- **Replay:** receipts are scoped to execution identity and plan revision. The coordinator does not accept a caller-supplied receipt; it generates a fresh receipt on each run/resume/replan. This implementation does not claim global nonce uniqueness or cross-database replay prevention.
- **Concurrent workers:** the gate itself is deterministic and stateless. Existing execution leases/claims remain responsible for single-worker ownership; the gate does not replace them.
- **Crash recovery:** the receipt event is checkpointed before tool execution. If the checkpoint fails, no tool runs. If the process crashes after the checkpoint, normal recovery may retry the plan, but the gate revalidates it and existing idempotency controls remain responsible for preventing duplicate side effects.
- **Retries/compensation:** the gate does not retry tools or compensate side effects. Those remain responsibilities of RetryExecutor, idempotency, recovery, and tool-specific compensation contracts.

## Deliberate scope boundaries

This gate verifies plan integrity and structural validity; it does not prove that the plan is semantically wise, safe in every external environment, or that a tool's result is truthful. It does not replace policy/risk classification, owner approval, authorization, sandboxing, capability allowlists, or external-world verification. The independent verifier currently uses a separate instance of the same deterministic PlanValidator implementation; algorithmic diversity and a separately maintained policy engine are not claimed.

## Verification strategy

Unit coverage exercises receipt integrity, identity binding, normalized-step disagreement, invalid upstream validation, deep immutability, canonical size bounds, malformed values, rejection before loop invocation, and revalidation of changed plan revisions. Repository CI remains the authoritative integration/regression signal; do not declare the change production-ready until required CI checks pass on the final commit.

## Related ORIENT constitution areas

This implementation extends rather than duplicates the existing rules in sections 16–25 (autonomy, orchestration, tools, risk, human control), 31–36 (observability, evaluation, replanning, retries, idempotency, recovery), 42–44 (security and data/filesystem safety), 47 and 50–58 (single source of truth, impact analysis, quality gates, tests, errors, APIs, languages, dependencies), and 68–78 and 83–87 (autonomy levels, collaboration, uncertainty, evidence/no fabrication, security override, decisions, definition of done, change/command/Git/documentation truth).

No existing constitution file is modified by this implementation.
