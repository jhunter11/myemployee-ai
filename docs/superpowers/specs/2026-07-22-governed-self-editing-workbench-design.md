# Governed Self-Editing Workbench Design

**Date:** 2026-07-22
**Status:** Proposed production design; implementation is not authorized by this document
**Roadmap relationship:** Defines Tasks 26–32 of
`docs/superpowers/plans/2026-07-22-production-reliability-self-management.md` and consumes, but does
not weaken, `docs/superpowers/specs/2026-07-22-reliability-spine-design.md`
**Primary surface:** Agent Workbench, human-rooted `agency-developer` workflow
**Decision:** Jarvis may prepare and evaluate a bounded repository change in an isolated workspace.
Only the local operator may authorize an exact attempt, an exact host execution, or application of
an exact frozen candidate to a dedicated local branch. This workflow never approves itself, merges,
pushes, opens a pull request, changes a protected branch, signs release authority, installs, rolls
back production, or activates a release.

## 1. Outcome

The operator can turn a durable Agent Workbench conversation or a persisted ToolSmith observation
into a governed engineering change request, follow its progress, inspect its exact patch and retained
test/review evidence, and approve or reject one fingerprint. If approved, a separate narrow branch
applicator may create one deterministic commit on one dedicated `codex/` branch. It then emits an
inert release handoff for the normal protected review and release path.

The shortest successful path is:

```text
operator conversation or persisted ToolSmith proposal
  -> server-owned intake preview and exact confirmation
  -> architecture plan and bounded attempt approval
  -> isolated Code Blue test-first authoring
  -> independent read-only Code Red review
  -> fixed Release Verifier gate on a clean candidate commit
  -> immutable candidate/evidence package
  -> exact dashboard application approval
  -> narrow local branch application
  -> inert release handoff
  -> separate human-owned protected review/release workflow
```

The production claim is deliberately narrow. “Self-editing” means authoring a candidate under a
fixed authority ceiling. It does not mean self-authorizing, self-merging, self-releasing, or
self-repairing production.

## 2. Repository truth this design preserves

This design starts from current implementation facts rather than aspirational names:

- Page Studio stores and renders page configuration. Its contracts and page service are data-only;
  it is not a repository editor or authority surface.
- Agent Workbench already has server-owned exact profile routing, persistent conversations, and
  compare-and-set conversation updates. It is the correct human-rooted surface.
- The developer catalog already names Architect, Code Blue, Code Red, and Release Verifier stages,
  but those crew entries are profile-only today. No executable engineering lifecycle is implied.
- ToolSmith analysis is observational. The reliability roadmap makes its proposals durable while
  explicitly denying queue, worker, blueprint, subprocess, filesystem, network, Git, and pull-request
  authority.
- Blueprint definitions have a durable lifecycle and static implementation registry, but runtime
  execution is explicitly unimplemented and is not composed into the gateway. This workbench does
  not use a blueprint label to smuggle in execution.
- The queue contract names `project_task`, while the current automation cycle claims only
  `automation`. The workbench does not enqueue engineering work into that cycle until a dedicated,
  tested engineering lane and lease protocol exist.
- Existing generic action proposals are not an acceptable branch-application contract. In
  particular, dashboard copy that says approval has no runtime effect cannot back an approval path
  that mutates a branch. The workbench has a dedicated, truthful effect contract.
- Access authorization is the intersection of all authority layers. A partially bootstrapped
  profile is not execution-ready merely because one blueprint grant exists.
- The shared reliability canonical protocol now lives in `src/reliability/canonical.ts` and
  `src/reliability/identities.ts`. This design extends that protocol; it does not introduce delimiter
  hashes, permissive JSON, caller-defined identity fields, or a second canonicalizer.

## 3. Operator intent

The operator wants to:

1. discuss a repository problem with the Developer in an ordinary durable conversation;
2. deliberately turn one exact message or one persisted ToolSmith proposal into a change request;
3. know the immutable base revision, path ceiling, tool ceiling, model budget, test plan, and expected
   host commands before authoring begins;
4. see test-first evidence, the bounded diff, independent findings, the fixed release-gate result,
   usage, cost coverage, and any degraded or missing evidence;
5. approve, reject, cancel, retry, or request revision without giving the model approval authority;
6. apply an approved candidate only to a dedicated local branch without disturbing the operator's
   current working tree, index, branch, or uncommitted changes;
7. hand the branch and evidence to the existing protected review/release process; and
8. exactly revert the dedicated branch application when it has not advanced, while retaining all
   evidence and without pretending that a local revert rolls back a deployed release.

## 4. Non-goals and permanent V1 denials

The workbench does not:

- turn Page Studio into a code editor, prompt-to-app builder, terminal, or approval surface;
- let ToolSmith write code, create a change request automatically, enqueue work, execute tools, or
  transition a blueprint;
- treat chat, Telegram, notification delivery, model output, reviewer verdict, or test output as an
  approval;
- let an agent, model, reviewer, verifier, workspace process, ToolSmith process, or branch applicator
  mint an operator decision;
- edit the live operator worktree, its index, its checked-out ref, or its uncommitted files;
- run a broad shell, accept command text, install dependencies, fetch from the network, execute Git
  hooks, use submodules or LFS filters, or inherit the operator's environment;
- modify the workbench's own authority ceiling, sandbox, approval verifier, branch applicator,
  release grader, trust roots, secret subsystem, runtime installer, protected workflows, or evidence
  verifier from inside this lane;
- change package-manager manifests, lockfiles, executable bits, symlinks, Git metadata, generated
  binaries, or migrations in V1 unless a later externally authored policy version adds a separate
  lane and its own acceptance evidence;
- merge, rebase, force-update, delete a branch, push, create a pull request, approve CI, sign a
  release intent, call `launchctl`, install files, activate a schedule, or deploy; or
- claim production rollback. Once a candidate has left this local branch lane, remediation is a new
  governed request plus the independent reliability release/rollback protocol.

An operator may perform later Git hosting and release actions outside this workflow. Those actions
have separate principals, receipts, approvals, and policy.

## 5. Trust and process boundaries

### 5.1 Principals and capabilities

| Principal/process         | May                                                                                                                                                                             | Must not                                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Local operator UI         | Create an intake from an authorized source; confirm a preview; approve/reject exact attempt, host-exec, branch-application, and rollback fingerprints; cancel; inspect evidence | Supply repository roots, tenant scopes, arbitrary paths, commands, environment, model IDs, branch names, approval receipts, or release authority |
| Dashboard gateway         | Authenticate local user presence; derive scope from server registrations; validate strict requests; construct/recompute previews; persist one-use decisions with CAS            | Treat loopback alone, a chat message, or a model result as approval; execute author tools; select a wider scope from request text                |
| Engineering coordinator   | Advance the request state machine; issue short leases; construct exact plans; dispatch fixed crew stages; freeze evidence                                                       | Approve, mutate protected policy, access secrets, execute a general shell, update Git refs, merge, push, or release                              |
| Architect session         | Produce a bounded plan from registered repository context and operator intent                                                                                                   | Edit files, run host commands, approve, select paths/tools/models outside the server ceiling, or alter the ceiling                               |
| Code Blue author session  | Read bounded source; use typed search/read/patch tools inside one isolated workspace; request exact host executions                                                             | Access the live worktree, network, secrets, arbitrary filesystem, `.git`, approvals, refs, reviewer session, or release controls                 |
| Code Red reviewer session | Read immutable base, patch, plan, and evidence; emit bounded findings and a verdict                                                                                             | Write the workspace, share the author's continuation, run arbitrary commands, approve, update evidence, or release                               |
| Release Verifier          | Reproduce the fixed registered gate on a clean candidate commit and emit deterministic evidence                                                                                 | Use a model, change the candidate, waive a check, approve, merge, push, install, or release                                                      |
| Workspace sandbox process | Materialize one registered base and candidate; expose only the sandbox API                                                                                                      | See host home, tenant stores, Keychain, agent DB, control DB, sockets, network, live worktree, or Git refs                                       |
| Host-exec broker          | Execute one approved, registered executable with exact arguments, cwd, sanitized environment, sandbox, and bounds; emit a receipt                                               | Accept shell text/wildcards, infer an executable, broaden filesystem access, reuse an approval, or update repository refs                        |
| Branch applicator         | Import one precomputed commit object and CAS-update one derived `refs/heads/codex/ecr-…` ref; emit journal/receipt                                                              | Read model text, edit a worktree, update HEAD/index/protected refs, merge/rebase/push, call hooks, or release                                    |
| Reliability release path  | Independently review, attest, install, audit, activate, and roll back under the reliability-spine rules                                                                         | Accept a workbench handoff as release approval or live attestation                                                                               |

The author, reviewer, verifier, approval writer, branch applicator, and release path are different
capability compositions even if they run under the same local OS account. Import-boundary tests and
constructor interfaces enforce the separation; a shared account is not described as adversarial OS
isolation.

### 5.2 Three independent execution controls

Filesystem sandboxing, tool authorization, and host-execution approval are independent layers. A
request is executable only under their strict intersection:

```text
effective capability
  = request authority ceiling
  ∩ exact profile grant
  ∩ registered tool allowlist
  ∩ canonical path policy
  ∩ filesystem/process sandbox policy
  ∩ exact one-use host-exec approval, when a host process is involved
  ∩ active agency posture and current policy versions
```

No layer can turn a denial in another layer into permission:

- Tool denial is not modeled as “filesystem read-only.” A denied network, process, Git, secret, or
  approval capability remains denied even when the sandbox could technically read a related path.
- Filesystem containment does not make an arbitrary executable safe.
- Host-exec approval does not widen sandbox mounts, tool grants, or path ceilings.
- A token such as `shell`, `terminal`, `exec`, `bash`, `sh -c`, `npm exec`, or a caller-supplied
  interpreter is never a shortcut around path containment or executable registration.
- If the sandbox implementation, executable digest, approval UI, posture check, or any required
  layer is unavailable, the result is `unsupported` or `denied`; there is no unsandboxed fallback.

### 5.3 Authority ceiling

The server resolves an immutable `EngineeringAuthorityCeilingV1` from a protected repository
registration. Request text may describe an outcome but cannot choose or expand the ceiling. The
ceiling fixes:

- one repository registration and base-ref policy;
- one server-owned allowed-path-set revision and digest;
- immutable-control and secret-path deny sets;
- allowed file types, modes, counts, byte/line limits, and generated-output directories;
- typed internal tool IDs and exact executable registrations;
- model route ceiling and hard usage/cost limits;
- test and release-gate registrations;
- branch namespace and protected-ref deny set; and
- sandbox, evidence, approval, retention, and recovery policy versions.

A candidate that edits its own ceiling, a file used to grade it, or any authority-bearing path is
invalid before review. A review statement that the change is harmless cannot override this
deterministic rejection.

## 6. Canonical protocol and deterministic identity

### 6.1 Required implementation primitive

All bodies are strict versioned TypeScript DTOs decoded with unknown-field rejection. Canonical
evidence uses the implemented reliability functions:

- `canonicalizeJson()` for recursively key-sorted UTF-8 JSON with no insignificant whitespace;
- `assertCanonicalJson()` for duplicate/noncanonical input rejection;
- `canonicalUtcTimestamp()` for real UTC RFC 3339 instants; and
- `domainSeparatedSha256()` for four-byte, big-endian length-prefixed domain and field hashing.

Canonical body digests use a schema-bound helper that first applies the named strict versioned
parser, then hashes the UTF-8 bytes returned by `canonicalizeJson()`. There is intentionally no
generic `unknown -> SHA-256` helper: a caller must supply the exact schema so unknown fields cannot
silently become authenticated evidence.

Every domain tag matches the existing bounded `name:vN` grammar. Every ID is 64 lowercase hex
characters. IDs never use delimiter concatenation, raw request text, secrets, lease tokens,
timestamps that are not semantic identity, or JSON generated by another canonicalizer. New factories
belong in `src/reliability/identities.ts` with golden fixtures.

Every `*BodySha256` is computed from a separately declared strict `*CoreV1` DTO that omits its own
digest, derived ID/fingerprint, mutable state/version pointers, and any later receipt. The combined
interfaces below show the stored projection for readability; implementations must not hash them
wholesale. There is no self-referential digest. Timestamps appear in a core only when the instant is
part of the approved/evidenced fact, not merely database metadata.

In the formulas below, `H(tag, fields…)` means `domainSeparatedSha256(tag, fields)` in the exact
listed order, and `J(body)` means SHA-256 of `canonicalizeJson(StrictBodySchema.parse(body))` using
the declared schema for that body.

### 6.2 Identity formulas

```text
engineeringIntentId = H(
  "engineering-intent:v1",
  sourceKind,
  sourceRecordId,
  sourceRecordVersion,
  operatorPrincipalId,
  intentBodySha256
)

engineeringChangeRequestId = H(
  "engineering-change-request:v1",
  engineeringIntentId,
  repositoryRegistrationId,
  repositoryRegistrationRevision,
  baseRevision,
  allowedPathSetSha256,
  authorityCeilingSha256,
  engineeringPolicyVersion
)

engineeringPlanFingerprint = H(
  "engineering-change-plan:v1",
  engineeringChangeRequestId,
  planRevision,
  planBodySha256
)

engineeringAttemptId = H(
  "engineering-change-attempt:v1",
  engineeringChangeRequestId,
  engineeringPlanFingerprint,
  attemptOrdinal
)

engineeringWorkspaceId = H(
  "engineering-workspace:v1",
  engineeringAttemptId,
  baseRevision,
  workspacePolicySha256
)

attemptApprovalRequestId = H(
  "engineering-attempt-approval:v1",
  engineeringChangeRequestId,
  expectedRequestVersion,
  engineeringPlanFingerprint
)

attemptApprovalFingerprint = H(
  "engineering-attempt-fingerprint:v1",
  attemptApprovalRequestId,
  planBodySha256,
  baseRevision,
  authorityCeilingSha256,
  executionPolicySha256
)

attemptApprovalDecisionId = H(
  "engineering-attempt-decision:v1",
  attemptApprovalRequestId,
  attemptApprovalFingerprint,
  operatorPrincipalId,
  decision
)

hostExecutionRequestId = H(
  "engineering-host-exec:v1",
  engineeringAttemptId,
  stage,
  executionOrdinal,
  hostExecutionPlanBodySha256
)

hostExecutionApprovalFingerprint = H(
  "engineering-host-exec-fingerprint:v1",
  hostExecutionRequestId,
  expectedRequestVersion,
  hostExecutionPlanBodySha256
)

hostExecutionDecisionId = H(
  "engineering-host-exec-decision:v1",
  hostExecutionRequestId,
  hostExecutionApprovalFingerprint,
  expectedRequestVersion,
  operatorPrincipalId,
  decision
)

approvalConsumptionId = H(
  "engineering-approval-consumption:v1",
  approvalDecisionId,
  effectKind,
  effectPlanFingerprint,
  expectedRequestVersion
)

patchCandidateId = H(
  "engineering-patch:v1",
  engineeringAttemptId,
  baseRevision,
  candidateCommitSha,
  candidateTreeSha,
  patchBlobSha256,
  changedPathManifestSha256
)

testEvidenceId = H(
  "engineering-test-evidence:v1",
  engineeringAttemptId,
  engineeringPlanFingerprint,
  phase,
  testedTreeSha,
  suiteRegistrationId,
  hostExecutionReceiptSha256,
  resultBodySha256
)

reviewEvidenceId = H(
  "engineering-review-evidence:v1",
  patchCandidateId,
  reviewerProfileRevision,
  reviewOrdinal,
  reviewBodySha256
)

releaseGateEvidenceId = H(
  "engineering-release-gate-evidence:v1",
  patchCandidateId,
  releaseGateRevision,
  hostExecutionReceiptSha256,
  resultBodySha256
)

branchApplicationApprovalRequestId = H(
  "engineering-branch-application-approval:v1",
  engineeringChangeRequestId,
  expectedRequestVersion,
  applicationPlanFingerprint
)

branchApplicationApprovalFingerprint = H(
  "engineering-branch-application-fingerprint:v1",
  branchApplicationApprovalRequestId,
  applicationPlanBodySha256,
  frozenEvidenceManifestSha256,
  expectedPriorStateSha256
)

branchApplicationDecisionId = H(
  "engineering-branch-application-decision:v1",
  branchApplicationApprovalRequestId,
  branchApplicationApprovalFingerprint,
  operatorPrincipalId,
  decision
)

branchApplicationReceiptId = H(
  "engineering-branch-application-receipt:v1",
  branchApplicationDecisionId,
  expectedPriorHead,
  appliedCommitSha,
  applicationManifestSha256
)

releaseHandoffId = H(
  "engineering-release-handoff:v1",
  branchApplicationReceiptId,
  handoffBodySha256
)

branchRollbackApprovalRequestId = H(
  "engineering-branch-rollback-approval:v1",
  branchApplicationReceiptId,
  expectedRequestVersion,
  rollbackPlanFingerprint
)

rollbackApprovalFingerprint = H(
  "engineering-branch-rollback-fingerprint:v1",
  branchRollbackApprovalRequestId,
  rollbackPlanBodySha256,
  expectedPriorStateSha256
)

branchRollbackDecisionId = H(
  "engineering-branch-rollback-decision:v1",
  branchRollbackApprovalRequestId,
  rollbackApprovalFingerprint,
  operatorPrincipalId,
  decision
)

branchRollbackReceiptId = H(
  "engineering-branch-rollback-receipt:v1",
  branchRollbackDecisionId,
  expectedPriorHead,
  revertCommitSha,
  rollbackManifestSha256
)

engineeringEventId = H(
  "engineering-change-event:v1",
  engineeringChangeRequestId,
  eventOrdinal,
  priorEventSha256,
  eventBodySha256
)
```

All numeric identity fields use the same positive-safe-integer string encoding as existing
reliability identities. An absent target-ref head is encoded by the factory-owned literal `absent`;
request/model text cannot supply that sentinel. An exact replay returns the existing row/receipt only
when every immutable field and digest matches. The same deterministic ID with different bytes is
`INTEGRITY_CONFLICT`, never last-write-wins.

The first engineering event uses a factory-owned genesis digest constant; later events must bind the
exact prior event digest. Request or model text cannot choose either the genesis sentinel or a prior
event link.

These bodies are cycle-free by construction. A plan contains protected host-execution template IDs,
not attempt-bound execution plans. Test-run evidence binds an attempt, plan, phase, and tested tree,
not a future patch ID. The final evidence package later proves that its red-test tree equals the
candidate's recorded intermediate tree and that its focused-test tree equals the candidate tree.
Commit bodies omit patch, approval, decision, receipt, and handoff IDs that are derived later.

## 7. Strict contracts

The following interfaces describe persisted canonical bodies. `Sha256Hex`, `GitObjectId`,
`CanonicalUtc`, `RelativeRepoPath`, and opaque IDs are branded values validated at the boundary, not
unchecked aliases. Every union is exhaustive and every DTO carries `schemaVersion: 1`.

`GitObjectId` is validated against the protected repository registration's exact object format
(`sha1` or `sha256`); implementations may not assume a 40-character object ID or accept a mixed
format within one request.

### 7.1 Intent, request, authority, and plan

```ts
type EngineeringSourceV1 =
  | {
      kind: 'conversation_message';
      conversationId: string;
      messageId: string;
      messageSequence: number;
      messageBodySha256: Sha256Hex;
    }
  | {
      kind: 'toolsmith_proposal';
      proposalId: string;
      proposalVersion: number;
      proposalBodySha256: Sha256Hex;
      sealedTenantProvenanceSha256: Sha256Hex;
    };

interface EngineeringAuthorityCeilingV1 {
  schemaVersion: 1;
  authorityCeilingId: string;
  authorityCeilingRevision: number;
  repositoryRegistrationId: string;
  repositoryRegistrationRevision: number;
  allowedPathSetId: string;
  allowedPathSetSha256: Sha256Hex;
  immutableControlPathSetSha256: Sha256Hex;
  secretPathSetSha256: Sha256Hex;
  internalToolSetSha256: Sha256Hex;
  executableRegistrySha256: Sha256Hex;
  defaultModelRouteCeiling: 'tier_2';
  absoluteModelRouteCeiling: 'tier_3';
  escalationCeiling: 'tier_3_with_separate_operator_approval';
  executionPolicySha256: Sha256Hex;
  sandboxPolicySha256: Sha256Hex;
  evidencePolicySha256: Sha256Hex;
  branchNamespace: 'refs/heads/codex/ecr-';
  forbiddenCapabilities: readonly [
    'approval_write',
    'authority_mutation',
    'secret_read',
    'network',
    'arbitrary_process',
    'git_ref_write',
    'merge',
    'push',
    'release',
    'install'
  ];
}

type EngineeringChangeRequestState =
  | 'intake_confirmed'
  | 'planning'
  | 'awaiting_attempt_approval'
  | 'attempting'
  | 'awaiting_application_approval'
  | 'branch_applying'
  | 'release_handoff_ready'
  | 'awaiting_rollback_approval'
  | 'rollback_applying'
  | 'rejected'
  | 'cancelled'
  | 'failed'
  | 'superseded'
  | 'rolled_back'
  | 'archived';

type EngineeringTerminalReasonCode =
  | 'operator_rejected'
  | 'operator_cancelled'
  | 'attempts_exhausted'
  | 'base_drift'
  | 'policy_drift'
  | 'authority_drift'
  | 'integrity_failure'
  | 'local_branch_rolled_back'
  | 'operator_archived';

type EngineeringFailureCode =
  | 'canonical_input_invalid'
  | 'integrity_conflict'
  | 'source_unauthorized'
  | 'source_stale'
  | 'base_drift'
  | 'policy_drift'
  | 'sandbox_unavailable'
  | 'sandbox_violation'
  | 'path_boundary_violation'
  | 'tenant_boundary_violation'
  | 'secret_exposure_blocked'
  | 'budget_exhausted'
  | 'usage_or_pricing_unknown'
  | 'model_provider_exhausted'
  | 'host_exec_denied'
  | 'host_exec_effect_unknown'
  | 'test_evidence_invalid'
  | 'review_blocked'
  | 'release_gate_failed'
  | 'branch_ref_conflict'
  | 'recovery_requires_new_attempt';

interface EngineeringChangeRequestV1 {
  schemaVersion: 1;
  requestId: string;
  engineeringIntentId: string;
  source: EngineeringSourceV1;
  operatorPrincipalId: string;
  intentBodySha256: Sha256Hex;
  repositoryRegistrationId: string;
  repositoryRegistrationRevision: number;
  baseRevision: GitObjectId;
  baseTreeSha: GitObjectId;
  authorityCeiling: EngineeringAuthorityCeilingV1;
  engineeringPolicyVersion: string;
  state: EngineeringChangeRequestState;
  requestVersion: number;
  currentPlanFingerprint: string | null;
  currentAttemptId: string | null;
  approvedPatchCandidateId: string | null;
  branchApplicationReceiptId: string | null;
  releaseHandoffId: string | null;
  rollbackReceiptId: string | null;
  createdAt: CanonicalUtc;
  updatedAt: CanonicalUtc;
  terminalReasonCode: EngineeringTerminalReasonCode | null;
}

interface EngineeringExecutionPolicyV1 {
  schemaVersion: 1;
  maxAttemptsPerRequest: 3;
  maxRevisionCyclesPerAttempt: 2;
  maxAuthorModelTurns: 16;
  maxReviewerModelTurns: 8;
  maxModelInputTokensPerAttempt: 160_000;
  maxModelOutputTokensPerAttempt: 32_000;
  maxTypedToolCallsPerAttempt: 48;
  maxHostExecutionsPerAttempt: 12;
  maxConcurrentHostExecutionsPerRequest: 1;
  maxDelegationDepth: 1;
  maxAttemptWallMilliseconds: 2_700_000;
  maxIdleMilliseconds: 300_000;
  maxChangedFiles: 64;
  maxPatchBytes: 524_288;
  maxAggregateCommandOutputBytes: 8_388_608;
  maxCommandOutputBytes: 1_048_576;
  maxArtifactBytes: 16_777_216;
  maxCostMicrousd: number; // required positive configured value; never null/unlimited
  pricingCatalogVersion: string;
}

type EngineeringTestApplicabilityV1 =
  | { kind: 'test_first_required' }
  | {
      kind: 'registered_non_executable_change';
      classificationRegistrationId: string;
      classificationRevision: string;
      classificationBodySha256: Sha256Hex;
    };

interface EngineeringChangePlanV1 {
  schemaVersion: 1;
  requestId: string;
  planRevision: number;
  expectedRequestVersion: number;
  baseRevision: GitObjectId;
  baseTreeSha: GitObjectId;
  architectureSummarySha256: Sha256Hex;
  requirementManifestSha256: Sha256Hex;
  allowedPathSetSha256: Sha256Hex;
  immutableControlPathSetSha256: Sha256Hex;
  plannedChangedPaths: readonly RelativeRepoPath[];
  testApplicability: EngineeringTestApplicabilityV1;
  testPlan: readonly RegisteredTestPlanV1[];
  plannedHostExecutionTemplateIds: readonly string[];
  plannedHostExecutionTemplateSetSha256: Sha256Hex;
  authorProfileRevision: string;
  reviewerProfileRevision: string;
  releaseVerifierRevision: string;
  executionPolicy: EngineeringExecutionPolicyV1;
  modelRoutePolicySha256: Sha256Hex;
  internalToolSetSha256: Sha256Hex;
  executableRegistrySha256: Sha256Hex;
  sandboxPolicySha256: Sha256Hex;
  acceptanceCriteriaSha256: Sha256Hex;
  planBodySha256: Sha256Hex;
  planFingerprint: string;
  createdAt: CanonicalUtc;
}

interface ExactAttemptApprovalDecisionV1 {
  schemaVersion: 1;
  attemptApprovalDecisionId: string;
  attemptApprovalRequestId: string;
  requestId: string;
  expectedRequestVersion: number;
  planFingerprint: string;
  planBodySha256: Sha256Hex;
  baseRevision: GitObjectId;
  authorityCeilingSha256: Sha256Hex;
  executionPolicySha256: Sha256Hex;
  hostExecutionTemplateSetSha256: Sha256Hex;
  modelRoutePolicySha256: Sha256Hex;
  approvalFingerprint: string;
  decision: 'approve' | 'reject';
  operatorPrincipalId: string;
  authContextSha256: Sha256Hex;
  userPresenceEvidenceSha256: Sha256Hex;
  decidedAt: CanonicalUtc;
  expiresAt: CanonicalUtc;
}

type EngineeringApprovalEffectKind =
  'create_attempt' | 'execute_host_plan' | 'apply_local_branch' | 'revert_local_branch';

interface EngineeringApprovalConsumptionV1 {
  schemaVersion: 1;
  approvalConsumptionId: string;
  approvalDecisionId: string;
  effectKind: EngineeringApprovalEffectKind;
  effectPlanFingerprint: string;
  expectedRequestVersion: number;
  consumedAt: CanonicalUtc;
  consumptionBodySha256: Sha256Hex;
}
```

`plannedChangedPaths` may narrow the registered set and can be revised only by producing a new plan
revision and fresh attempt approval. It can never widen beyond the server-owned allowed-path set.
The operator-visible architecture summary is stored as a bounded escaped artifact; its digest, not
unbounded prose, is the canonical plan field.

Host-execution templates are immutable protected registry records that describe the logical test/gate
operation and maximum bounds without an attempt/workspace ID. After an approved attempt exists, the
server resolves a template into an exact `HostExecutionPlanV1` with absolute executable/cwd, argv,
environment, base, plan, and current patch bindings. That exact resolved plan still needs its own
one-use host-exec approval.

`maxCostMicrousd` is chosen from protected server configuration and displayed in the approval. The
model lane cannot start if the catalog version is unavailable or usage/cost cannot be metered.
Missing usage is `unknown`, never zero. Tier 3 escalation requires a new plan revision and a separate
exact operator decision; it is not a router fallback.

### 7.2 Isolated workspace and attempt

```ts
type EngineeringAttemptState =
  | 'queued'
  | 'workspace_preparing'
  | 'blue_build'
  | 'red_review'
  | 'revision'
  | 'release_verify'
  | 'candidate_frozen'
  | 'retry_wait'
  | 'cancelled'
  | 'failed'
  | 'abandoned';

interface EngineeringWorkspaceLeaseV1 {
  schemaVersion: 1;
  workspaceId: string;
  attemptId: string;
  workspacePolicySha256: Sha256Hex;
  rootBindingSha256: Sha256Hex;
  baseRevision: GitObjectId;
  baseTreeSha: GitObjectId;
  mutablePathManifestSha256: Sha256Hex;
  sandboxPolicySha256: Sha256Hex;
  ownerProcessInstanceId: string;
  leaseVersion: number;
  leaseExpiresAt: CanonicalUtc;
  state: 'preparing' | 'ready' | 'leased' | 'quarantined' | 'retained' | 'disposed';
  createdAt: CanonicalUtc;
}

interface EngineeringUsageV1 {
  modelInputTokens: number | null;
  modelOutputTokens: number | null;
  typedToolCalls: number;
  hostExecutions: number;
  measuredCostMicrousd: number | null;
  costCoverage: 'complete' | 'partial' | 'unknown';
  pricingCatalogVersion: string | null;
}

interface EngineeringContinuationCheckpointV1 {
  schemaVersion: 1;
  requestId: string;
  requestVersion: number;
  attemptId: string;
  attemptVersion: number;
  stage: EngineeringAttemptState;
  planFingerprint: string;
  baseRevision: GitObjectId;
  workspaceId: string;
  workspaceManifestSha256: Sha256Hex;
  latestCandidateTreeSha: GitObjectId;
  evidenceSetSha256: Sha256Hex;
  profileRevision: string;
  modelRouteRevision: string | null;
  toolGrantSha256: Sha256Hex;
  sandboxPolicySha256: Sha256Hex;
  consumedUsage: EngineeringUsageV1;
  remainingBudgetSha256: Sha256Hex;
  nextAction:
    | 'model_turn'
    | 'typed_tool_call'
    | 'await_host_exec_approval'
    | 'dispatch_review'
    | 'dispatch_release_gate'
    | 'freeze_candidate';
  checkpointOrdinal: number;
  checkpointBodySha256: Sha256Hex;
  createdAt: CanonicalUtc;
  expiresAt: CanonicalUtc;
}

interface EngineeringChangeAttemptV1 {
  schemaVersion: 1;
  attemptId: string;
  requestId: string;
  attemptOrdinal: number;
  planFingerprint: string;
  attemptApprovalDecisionId: string;
  workspaceId: string | null;
  state: EngineeringAttemptState;
  stageOrdinal: number;
  attemptVersion: number;
  authorSessionId: string;
  reviewerSessionId: string | null;
  usage: EngineeringUsageV1;
  latestCheckpointSha256: Sha256Hex | null;
  patchCandidateId: string | null;
  failureCode: EngineeringFailureCode | null;
  startedAt: CanonicalUtc | null;
  finishedAt: CanonicalUtc | null;
}
```

The lease token itself is secret capability material and is never persisted in canonical evidence or
logs; only its hash and version are held by the private lease repository. A checkpoint stores no
hidden chain-of-thought, raw model request, raw secret, or arbitrary tool output. It stores bounded
user-visible artifacts, citations to immutable evidence, explicit next action, and accounting.

### 7.3 Host-execution plan, approval, and receipt

```ts
interface HostExecutionPlanV1 {
  schemaVersion: 1;
  hostExecutionRequestId: string;
  requestId: string;
  attemptId: string;
  stage: 'red_test' | 'focused_test' | 'release_gate';
  executionOrdinal: number;
  executableRegistrationId: string;
  canonicalExecutablePath: string;
  executableSha256: Sha256Hex;
  argv: readonly string[];
  canonicalCwd: string;
  cwdBindingSha256: Sha256Hex;
  sanitizedEnvironment: readonly PublicEnvironmentBindingV1[];
  sanitizedEnvSha256: Sha256Hex;
  baseRevision: GitObjectId;
  planFingerprint: string;
  patchCandidateId: string | null;
  patchFingerprint: string | null;
  sandboxPolicySha256: Sha256Hex;
  permittedOutputPathSetSha256: Sha256Hex;
  timeoutMilliseconds: number;
  stdoutLimitBytes: number;
  stderrLimitBytes: number;
  executionPlanBodySha256: Sha256Hex;
}

interface PublicEnvironmentBindingV1 {
  name: string;
  value: string;
}

interface ExactHostExecutionApprovalV1 {
  schemaVersion: 1;
  approvalDecisionId: string;
  hostExecutionRequestId: string;
  expectedRequestVersion: number;
  executionPlanBodySha256: Sha256Hex;
  approvalFingerprint: string;
  decision: 'approve' | 'reject';
  operatorPrincipalId: string;
  authContextSha256: Sha256Hex;
  userPresenceEvidenceSha256: Sha256Hex;
  decidedAt: CanonicalUtc;
  expiresAt: CanonicalUtc;
}

interface HostExecutionReceiptV1 {
  schemaVersion: 1;
  hostExecutionRequestId: string;
  approvalDecisionId: string;
  executionPlanBodySha256: Sha256Hex;
  executableSha256: Sha256Hex;
  canonicalCwd: string;
  sanitizedEnvSha256: Sha256Hex;
  sandboxPolicySha256: Sha256Hex;
  workspaceTreeBefore: GitObjectId;
  workspaceTreeAfter: GitObjectId;
  exitCode: number | null;
  terminationSignal: string | null;
  outcome: 'passed' | 'failed' | 'timed_out' | 'cancelled' | 'effect_unknown';
  stdoutBlobSha256: Sha256Hex;
  stderrBlobSha256: Sha256Hex;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  outputPathManifestSha256: Sha256Hex;
  startedAt: CanonicalUtc;
  finishedAt: CanonicalUtc;
  receiptBodySha256: Sha256Hex;
}
```

The broker uses direct process spawn with `shell: false`. `argv` is an array, not a command string.
The executable path is absolute, realpath-resolved, immutable for the invocation, and byte-matched
to its protected registry digest immediately before spawn. The canonical cwd must equal the
workspace root or one exact registered subdirectory after no-follow resolution. The sanitized
environment is constructed from an allowlist; it is not inherited and then redacted.

Every external process requires a one-use approval. The UI may present a finite batch for
convenience, but the server creates a distinct approval body and decision for every exact member.
There is no wildcard command, reusable “allow tests” token, duration grant, or approval inherited by
a revised plan. Changing any executable path/digest, argument, argument order, cwd, environment,
base, plan, patch, sandbox, timeout, or output set invalidates the approval. If the dashboard
approval channel is unavailable, the broker returns `APPROVAL_CHANNEL_UNAVAILABLE` and does not
spawn.

`sanitizedEnvironment` is sorted by unique variable name and contains the complete non-secret value
used for the process. Its canonical digest must match `sanitizedEnvSha256`, and the approval UI must
render every entry. A value that cannot safely be disclosed is not admitted to this lane; it cannot
be replaced by a redacted placeholder and still be approved.

An external test process may write only registered scratch/output paths. A changed source tree after
the command is `HOST_EXEC_UNEXPECTED_SOURCE_MUTATION`, invalidates the evidence, and quarantines the
workspace. Source edits are performed only through typed patch primitives.

### 7.4 Patch and immutable evidence

```ts
interface ChangedPathEvidenceV1 {
  path: RelativeRepoPath;
  operation: 'add' | 'modify' | 'delete';
  oldBlobSha: GitObjectId | null;
  newBlobSha: GitObjectId | null;
  oldMode: '100644' | null;
  newMode: '100644' | null;
  additions: number;
  deletions: number;
  utf8Text: true;
}

interface PatchCandidateV1 {
  schemaVersion: 1;
  patchCandidateId: string;
  requestId: string;
  attemptId: string;
  planFingerprint: string;
  baseRevision: GitObjectId;
  baseTreeSha: GitObjectId;
  candidateCommitSha: GitObjectId;
  candidateTreeSha: GitObjectId;
  commitBodySha256: Sha256Hex;
  changedPaths: readonly ChangedPathEvidenceV1[];
  changedPathManifestSha256: Sha256Hex;
  patchBlobSha256: Sha256Hex;
  patchBytes: number;
  testFirstIntermediateTreeSha: GitObjectId | null;
  forbiddenPathScanSha256: Sha256Hex;
  secretScanSha256: Sha256Hex;
  dependencyManifestUnchanged: true;
  authorityCeilingUnchanged: true;
  candidateBodySha256: Sha256Hex;
  frozenAt: CanonicalUtc;
}

interface FocusedTestEvidenceV1 {
  schemaVersion: 1;
  testEvidenceId: string;
  requestId: string;
  attemptId: string;
  planFingerprint: string;
  candidateBinding:
    | { kind: 'test_first_intermediate'; patchCandidateId: null }
    | { kind: 'final_candidate'; patchCandidateId: string };
  phase: 'red_before_implementation' | 'focused_after_implementation';
  suiteRegistrationId: string;
  suiteRevision: string;
  testedTreeSha: GitObjectId;
  hostExecutionRequestId: string;
  hostExecutionReceiptSha256: Sha256Hex;
  expectedOutcome: 'fail' | 'pass';
  observedOutcome: 'fail' | 'pass' | 'inconclusive';
  assertionSummarySha256: Sha256Hex;
  testListSha256: Sha256Hex;
  resultBodySha256: Sha256Hex;
  completedAt: CanonicalUtc;
}

interface ReviewFindingV1 {
  findingId: string;
  severity: 'blocker' | 'high' | 'medium' | 'low';
  category: 'correctness' | 'security' | 'isolation' | 'recovery' | 'test_gap' | 'maintainability';
  path: RelativeRepoPath | null;
  line: number | null;
  summarySha256: Sha256Hex;
  evidenceCitationSha256: Sha256Hex;
  disposition: 'open' | 'fixed' | 'accepted_risk';
  dispositionEvidenceSha256: Sha256Hex | null;
}

interface IndependentReviewEvidenceV1 {
  schemaVersion: 1;
  reviewEvidenceId: string;
  patchCandidateId: string;
  reviewOrdinal: number;
  reviewerProfileRevision: string;
  reviewerSessionId: string;
  authorSessionId: string;
  independencePolicySha256: Sha256Hex;
  reviewerWorkspaceAccess: 'read_only_frozen_evidence';
  findings: readonly ReviewFindingV1[];
  findingsManifestSha256: Sha256Hex;
  verdict: 'revise' | 'acceptable_for_operator_review' | 'blocked';
  unresolvedBlockerCount: number;
  unresolvedHighCount: number;
  reviewBodySha256: Sha256Hex;
  completedAt: CanonicalUtc;
}

interface ReleaseGateEvidenceV1 {
  schemaVersion: 1;
  releaseGateEvidenceId: string;
  patchCandidateId: string;
  candidateCommitSha: GitObjectId;
  candidateTreeSha: GitObjectId;
  cleanCheckoutManifestSha256: Sha256Hex;
  releaseGateRegistrationId: string;
  releaseGateRevision: string;
  toolchainManifestSha256: Sha256Hex;
  hostExecutionRequestId: string;
  hostExecutionReceiptSha256: Sha256Hex;
  checkManifestSha256: Sha256Hex;
  outcome: 'pass' | 'fail' | 'inconclusive';
  resultBodySha256: Sha256Hex;
  completedAt: CanonicalUtc;
}

interface FrozenEngineeringEvidencePackageV1 {
  schemaVersion: 1;
  requestId: string;
  requestVersion: number;
  attemptId: string;
  planFingerprint: string;
  patchCandidateId: string;
  focusedTestEvidenceIds: readonly string[];
  reviewEvidenceId: string;
  releaseGateEvidenceId: string;
  hostExecutionEvidenceSetSha256: Sha256Hex;
  usageEvidenceSha256: Sha256Hex;
  evidenceManifestSha256: Sha256Hex;
  frozenAt: CanonicalUtc;
}
```

V1 candidates contain bounded UTF-8 regular files only, with mode `100644`; binary patches,
symlinks, hard-linked escapes, submodules, special files, mode changes, and case/Unicode-normalization
collisions are rejected. Patch bytes are a retained raw artifact with their own SHA-256; the
canonical changed-path manifest is separately hashed so diff formatting cannot alter file identity.

For `red_before_implementation`, `candidateBinding.kind` must be `test_first_intermediate`; for
`focused_after_implementation`, it must be `final_candidate`. The final package validator requires
the same request/attempt/plan, the candidate's exact recorded intermediate tree for red, and its
exact final tree/patch ID for focused. A blocker or high review finding may be only `open` or
`fixed`; `accepted_risk` is limited to medium/low and remains conspicuous in the operator approval.
Only a later operator decision accepts that displayed risk; the reviewer cannot grant authority.

Test-first is an enforceable evidence sequence:

1. Code Blue applies only the new/changed test delta.
2. The exact registered focused test fails on that intermediate tree for the expected assertion.
3. The red evidence is frozen before a non-test source path may change.
4. Code Blue applies implementation edits.
5. The same registered focused test passes on the candidate tree.
6. Code Red reviews the frozen candidate in a separate write-denied session.
7. Release Verifier materializes the precomputed candidate commit in a fresh clean checkout and runs
   the fixed complete release gate.

A registry-classified documentation-only request may use
`testApplicability: 'registered_non_executable_change'` instead of red/focused evidence, but it still
requires deterministic path classification, independent review, and the full release gate. A model
cannot declare its own work exempt. Failed, missing, stale, truncated-to-inconclusive, or
cross-candidate evidence can never become approval-ready.

### 7.5 Exact branch-application approval

```ts
interface EngineeringBranchApplicationPlanV1 {
  schemaVersion: 1;
  branchApplicationApprovalRequestId: string;
  requestId: string;
  expectedRequestVersion: number;
  frozenEvidenceManifestSha256: Sha256Hex;
  patchCandidateId: string;
  planFingerprint: string;
  baseRevision: GitObjectId;
  baseTreeSha: GitObjectId;
  sourceBaseRef: string; // server-owned protected source ref
  expectedSourceBaseRefHead: GitObjectId;
  targetRef: string; // server-derived refs/heads/codex/ecr-<full requestId>
  expectedPriorHead: GitObjectId | null;
  candidateCommitSha: GitObjectId;
  candidateTreeSha: GitObjectId;
  commitBodySha256: Sha256Hex;
  branchApplicatorRegistrationId: string;
  canonicalGitExecutablePath: string;
  gitExecutableSha256: Sha256Hex;
  branchApplicatorArgvManifestSha256: Sha256Hex;
  canonicalRepositoryCwd: string;
  sanitizedEnvironment: readonly PublicEnvironmentBindingV1[];
  sanitizedEnvSha256: Sha256Hex;
  repositoryRegistrationRevision: number;
  authorityCeilingSha256: Sha256Hex;
  sandboxPolicySha256: Sha256Hex;
  engineeringPolicyVersion: string;
  applicationPlanBodySha256: Sha256Hex;
  applicationPlanFingerprint: string;
  expectedPriorStateSha256: Sha256Hex;
  approvalExpiresAt: CanonicalUtc;
}

interface ExactBranchApplicationDecisionV1 {
  schemaVersion: 1;
  branchApplicationDecisionId: string;
  approvalRequestId: string;
  applicationPlanFingerprint: string;
  approvalFingerprint: string;
  expectedRequestVersion: number;
  decision: 'approve' | 'reject';
  operatorPrincipalId: string;
  authContextSha256: Sha256Hex;
  userPresenceEvidenceSha256: Sha256Hex;
  decisionBodySha256: Sha256Hex;
  decidedAt: CanonicalUtc;
  expiresAt: CanonicalUtc;
}

interface BranchApplicationReceiptV1 {
  schemaVersion: 1;
  receiptId: string;
  requestId: string;
  approvalDecisionId: string;
  applicationPlanFingerprint: string;
  sourceBaseRef: string;
  sourceBaseRefObservedHead: GitObjectId;
  targetRef: string;
  expectedPriorHead: GitObjectId | null;
  appliedCommitSha: GitObjectId;
  appliedTreeSha: GitObjectId;
  refObservedAfter: GitObjectId;
  commitBodySha256: Sha256Hex;
  applicationManifestSha256: Sha256Hex;
  journalSha256: Sha256Hex;
  operatorWorktreeBeforeSha256: Sha256Hex;
  operatorWorktreeAfterSha256: Sha256Hex;
  appliedAt: CanonicalUtc;
  receiptBodySha256: Sha256Hex;
}
```

The application approval fingerprint binds the canonical body of every field above plus the exact
focused-test, review, release-gate, host-execution, usage, path-policy, secret-scan, and frozen
evidence digests. It therefore binds, at minimum:

- canonical repository cwd;
- exact branch-applicator and Git executable paths and byte digests;
- every fixed argv vector and their order;
- sanitized environment digest;
- repository registration and base revision/tree;
- source base ref and its expected head;
- exact target ref and expected prior head;
- plan fingerprint;
- patch/candidate/commit/tree fingerprints;
- model/tool budget and measured-usage evidence;
- sandbox, path, authority, toolchain, and engineering policy revisions;
- independent review and clean release-gate evidence; and
- expected request version, operator principal, expiry, and user-presence context.

The approval body is rendered first. On submit, the server rereads every referenced row and artifact,
recomputes the application plan and approval fingerprint, verifies current posture/policy/base/ref,
and performs a one-use CAS. The client cannot submit a replacement body. Changed evidence, a stale
version, expiry, a different principal, replay, or an unavailable approval UI returns a deny result
with no ref mutation.

The maximum attempt and application approval lifetime is 15 minutes. The maximum host-exec approval
lifetime is 5 minutes and it expires immediately on first consumption. Protected configuration may
make any lifetime shorter, never longer. Rejection and cancellation are durable decisions; approval
buttons do not retry an effect from browser JavaScript.

### 7.6 Release handoff and branch rollback

```ts
interface ReleaseHandoffV1 {
  schemaVersion: 1;
  handoffId: string;
  requestId: string;
  branchApplicationReceiptId: string;
  repositoryRegistrationId: string;
  targetRef: string;
  candidateCommitSha: GitObjectId;
  candidateTreeSha: GitObjectId;
  frozenEvidenceManifestSha256: Sha256Hex;
  applicationApprovalReceiptSha256: Sha256Hex;
  releaseGateEvidenceId: string;
  requiredNextProcess: 'protected_human_review_and_reliability_release';
  executionEligibility: 'none';
  mergeAuthority: 'none';
  pushAuthority: 'none';
  releaseAuthority: 'none';
  handoffBodySha256: Sha256Hex;
  createdAt: CanonicalUtc;
  revokedByRollbackReceiptId: string | null;
}

interface BranchRollbackPlanV1 {
  schemaVersion: 1;
  rollbackApprovalRequestId: string;
  requestId: string;
  expectedRequestVersion: number;
  branchApplicationReceiptId: string;
  targetRef: string;
  expectedPriorHead: GitObjectId; // exactly the applied candidate commit
  revertCommitSha: GitObjectId;
  revertTreeSha: GitObjectId; // exactly the original base tree
  revertCommitBodySha256: Sha256Hex;
  inversePatchSha256: Sha256Hex;
  branchApplicatorRegistrationId: string;
  canonicalGitExecutablePath: string;
  gitExecutableSha256: Sha256Hex;
  canonicalRepositoryCwd: string;
  sanitizedEnvironment: readonly PublicEnvironmentBindingV1[];
  sanitizedEnvSha256: Sha256Hex;
  rollbackPlanBodySha256: Sha256Hex;
  rollbackPlanFingerprint: string;
  expectedPriorStateSha256: Sha256Hex;
  approvalExpiresAt: CanonicalUtc;
}

interface ExactBranchRollbackDecisionV1 {
  schemaVersion: 1;
  rollbackDecisionId: string;
  rollbackApprovalRequestId: string;
  requestId: string;
  expectedRequestVersion: number;
  branchApplicationReceiptId: string;
  rollbackPlanFingerprint: string;
  rollbackApprovalFingerprint: string;
  decision: 'approve' | 'reject';
  operatorPrincipalId: string;
  authContextSha256: Sha256Hex;
  userPresenceEvidenceSha256: Sha256Hex;
  decidedAt: CanonicalUtc;
  expiresAt: CanonicalUtc;
}

interface BranchRollbackReceiptV1 {
  schemaVersion: 1;
  rollbackReceiptId: string;
  requestId: string;
  rollbackDecisionId: string;
  branchApplicationReceiptId: string;
  targetRef: string;
  expectedPriorHead: GitObjectId;
  revertCommitSha: GitObjectId;
  revertedTreeSha: GitObjectId;
  rollbackManifestSha256: Sha256Hex;
  journalSha256: Sha256Hex;
  rolledBackAt: CanonicalUtc;
  receiptBodySha256: Sha256Hex;
}
```

The handoff is an inert database/artifact record. It may be viewed or exported, but no component in
this lane consumes it to push, merge, open a pull request, sign release approval, install, or
activate. The protected release process reruns its own checks and requires the reliability spine's
independent intent, approval root, CI attestation, live audit, and activation gates.

Rollback is also exact and dashboard-approved. It creates a precomputed revert commit on the same
dedicated branch; it never deletes or force-moves the branch and never touches a protected ref. The
branch head must still equal the applied candidate commit. If it has advanced, the result is
`ROLLBACK_REF_DIVERGED` and a human must create a new governed change. A successful rollback marks
the handoff revoked while retaining both immutable records. It makes no claim about a candidate that
was merged or deployed outside the lane.

## 8. Lifecycle state machines

### 8.1 Request state machine

No durable `draft` is created from keystrokes. Intake first produces a bounded, expiring preview.
Only the operator's exact preview confirmation creates `EngineeringChangeRequestV1` in
`intake_confirmed`.

| Current state                                                                              | Event and required evidence                                                             | Next state                      | Effect                                                              |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------- |
| —                                                                                          | Confirm current intake preview; source and preview fingerprint still match              | `intake_confirmed`              | Insert immutable request/event only                                 |
| `intake_confirmed`                                                                         | Coordinator acquires lease and policy/base still match                                  | `planning`                      | Dispatch read-only Architect                                        |
| `planning`                                                                                 | Valid plan frozen                                                                       | `awaiting_attempt_approval`     | Render exact budget/path/tool/test plan                             |
| `awaiting_attempt_approval`                                                                | Operator approves current plan fingerprint with fresh user presence                     | `attempting`                    | Create one attempt; no host command is thereby approved             |
| `awaiting_attempt_approval`                                                                | Operator rejects                                                                        | `rejected`                      | Terminal, no workspace execution                                    |
| `attempting`                                                                               | Candidate, tests, independent review, and release-gate evidence all freeze and validate | `awaiting_application_approval` | Render exact branch mutation                                        |
| `attempting`                                                                               | Retryable attempt ends within request budget                                            | `awaiting_attempt_approval`     | New plan revision/attempt requires fresh approval                   |
| `attempting`                                                                               | Attempts exhausted or nonretryable failure                                              | `failed`                        | Terminal; retain/quarantine evidence                                |
| `awaiting_application_approval`                                                            | Operator rejects exact candidate                                                        | `rejected`                      | Terminal, no branch mutation                                        |
| `awaiting_application_approval`                                                            | Operator approves, server replans/rechecks, and one-use CAS succeeds                    | `branch_applying`               | Consume decision and create prepared application journal atomically |
| `branch_applying`                                                                          | Exact ref CAS and receipt commit succeed or recover idempotently                        | `release_handoff_ready`         | Insert receipt and inert handoff                                    |
| `release_handoff_ready`                                                                    | Operator requests rollback preview                                                      | `awaiting_rollback_approval`    | No branch effect                                                    |
| `awaiting_rollback_approval`                                                               | Operator rejects/cancels rollback                                                       | `release_handoff_ready`         | Retain decision; branch unchanged                                   |
| `awaiting_rollback_approval`                                                               | Operator approves exact rollback and ref still matches                                  | `rollback_applying`             | Consume decision and prepare rollback journal                       |
| `rollback_applying`                                                                        | Exact revert ref CAS and receipt succeed or recover                                     | `rolled_back`                   | Revert commit retained; handoff marked revoked                      |
| `release_handoff_ready` or `rolled_back`                                                   | Operator archives                                                                       | `archived`                      | Read model hidden by default; evidence retained                     |
| Any state through `awaiting_application_approval`, before application-decision consumption | Operator cancels current version                                                        | `cancelled`                     | Stop/kill bounded work; never infer rollback                        |
| Any pre-application state                                                                  | Base, policy, authority, executable, toolchain, or source revision drifts               | `superseded`                    | Fresh intake required                                               |

`rejected`, `cancelled`, `failed`, `superseded`, and `archived` are terminal. `rolled_back` is an
effect-complete steady state whose only permitted transition is operator archival. The only
post-application effect transition is the exact rollback path shown above. Cancellation arriving
after an application decision was consumed cannot reverse a ref update; the journal
finishes/reconciles and the UI offers rollback.

Every transition is a transaction over `(requestId, expectedRequestVersion, expectedState)`. Invalid
edges, skipped stages, or the same version with conflicting event bytes are integrity failures.

### 8.2 Attempt state machine

| Current state         | Required next evidence                                                               | Next state                             |
| --------------------- | ------------------------------------------------------------------------------------ | -------------------------------------- |
| `queued`              | Current plan decision and executor lease                                             | `workspace_preparing`                  |
| `workspace_preparing` | Safe base materialization, manifest, sandbox self-test, and approved-plan checkpoint | `blue_build`                           |
| `blue_build`          | Red evidence then implementation and passing focused evidence                        | `red_review`                           |
| `red_review`          | `acceptable_for_operator_review` with zero open blocker/high findings                | `release_verify`                       |
| `red_review`          | `revise` and revision budget remains                                                 | `revision`                             |
| `revision`            | New patch/test evidence                                                              | `red_review` with a new review ordinal |
| `release_verify`      | Fixed gate passes on exact clean candidate commit                                    | `candidate_frozen`                     |
| Any active state      | Transient provider/storage fault within finite retry budget                          | `retry_wait`                           |
| `retry_wait`          | Exact checkpoint revalidated and lease reacquired                                    | Prior recorded active state            |
| Any active state      | Valid cancellation fence                                                             | `cancelled`                            |
| Any active state      | Policy/isolation/integrity failure or exhausted budget                               | `failed` or `abandoned`                |

An attempt cannot return from `candidate_frozen` to editing. Any requested change creates a new plan
revision and attempt. Code Red cannot review its own authored session, and Release Verifier cannot
accept a dirty checkout or an unregistered gate.

## 9. Persistence and immutable evidence

### 9.1 SQLite ownership

A private engineering repository writer owns these tables:

| Table                                                                       | Mutation rule                                                                                     |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `engineering_change_requests`                                               | Immutable identity/scope/base columns; state/version updated only by checked transition procedure |
| `engineering_change_events`                                                 | Append-only ordinal and prior-event hash chain                                                    |
| `engineering_change_plans`                                                  | Insert-only plan revisions; body digest unique per request/revision                               |
| `engineering_attempt_approvals`                                             | Insert-only decisions; one current plan/version/principal                                         |
| `engineering_approval_consumptions`                                         | Insert-only, unique decision ID; atomic with the authorized effect's first journal row            |
| `engineering_change_attempts`                                               | Checked state/version and bounded accounting updates                                              |
| `engineering_workspaces`                                                    | Checked lease/state/version; host path encrypted or private and never sent to model/UI            |
| `engineering_continuation_checkpoints`                                      | Insert-only ordinals; one current pointer updated by CAS                                          |
| `engineering_host_exec_plans`                                               | Insert-only exact bodies                                                                          |
| `engineering_host_exec_decisions`                                           | Insert-only decisions; unique request ID and decision ID                                          |
| `engineering_host_exec_journals`                                            | Checked `prepared/spawned/observed/receipt_committed` phases; unknown effects retained            |
| `engineering_host_exec_receipts`                                            | Insert-only exact execution outcome, including unknown effect                                     |
| `engineering_patch_candidates`                                              | Insert-only frozen candidate/body/blob references                                                 |
| `engineering_test_evidence`                                                 | Insert-only red/focused rows                                                                      |
| `engineering_review_evidence`                                               | Insert-only review ordinals and findings manifests                                                |
| `engineering_release_gate_evidence`                                         | Insert-only clean-gate result                                                                     |
| `engineering_evidence_packages`                                             | Insert-only frozen manifest                                                                       |
| `engineering_branch_application_plans`                                      | Insert-only exact branch mutation previews                                                        |
| `engineering_branch_application_decisions`                                  | Insert-only exact operator decisions                                                              |
| `engineering_branch_application_journals`                                   | Checked phase transitions; never silently discarded                                               |
| `engineering_branch_application_receipts`                                   | Insert-only final effects                                                                         |
| `engineering_release_handoffs`                                              | Insert-only body; nullable revocation pointer set only by exact rollback transaction              |
| `engineering_branch_rollback_plans` / `decisions` / `journals` / `receipts` | Same exact-state and append-only rules as application                                             |
| `engineering_integrity_incidents`                                           | Append-only bounded incident state/evidence; no raw secrets or provider bodies                    |

There is no generic `updateRequest(patch)` API. Repositories expose named transition methods with
expected version/state and exact evidence IDs. Database triggers reject evidence updates/deletes,
duplicate decision use, cross-request/cross-attempt references, candidate approval without passing
evidence, and ref receipts without a consumed matching decision/journal.

Decision rows never change after insert. One-use consumption is an immutable
`EngineeringApprovalConsumptionV1` row with a unique decision foreign key. Creating that row and the
attempt, host-exec spawn journal, branch-application `prepared` journal, or rollback `prepared`
journal is one transaction. Exact replay returns the existing consumption/effect; a conflicting
second effect fails.

The coordinator, author, reviewer, and dashboard receive narrower ports. Only the dashboard decision
service can insert operator decisions. Only the branch applicator can advance application journals
and receipts. Neither port is present in an agent/model composition.

### 9.2 Artifact store

Large patch, log, manifest, and rendered-summary bytes live under an owner-only control root, not in
the repository workspace. The server derives every path from a digest and artifact kind. Writes use:

1. owner-only directories and `umask 0077`;
2. exclusive create with no-follow behavior;
3. bounded write and streaming SHA-256;
4. file `fsync`, atomic same-filesystem rename, and parent-directory `fsync`;
5. insert of the canonical SQLite reference only after durable rename; and
6. read-time size, type, owner, mode, path, and SHA-256 verification.

Existing same-digest bytes are idempotent only when length/type/content match. Missing, mutated,
symlinked, oversized, or conflicting artifacts produce an integrity incident and remove the request
from approval readiness. Cleanup never follows links, never deletes a referenced artifact, and never
uses a caller path.

Logs are bounded and secret-scrubbed before retention. Truncation is explicit. A truncated log may
support diagnosis but cannot prove a passing assertion that was outside the retained structured
result.

## 10. Workspace, path, tenant, and secret isolation

### 10.1 Workspace construction

The workspace executor never receives the operator's current directory as a writable root. A
protected repository registration resolves the repository object store, exact immutable base commit,
and a server-created owner-only workspace root. Preparation:

1. verifies the registered repository path, revision, object type, and base tree;
2. creates a fresh `0700` parent with an exclusive server-derived name;
3. materializes only registered base-tree regular files, without hooks, filters, submodules, or LFS;
4. verifies a bounded path/mode/blob manifest against the Git tree;
5. supplies a private ephemeral home/temp/cache inside the sandbox rather than host `HOME`;
6. mounts or exposes the approved source subset read/write, the registered toolchain read-only, and
   only named scratch/output directories;
7. denies host home, repository `.git`, live index/worktree, control databases, tenant stores,
   memory graph, Keychain, `/tmp` outside the private root, device nodes, Unix sockets, and network;
8. runs deterministic sandbox self-tests; and
9. marks the lease ready only after all checks pass.

The production feature stays disabled on a host where these containment properties cannot be
demonstrated. “Best effort” directory discipline is not a sandbox.

### 10.2 Path rules

All model-visible paths are normalized relative repository paths. Validators reject:

- absolute paths, empty segments, `.`, `..`, NUL/control characters, backslashes, URI schemes, and
  platform-specific drive prefixes;
- non-NFC text, case-fold collisions, Unicode confusables rejected by policy, and names that change
  under normalization;
- `.git` at any depth, Git control files, hidden credential/config files, and registered secret or
  immutable-control paths;
- symlink or special-file leaves, symlink ancestors, hard-link counts outside the materialized tree,
  directory replacement races, and paths whose no-follow canonical parent escapes the workspace;
- unregistered additions/deletions, file/mode/type changes, and aggregate limits beyond the plan; and
- any path selected only because it appeared in operator/model text.

Reads are bounded and revalidate type/containment at open time. New files are exclusive-created under
the nearest verified parent. Replacements use a bounded temp file, file sync, atomic rename, and
parent sync. Search returns capped path/match/byte counts and never follows links.

### 10.3 Tenant boundary

Core repository self-editing uses authority scope `agency:engineering` and no tenant data plane.
`tenantId` is not an intake/API field. A ToolSmith-origin request retains a sealed tenant-provenance
digest so the operator can trace the idea, but the author receives only the persisted, bounded,
authorized proposal view. It receives no tenant artifact, raw input/output, filesystem root,
credential, queue/run port, or database query capability.

If a future change genuinely requires client material, V1 stops with `TENANT_FIXTURE_UNSUPPORTED`.
The operator must create a separate synthetic/redacted fixture through a future explicitly specified
lane. The system never guesses a tenant from prose, legacy frequency signatures, a path, or a model
suggestion.

### 10.4 Secret boundary

The author/reviewer/verifier environments contain no inherited tokens or credentials. The broker
constructs an exact environment from public deterministic values such as locale, registered
toolchain `PATH`, private temp/home paths, and non-secret build flags. It denies Keychain, SSH agent,
cloud metadata, Git credentials, package registries, browser profiles, agent secrets, local sockets,
and outbound/inbound network.

Registered secret-path checks run before every read. Secret-pattern/fingerprint and private-key
scans run over proposed prompt context, patches, generated artifacts, and retained output. The scan
records only rule IDs, counts, locations safe to display, and a digest; matched bytes are never
logged. A suspected secret is a nonretryable `SECRET_EXPOSURE_BLOCKED`, quarantines the workspace,
and prevents model continuation and approval readiness.

## 11. Model, tool, and continuation policy

### 11.1 Deterministic work before model work

Intake lookup, source authorization, repository/base resolution, allowed-path intersection, identity,
budget math, path validation, evidence verification, approval construction, branch application,
recovery, and release handoff are deterministic. A model is used only for architecture, bounded
authoring, and independent review where judgment is useful.

### 11.2 Typed tools

The initial V1 author set is narrow and server-issued:

- `repo.list_registered_paths`
- `repo.read_bounded_text`
- `repo.search_bounded_text`
- `workspace.apply_structured_patch`
- `workspace.inspect_diff_summary`
- `evidence.request_registered_test`
- `evidence.cite`
- `attempt.checkpoint`

None accepts an absolute root, tenant, executable, shell string, model, branch, approval, or release
argument. Tool outputs include the request/attempt/workspace/version binding. The reviewer gets only
bounded frozen-evidence read/citation tools. Release Verifier gets no model tools.

### 11.3 Continuation and budgets

The fixed V1 token/turn/tool/process/time/size ceilings and the required concrete cost cap in
`EngineeringExecutionPolicyV1` are enforced independently by the model adapter, tool dispatcher,
host-exec broker, wall-clock lease, and coordinator. A protected activation configuration sets the
positive cost cap under its separately reviewed deployment ceiling; the plan freezes that value and
catalog rather than inventing provider pricing in this design. There is no unlimited or null budget.

- Only one attempt and one host process may be active per request.
- There are at most three separately approved attempts and two revision cycles per attempt.
- The default route is at most Tier 2. Tier 3 requires an exact plan revision, cost disclosure, and
  separate operator approval; it cannot occur automatically after a weak answer.
- Provider retries do not reset token, time, tool, or cost accounting.
- Unknown token usage, missing pricing, partial cost coverage, or a changed pricing catalog halts
  before the next model call. It is displayed as unknown, never charged as zero.
- The model cannot recursively delegate. The one allowed depth represents the separately dispatched
  reviewer stage, with one independent session and no author continuation.
- Context is rebuilt from bounded source/evidence citations and the latest checkpoint. Hidden
  reasoning is neither requested nor persisted.
- Cancellation fences the attempt version, stops new tool calls, requests model cancellation, and
  terminates an active process group after the configured grace period. Evidence remains retained.

Expired checkpoints are not blindly resumed. Recovery must reauthorize the source, request state,
plan, base, policy, profile/model/tool revisions, workspace manifest, evidence set, lease, posture,
and remaining budget. Any mismatch abandons the attempt or supersedes the request.

## 12. Dashboard APIs and read models

### 12.1 Request rules

All mutation endpoints are same-origin dashboard APIs with authenticated local operator session,
fresh CSRF token, strict content type/size, exact schema, unknown-field rejection, and per-session
rate limits. A caller never supplies tenant, repository root, filesystem path, allowed path set,
model ID, tool/executable ID, environment, command, branch/ref, Git commit body, or approval receipt.

Recommended endpoints are:

| Method and path                                                                 | Strict request body                                                      | Result                                                            |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| `POST /api/v1/dashboard/engineering-change-previews`                            | `{ sourceKind, sourceRecordId, expectedSourceVersion }`                  | Expiring server-owned intake preview; no request/workspace effect |
| `POST /api/v1/dashboard/engineering-change-requests`                            | `{ previewId, previewFingerprint, expectedSourceVersion }`               | Idempotent confirmed request                                      |
| `GET /api/v1/dashboard/engineering-change-requests`                             | Bounded query params: cursor, state, limit                               | Authorized summaries, max server limit                            |
| `GET /api/v1/dashboard/engineering-change-requests/:requestId`                  | None                                                                     | Detail read model and current exact version                       |
| `GET .../:requestId/events`                                                     | Bounded cursor/limit                                                     | Event timeline                                                    |
| `GET .../:requestId/attempts`                                                   | Bounded cursor/limit                                                     | Attempt/stage/usage summaries                                     |
| `GET .../:requestId/evidence/:evidenceId`                                       | None                                                                     | Authorized bounded evidence metadata                              |
| `GET .../:requestId/diff?cursor=…`                                              | Server cursor only                                                       | Escaped bounded diff chunks with manifest binding                 |
| `POST .../:requestId/attempt-approval-previews`                                 | `{ expectedRequestVersion }`                                             | Current exact plan preview/challenge                              |
| `POST .../:requestId/attempt-decisions`                                         | `{ challengeId, expectedRequestVersion, approvalFingerprint, decision }` | One-use exact plan decision                                       |
| `POST .../:requestId/host-executions/:hostExecutionRequestId/approval-previews` | `{ expectedRequestVersion }`                                             | Current exact process-effect preview                              |
| `POST .../:requestId/host-executions/:hostExecutionRequestId/decisions`         | `{ challengeId, expectedRequestVersion, approvalFingerprint, decision }` | One-use host-exec decision                                        |
| `POST .../:requestId/application-approval-previews`                             | `{ expectedRequestVersion }`                                             | Recomputed exact branch application preview                       |
| `POST .../:requestId/application-decisions`                                     | `{ challengeId, expectedRequestVersion, approvalFingerprint, decision }` | One-use exact branch decision                                     |
| `POST .../:requestId/rollback-approval-previews`                                | `{ expectedRequestVersion }`                                             | Exact revert preview when eligible                                |
| `POST .../:requestId/rollback-decisions`                                        | `{ challengeId, expectedRequestVersion, approvalFingerprint, decision }` | One-use exact rollback decision                                   |
| `POST .../:requestId/cancellations`                                             | `{ expectedRequestVersion, reasonCode }`                                 | Version-fenced cancellation                                       |
| `POST .../:requestId/archive`                                                   | `{ expectedRequestVersion }`                                             | Terminal read-model archival only                                 |

Source IDs refer to records the authenticated server scope can already read. ToolSmith handoff passes
only a stable proposal ID/version; the server looks it up and derives its sealed scope. A
conversation handoff passes only a message ID/sequence; intent text is reread from the durable
conversation. There is no free-form “execute this” body outside the conversation itself.

A conversation source must resolve to an append-only `operator` / `operator_input` message at the
exact stored sequence in an `agency-developer` conversation under the agency trust domain. The
server binds that sequence and message-body digest; an agent response, another profile/domain, or a
changed conversation checkpoint is not an eligible source.

Approval challenges are single-use, short-lived, bound to the current authenticated UI session, and
stored by digest. If the review surface cannot render every required field/evidence state, it must
disable approval and return `APPROVAL_VIEW_INCOMPLETE`. Chat, Telegram, a headless route, and a CLI
fallback cannot create decisions.

### 12.2 Read models

```ts
interface EngineeringChangeSummaryViewV1 {
  requestId: string;
  title: string; // bounded escaped server projection
  sourceKind: EngineeringSourceV1['kind'];
  state: EngineeringChangeRequestState;
  requestVersion: number;
  baseRevisionShort: string;
  currentStage: string;
  evidenceReadiness: 'not_ready' | 'ready' | 'stale' | 'corrupt' | 'unsupported';
  approvalNeeded: 'none' | 'attempt' | 'host_execution' | 'application' | 'rollback';
  changedFileCount: number | null;
  usage: EngineeringUsageV1;
  lastEventAt: CanonicalUtc;
}

interface EngineeringChangeDetailViewV1 {
  summary: EngineeringChangeSummaryViewV1;
  intentSummary: string;
  repositoryLabel: string;
  baseRevision: string;
  authoritySummary: Readonly<{
    allowedPathLabels: readonly string[];
    immutableControls: readonly string[];
    deniedCapabilities: readonly string[];
  }>;
  plan: EngineeringPlanReviewViewV1 | null;
  attempts: readonly EngineeringAttemptSummaryViewV1[];
  candidate: EngineeringCandidateReviewViewV1 | null;
  currentApproval: ExactApprovalReviewViewV1 | null;
  releaseHandoff: ReleaseHandoffViewV1 | null;
  allowedOperatorActions: readonly EngineeringOperatorAction[];
}
```

Allowed actions are derived server-side from current state, expected version, evidence integrity,
auth context, and policy. The client never invents an enabled action from state text alone.

## 13. Agent Workbench UI

The feature lives inside the existing `agency-developer` Agent Workbench, adjacent to the persistent
conversation that created it. The developer profile remains human-rooted. Crew stages are visible
as work performed on the operator's request, not autonomous agents with independent authority.

The workbench adds:

- an explicit “Start governed change” action on an exact operator message;
- a read-only ToolSmith-origin card whose action opens Developer with proposal ID/version only;
- request list and detail views with base, scope, state, stage, attempts, usage, budgets, and failure;
- an immutable timeline for architecture, Code Blue, Code Red, Release Verifier, decisions,
  application, handoff, and rollback;
- a bounded file tree and virtualized escaped diff with old/new blob hashes and truncation markers;
- separate test-first, focused-test, review-finding, release-gate, toolchain, host-command, usage/cost,
  secret-scan, and policy panels;
- exact approval sheets that truthfully name the effect: model/tool spend, host process execution,
  local branch creation/update, or local revert;
- clear stale/expired/corrupt/unsupported/unknown-cost states with approval disabled;
- reject, cancel, retry-as-new-plan, and exact rollback controls; and
- a handoff panel that says “not pushed, not merged, not released” and exposes only branch/evidence
  identifiers for the separate process.

Approval requires the operator to expand and successfully load the scope, diff summary, all blocking
findings, command list, test/gate status, budget/usage coverage, target ref/prior head, and full short
fingerprint. The server also records a fresh user-presence gesture. UI convenience cannot hide a
failed or unknown item behind a green aggregate.

The page meets keyboard-only navigation, visible focus, screen-reader labels/status announcements,
reduced-motion, 200% zoom, 390 px mobile, tablet, and desktop requirements. Diff/log content is text,
never inserted as HTML. Long lines, malicious filenames, ANSI/control sequences, RTL controls, and
model-supplied Markdown cannot escape the component. Browser navigation and restart preserve the
server state; they do not duplicate decisions.

Page Studio remains unchanged and data-only. It gets no change-request widget, tool picker, terminal,
repository path, diff, or approval action. ToolSmith remains proposal-only/non-executing; its
dashboard no longer recomputes on read once the reliability roadmap persistence task lands, and the
handoff action cannot create work without an additional exact operator confirmation in Developer.

## 14. Branch application and dirty-tree preservation

The candidate commit is precomputed before approval from the exact base parent, candidate tree,
fixed author/committer identity, canonical timestamp, and bounded message. Release Verifier tests
that exact commit in a fresh clean checkout. The application plan therefore names the commit SHA
before the operator decides.

Before approval, that commit exists only in the isolated candidate object bundle and immutable
evidence store. No ref in the registered operator repository points to it, and candidate preparation
does not import objects into or otherwise mutate that repository.

The branch applicator is not the author host-exec broker. It has a narrower registration that can:

1. verify the registered repository object store without changing HEAD/index/worktree;
2. verify the exact Git executable/toolchain bytes and sanitized environment;
3. verify or import only the approved base/tree/commit objects;
4. assert the target is exactly `refs/heads/codex/ecr-<full requestId>`;
5. assert the protected source base ref still equals `expectedSourceBaseRefHead`;
6. deny every protected target and symbolic ref;
7. compare the current target value to `expectedPriorHead`;
8. update the one target ref with an atomic compare-and-set and a fixed reflog message; and
9. reread the ref/object/tree and commit the receipt.

It never checks out the target or uses the operator index. Before preparing the journal, a read-only
snapshot records the operator worktree's current HEAD, branch, index digest, tracked-diff digest,
untracked path/type/size/content-digest manifest, and status digest without retaining file contents.
Snapshot hashing is streaming and bounded; if the complete dirty state cannot be proven within the
protected limits, application is denied before journal preparation. After the ref effect, the same
snapshot must be byte-equivalent. Any difference is a P0 integrity incident; the UI reports the ref
effect separately as applied or unknown, never as a clean success, and automatic cleanup/rollback is
forbidden until an operator investigates.

An existing exact target ref at the exact approved commit plus the matching completed receipt is an
idempotent replay. An existing ref at any other value is `BRANCH_REF_CONFLICT`; the applicator does
not merge, reset, force-update, rename, or select a new branch.

## 15. Restart, crash recovery, and cleanup

### 15.1 General recovery rules

On startup, the coordinator scans only bounded nonterminal rows and expired leases. For each it:

1. validates schema/version and the event hash chain;
2. resolves the registered workspace path internally and verifies owner, mode, type, no-follow
   containment, base, manifest, and policy;
3. fences the old lease and process instance;
4. validates current posture, request/version/state, base/ref, profile/tool/model revisions, evidence
   digests, and remaining budgets;
5. resumes only from a complete immutable checkpoint with an explicitly safe next action; and
6. otherwise quarantines the workspace and records `RECOVERY_REQUIRES_NEW_ATTEMPT` or an integrity
   incident.

Recovery never reconstructs authority from prompt text or directory contents. It never assumes a
process failed merely because its PID is absent, nor succeeded because a file/ref exists.

### 15.2 Host-process ambiguity

A crash after spawn but before a complete receipt yields `effect_unknown`. The process group is
reconciled/terminated if still present, output paths and source tree are inspected, and the command
is not automatically replayed. Tests are expected to be side-effect-contained, but a new exact
host-exec plan and fresh approval are still required. Unknown evidence cannot pass a gate.

### 15.3 Branch journal

Application and rollback use the same four durable phases:

```text
prepared
  -> object_written
  -> ref_updated
  -> receipt_committed
```

`prepared` contains the consumed decision ID, exact old/new ref values, object/body digests,
applicator/toolchain/environment fingerprints, and operator-worktree-before digest. Recovery rules
are deterministic:

- At `prepared`, if the ref is old and the object is absent, it may safely continue the exact plan.
- At `object_written`, if the object bytes match and the ref is old, it may perform the exact CAS.
- At `ref_updated`, if the ref is new and all objects/worktree snapshots match, it reconstructs the
  deterministic receipt and commits it; it does not update the ref again.
- If a completed receipt and exact ref exist, replay returns the receipt.
- If the ref is neither old nor new, object bytes differ, the operator worktree changed, the decision
  is missing/conflicting, or evidence cannot be read, recovery stops with an integrity incident.

No recovery path moves a protected ref, changes a checked-out branch, deletes a branch/workspace, or
selects rollback on its own.

### 15.4 Retention and disposal

Workspaces are retained while a request is nonterminal, an approval is active, a journal is
incomplete, or an incident references them. Terminal workspaces become eligible after the protected
retention interval. Disposal is a separate bounded janitor with a database-issued exact path/manifest
claim, owner/type/no-follow revalidation, lease/receipt reference checks, and retained disposal
receipt. Quarantined paths require operator resolution. Evidence packages and application/rollback
receipts follow the release evidence retention policy and outlive disposable workspaces.

## 16. Failure and retry semantics

Every failure has a registered safe code, operator-safe message, retry class, state effect, and
incident severity. Raw provider/OS/model text is not a failure code.

| Failure class/examples                                                 | Automatic behavior                                                               | Operator path                                           |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Strict decode, canonicalization, identity conflict                     | No retry; no partial write; integrity incident on persisted collision            | Correct client/version or investigate corruption        |
| Source unauthorized/stale, base or policy drift                        | No retry; mark `superseded` before effects                                       | Create fresh preview/request                            |
| Sandbox unavailable/self-test failure                                  | No unsandboxed fallback; attempt fails or feature `unsupported`                  | Repair host and approve a new attempt                   |
| Traversal, symlink, special file, protected path, authority broadening | Immediate nonretryable failure; quarantine                                       | External security review/new policy, not model revision |
| Secret/path/tenant boundary trigger                                    | Immediate nonretryable failure; stop model/process; P0/P1 incident as classified | Investigate without exposing matched bytes              |
| Model provider timeout/429/temporary transport                         | At most two provider retries from same checkpoint within all existing budgets    | New separately approved attempt after exhaustion        |
| Unknown usage/pricing or budget exhaustion                             | No further model call; no inferred zero                                          | New plan with disclosed budget or supported catalog     |
| Model/tool invalid request                                             | No automatic retry of same bytes; one bounded correction turn if policy permits  | Revision/new attempt                                    |
| Expected red test does not fail for expected assertion                 | Evidence invalid; Code Blue may revise test within cycle budget                  | New plan/attempt when cycles exhausted                  |
| Focused test or review asks revision                                   | Revision cycle, not infrastructure retry; maximum two                            | New separately approved attempt after limit             |
| Release gate fail/inconclusive                                         | Candidate cannot be approval-ready; no automatic waiver                          | New plan/attempt                                        |
| SQLite busy/temporary artifact I/O before effect                       | At most two bounded retries with same idempotency identity                       | Failure/incident after exhaustion                       |
| Host exec timeout/cancel/crash ambiguity                               | Kill/reconcile; record `effect_unknown`; never auto-replay                       | Fresh exact execution approval                          |
| Approval stale/expired/replayed/wrong principal/UI unavailable         | Deny with zero effect; no decision synthesis                                     | Reload complete review and decide again                 |
| Branch target CAS mismatch or candidate/base/toolchain drift           | No retry, merge, or alternate branch                                             | Fresh candidate/application plan                        |
| Crash in known journal phase                                           | Deterministic recovery rules only                                                | Incident if state is ambiguous                          |
| Rollback ref advanced                                                  | No reset/revert/force                                                            | New governed remediation request                        |

Retry counters and wake times are durable. Retries never reset request attempt, model token, tool,
host-exec, cost, or wall-clock budgets. A retry after policy/profile/toolchain change is a new plan,
not a continuation. After three request attempts, the request is terminal `failed`; the operator may
create a new request linked by provenance, not silently raise the limit.

## 17. TDD-first implementation and verification

Implementation follows failing tests before production code. The first code change for each slice is
the named negative/contract test; no component is composed into the gateway while its boundary tests
are missing.

### 17.1 Canonical contract and repository tests

- Golden IDs for every formula above across fresh processes and fixed field ordering.
- Duplicate keys, unknown fields, noncanonical JSON, unsafe integers, negative zero, invalid UTC,
  oversized fields, invalid domain tags, normalization collisions, and delimiter ambiguity fail.
- Exact replay is idempotent; same ID/different immutable body is `INTEGRITY_CONFLICT`.
- Every legal state edge passes and every missing/skipped/stale/conflicting edge fails atomically.
- Database trigger tests prove no evidence update/delete, cross-request reference, second decision
  use, unproved candidate approval, or receipt without journal/decision.
- Migration/reopen tests prove state, events, leases, artifacts, approvals, journals, and receipts
  survive restart.

### 17.2 Workspace and process security tests

- Begin with an intentionally dirty operator worktree and snapshot HEAD, branch, index, tracked diff,
  untracked paths, file bytes, and status; every success/failure/cancel/crash case leaves it exact.
- Traversal, absolute paths, symlink ancestors/leaves, hard-link escape, FIFO/socket/device, Unicode
  and case collisions, race replacement, `.git`, protected paths, and limit exhaustion fail closed.
- Sandbox fixtures cannot read host home, current repository worktree, tenant/memory/control DBs,
  Keychain, SSH agent, sockets, or network and cannot write outside registered paths.
- Architecture tests prove filesystem sandbox, tool allowlist, and host-exec approval are distinct
  ports. Denying a tool cannot be represented as read-only filesystem access.
- `shell`, `terminal`, command strings, wildcards, `sh -c`, `bash -c`, unregistered interpreters,
  package install/fetch, hooks, submodules, and LFS filters are rejected.
- Vary executable path, executable bytes, argv value/order, cwd, environment, base, plan, patch,
  sandbox, timeout, output set, request version, principal, or expiry one at a time; each invalidates
  host-exec approval.
- Approval UI unavailable, incomplete evidence rendering, stale challenge, CSRF failure, replay, and
  headless/chat/Telegram decisions all deny without spawn/ref effect.
- Command source mutation, output overflow, timeout, cancellation, orphan process, and crash after
  spawn yield bounded evidence and no automatic replay.
- Secret canaries in files, environment, patch, stdout/stderr, model context, and generated artifacts
  never reach retained raw output or another principal.

### 17.3 Authoring and evidence tests

- A source change before expected red-test evidence is rejected.
- Red evidence must fail on the exact intermediate tree for the registered assertion, then focused
  evidence must pass on the exact candidate tree.
- Documentation-only exemption is issued only by server path registry and still requires review/gate.
- Changed/deleted/grader/authority/dependency/lockfile/mode/binary/symlink files fail deterministic
  candidate validation.
- Code Red has a distinct session/profile revision, receives frozen read-only evidence, and cannot
  write, use author continuation, approve, or release.
- Open blocker/high findings, stale disposition, missing review, or nonacceptable verdict deny
  readiness.
- Release Verifier has no model/author tools, uses a clean exact commit, fixed toolchain/gate, and
  cannot waive or mutate a check.
- Missing, corrupt, cross-candidate, truncated-inconclusive, stale, or digest-mismatched evidence
  disables approval.
- Budget boundaries are exact; missing usage/pricing is unknown and halts; retries charge the same
  durable budget; Tier 3 never auto-falls back.

### 17.4 Approval, application, and rollback tests

- Application approval fingerprint has a golden fixture covering every field in Section 7.5.
- Mutation of any bound digest/field between render, submit, decision commit, and branch effect denies
  with no partial ref/application receipt.
- Agent, reviewer, verifier, ToolSmith, blueprint, queue worker, Telegram, and generic action-proposal
  compositions have no decision-writer import/capability.
- Approval copy truthfully names its effect; no “no runtime effect” component can dispatch the branch
  applicator.
- Target ref derivation is full-ID deterministic; caller branch/ref fields and protected refs fail.
- Existing exact ref/receipt replays idempotently; absent, diverged, symbolic, checked-out, or
  protected refs never cause merge/reset/force/alternate selection.
- Planned commit bytes/tree equal the verified candidate and applied result exactly.
- Crash injection at before/after every journal/database/filesystem/ref boundary follows Section 15,
  including receipt reconstruction after known ref success and stop on ambiguity.
- Application and recovery never change operator HEAD/index/worktree/untracked bytes.
- Handoff has literal `executionEligibility`, merge/push/release authority `none`; architecture spies
  prove no network/Git-host/release/installer port.
- Rollback requires a fresh exact decision, applies only when head equals candidate, creates the exact
  revert commit, revokes but retains handoff, and never claims deployment rollback.

### 17.5 Dashboard tests

- Strict API request tests prove no tenant/repository/path/tool/model/environment/command/branch fields
  are accepted and every source lookup is server-authorized.
- List/detail/diff/evidence pagination and artifact reads are bounded and cross-request access fails.
- Malicious model prose, diff content, filenames, ANSI/control/RTL text, and Markdown render as inert
  text; content security policy and clean console remain green.
- Stale websocket/poll/read-model data never enables an action; server-projected actions and fresh
  version are required.
- Keyboard, screen reader, visible focus, reduced motion, 200% zoom, 390 px mobile, tablet, desktop,
  refresh, back/forward, and reconnect flows pass.
- Page Studio has no engineering mutation surface. ToolSmith read does not analyze or execute and its
  button passes only proposal ID/version into a separate confirmed flow.

Focused suites run while iterating. Before any activation claim, the one canonical `release:gate`
must pass from a clean candidate checkout with its exact pinned Node/toolchain manifest. Coverage,
lint, type, format, build, architecture, graph, and diff-integrity thresholds are not lowered.

## 18. Production acceptance

The workbench ships disabled. “Implemented” means code and focused tests exist; “production-ready”
requires all evidence below.

### 18.1 Golden-path retained evidence

From the live dashboard and a registered base revision, while the operator worktree contains known
tracked and untracked dirt:

1. Start from one exact conversation message and separately exercise a ToolSmith-origin preview.
2. Confirm a server-owned request and plan with disclosed scope, commands, model/tool/cost limits.
3. Produce retained expected-red evidence before implementation, passing focused evidence after,
   independent Code Red acceptance, and a passing clean full release gate.
4. Restart gateway/coordinator/browser between every major stage and prove exact continuation.
5. Review every evidence panel and approve one application fingerprint with fresh user presence.
6. Apply the exact precomputed commit to the derived local branch and retain journal/receipt.
7. Prove the operator's dirty worktree/index/branch and all known dirty bytes are unchanged.
8. Produce an inert release handoff and prove no push, merge, PR, install, launchd, schedule, or
   release effect occurred.
9. Approve an exact rollback, create the precomputed revert commit, revoke the handoff, and retain all
   prior evidence.

The entire scenario is replayed after process and database reopen. All IDs, fingerprints, receipts,
and final state remain stable.

### 18.2 Negative and fault campaign

Run an automated clone for every negative in Sections 17.1–17.5 plus:

- cancellation and crash at every state, artifact-write, DB transaction, model checkpoint, process
  spawn/exit, evidence freeze, approval consumption, object write, ref CAS, and receipt boundary;
- sandbox absence/escape attempt, network/Keychain/socket access, secret canaries, cross-tenant source,
  path races, resource exhaustion, stale posture, policy/toolchain/profile/pricing drift;
- wrong base/plan/patch/test/review/gate/usage/cwd/argv/env/executable/ref/principal/user-presence
  bindings and approval UI outage;
- concurrent duplicate submissions, conflicting retries, two coordinators, expired leases, and
  diverged application/rollback refs; and
- gateway/agent/reviewer/ToolSmith/blueprint attempts to import decision, ref, release, installer, or
  arbitrary-process capability.

Every fault must produce a durable safe state or bounded observable incident. None may silently
approve, spawn, broaden scope, leak a secret, modify the live worktree, update a protected ref, merge,
push, or release.

### 18.3 Reliability and operator handoff gate

Task 32 remains coupled to the reliability spine:

- the accelerated 14-slot reliability campaign passes with its own golden and fault evidence;
- the real 14-day window has 14/14 verified/finalized/notified jobs, signed start/end attestations,
  and no unresolved P0/P1, hold, drift, or exhausted notification;
- live browser security/accessibility checks and an independent code/security review pass;
- the canonical candidate release gate and hosted protected CI evidence pass;
- recovery and exact branch rollback drills pass on the production host;
- the operator handoff explains source confirmation, every approval effect, stale/unknown states,
  cancellation, evidence export, branch handoff, local rollback limits, and the separate release
  process; and
- the feature is enabled only by a separately reviewed protected configuration revision whose digest
  appears in the acceptance evidence.

There is no waiver path for a missing sandbox, missing approval UI, unknown usage, missing evidence,
dirty candidate checkout, failed gate, or absent release-spine acceptance. A failed real campaign
restarts at a new signed boundary after exact remediation.

## 19. Implementation sequence and ownership

The implementation order preserves dormant safety until the full effect path is testable:

1. Add canonical identity factories/golden tests and strict engineering contracts.
2. Add append-only migrations/repositories, event chain, typed transition procedures, and reopen
   tests with no gateway composition.
3. Add protected repository/path/tool/executable/sandbox policy registrations.
4. Add isolated workspace materialization, typed read/search/patch tools, resource bounds, secret
   scans, and crash-safe retention with adversarial tests.
5. Add durable attempt coordinator/checkpoints/model accounting; keep model route disabled until
   pricing, sandbox, and approval dependencies report ready.
6. Wire Architect and Code Blue under the exact attempt approval; add per-execution approval broker.
7. Add independent Code Red and deterministic Release Verifier compositions and evidence freeze.
8. Add bounded Agent Workbench read APIs/UI, then exact attempt/host-exec decisions.
9. Add branch-application preview/decision repository while the applicator remains a fake/spy.
10. Add the narrow journaled branch applicator and rollback behind a disabled feature flag; complete
    crash/CAS/dirty-tree tests.
11. Add inert release handoff integration with the reliability release inputs, without any release
    effect.
12. Run complete production acceptance and only then enable the protected configuration.

Expected module boundaries are:

```text
src/reliability/identities.ts                    canonical ID factories only
src/engineering/contracts.ts                     strict DTOs/unions/validators
src/engineering/policy-registry.ts                protected repository/path/tool ceilings
src/engineering/repository.ts                     named state/evidence transactions
src/engineering/artifact-store.ts                 digest-addressed immutable artifacts
src/engineering/workspace-executor.ts             sandbox materialization and typed patching
src/engineering/host-exec-broker.ts               exact approved direct spawn only
src/engineering/change-coordinator.ts             request/attempt state machines
src/engineering/evidence-service.ts               test/review/gate validation and freeze
src/engineering/approval-service.ts               dashboard-only exact decisions
src/engineering/branch-applicator.ts               one-ref journaled CAS effect
src/engineering/recovery.ts                        bounded deterministic reconciliation
src/engineering/release-handoff.ts                 inert handoff/rollback records
src/dashboard/engineering-change-service.ts        scoped read models/previews
src/dashboard/routes.ts                            strict same-origin endpoints
public/dashboard/assets/app.js                     Agent Workbench views only
```

The actual file split may vary, but capability imports may not collapse. In particular, agent/model
modules must fail architecture tests if they import approval writers, raw process APIs, branch/ref
writers, secrets, network clients, installer, or release mutation ports.

## 20. Requirement traceability

| ID     | Requirement                                         | Mandatory proof                                                                                           |
| ------ | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| GSE-01 | Operator-controlled self-editing, no self-approval  | Exact UI decisions, principal/user-presence binding, architecture-denial tests                            |
| GSE-02 | Page Studio data-only and ToolSmith non-executing   | UI/route absence tests and zero-effect ToolSmith architecture spies                                       |
| GSE-03 | Immutable request/base/scope/authority ceiling      | Strict contracts, canonical golden IDs, DB immutability and drift tests                                   |
| GSE-04 | Independent sandbox, tool, and host-exec controls   | Process-boundary, intersection, command-binding, and unavailable-layer deny tests                         |
| GSE-05 | Tenant/path/secret isolation                        | Traversal/race/symlink/tenant/Keychain/network/secret-canary matrix                                       |
| GSE-06 | TDD authoring and independent evaluation            | Red-before-source guard, focused pass, separate reviewer, clean fixed release gate                        |
| GSE-07 | Immutable patch/test/review/gate evidence           | Digest/reopen/cross-binding/corruption/truncation tests and retained package                              |
| GSE-08 | Bounded model/tool continuation and economics       | Turn/token/tool/process/time/cost ceilings, unknown-usage halt, checkpoint/restart tests                  |
| GSE-09 | Exact branch application without live-tree mutation | Full approval fingerprint, planned commit equality, one-ref CAS, dirty-tree invariance                    |
| GSE-10 | Crash-safe replay and conservative ambiguity        | Lease fencing, every-boundary fault injection, durable journals, no automatic unknown replay              |
| GSE-11 | Inert release handoff and exact local rollback      | Literal no-authority fields, zero network/release ports, exact revert/ref-divergence tests                |
| GSE-12 | Production acceptance                               | Full release gate, browser/security/accessibility, golden/negative campaigns, reliability 14-day evidence |

## 21. Final invariants

The implementation is conformant only while all of these remain true:

1. An operator action begins and approves the work; no agent or observational system can do so.
2. Request text can narrow an outcome but cannot choose tenant, repository root, path ceiling, tools,
   executable, environment, model, branch, approval, or release authority.
3. Page Studio is data-only and ToolSmith is proposal-only/non-executing.
4. Sandbox containment, tool authorization, and exact host-exec approval are separate deny-first
   layers; no broad shell token bypasses them.
5. The live operator worktree, index, branch, and uncommitted bytes are never edited.
6. Every attempt, workspace, command, patch, test, review, gate, approval, ref effect, handoff, and
   rollback is exact-state, canonically identified, durable, bounded, and replay-safe.
7. Missing, stale, corrupt, unknown, unmetered, or ambiguous evidence denies progress.
8. Test-first authoring, independent read-only review, and the clean fixed release gate all precede
   operator application review.
9. Approval binds the exact cwd, argv, sanitized environment, executable path/digest, base, plan,
   patch, evidence, policy, ref, prior state, principal, expiry, and user presence.
10. Branch application updates only one derived local `codex/` ref by CAS; it cannot merge, push,
    install, activate, or release.
11. Rollback is a new exact operator-approved local revert, not an autonomous recovery decision or a
    production rollback claim.
12. The independent reliability release path remains the only route from reviewed source to attested
    live activation.

This design intentionally stops at a reviewed local branch and inert handoff. That is the boundary
that lets Jarvis improve its own code without becoming its own approver, grader, deployer, or source
of production truth.
