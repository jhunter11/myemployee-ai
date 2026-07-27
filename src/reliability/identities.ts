import { canonicalUtcTimestamp, domainSeparatedSha256 } from './canonical';

const MAX_IDENTITY_FIELD_BYTES = 512;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const CODE_PATTERN = /^[a-z][a-z0-9_]{0,127}$/u;

const COMPLETION_PROJECTION_KINDS = [
  'artifact',
  'run_memory',
  'diagram',
  'frequency',
  'release'
] as const;
const CONTROL_MUTATION_KINDS = ['release_cutover', 'trust_registry_sync'] as const;
const EXECUTION_SOURCE_KINDS = ['schedule', 'api'] as const;
const FINALIZATION_ACTIONS = ['finalize_verified', 'finalize_rejected'] as const;
const VERIFICATION_REASON_CODES = [
  'criteria_missing',
  'binding_mismatch',
  'source_missing',
  'source_mismatch',
  'output_invalid',
  'artifact_missing',
  'artifact_unsafe',
  'artifact_mismatch',
  'verifier_timeout',
  'verifier_crash',
  'proof_persistence_failed',
  'verification_interrupted',
  'verification_unavailable'
] as const;
const ARTIFACT_ABANDONMENT_REASONS = [
  'source_snapshot_failed',
  'worker_failed',
  'commit_failed',
  'hold_cas_failed',
  'startup_orphan'
] as const;

export type CompletionProjectionKind = (typeof COMPLETION_PROJECTION_KINDS)[number];
export type ControlMutationKind = (typeof CONTROL_MUTATION_KINDS)[number];
export type FinalizationAction = (typeof FINALIZATION_ACTIONS)[number];
export type VerificationReasonCode = (typeof VERIFICATION_REASON_CODES)[number];
export type ArtifactAbandonmentReasonCode = (typeof ARTIFACT_ABANDONMENT_REASONS)[number];

function assertStrictInput(input: unknown, expectedKeys: readonly string[]): void {
  if (
    input === null ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    ![Object.prototype, null].includes(Reflect.getPrototypeOf(input))
  ) {
    throw new TypeError('Identity input must be a plain object with exact registered fields');
  }

  const actualKeys = Reflect.ownKeys(input);
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key))
  ) {
    throw new TypeError('Identity input must contain only its exact registered fields');
  }
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError('Identity input fields must be enumerable data properties');
    }
  }
}

function field(name: string, value: string): string {
  if (typeof value !== 'string') {
    throw new TypeError(`${name} must be a string`);
  }
  if (value.length === 0 || value !== value.trim()) {
    throw new TypeError(`${name} must be a non-empty canonical string`);
  }
  if (Buffer.byteLength(value, 'utf8') > MAX_IDENTITY_FIELD_BYTES) {
    throw new RangeError(`${name} exceeds ${MAX_IDENTITY_FIELD_BYTES} UTF-8 bytes`);
  }
  if (/\p{Cc}/u.test(value)) {
    throw new TypeError(`${name} cannot contain control characters`);
  }
  return value;
}

function positiveInteger(name: string, value: number): string {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return String(value);
}

function oneOf<T extends string>(name: string, value: string, allowed: readonly T[]): T {
  if (!allowed.includes(value as T)) {
    throw new TypeError(`${name} is not a registered protocol value`);
  }
  return value as T;
}

function sha256(name: string, value: string): string {
  if (!SHA256_PATTERN.test(value)) {
    throw new TypeError(`${name} must be a lowercase 64-character SHA-256 value`);
  }
  return value;
}

function code(name: string, value: string): string {
  if (!CODE_PATTERN.test(value)) {
    throw new TypeError(`${name} must be a registered lowercase protocol code`);
  }
  return value;
}

function identity(domainTag: string, fields: ReadonlyArray<readonly [string, string]>): string {
  return domainSeparatedSha256(
    domainTag,
    fields.map(([name, value]) => field(name, value))
  );
}

export function createOccurrenceId(input: {
  scheduleId: string;
  scheduleVersion: number;
  scheduledFor: string;
}): string {
  assertStrictInput(input, ['scheduleId', 'scheduleVersion', 'scheduledFor']);
  return identity('occurrence:v1', [
    ['scheduleId', input.scheduleId],
    ['scheduleVersion', positiveInteger('scheduleVersion', input.scheduleVersion)],
    ['scheduledFor', canonicalUtcTimestamp(input.scheduledFor)]
  ]);
}

export function createExecutionRequestId(input: {
  sourceKind: 'schedule' | 'api';
  sourceId: string;
  tenantId: string;
  automationId: string;
}): string {
  assertStrictInput(input, ['sourceKind', 'sourceId', 'tenantId', 'automationId']);
  const sourceKind = oneOf('sourceKind', input.sourceKind, EXECUTION_SOURCE_KINDS);
  return identity('execution-request:v1', [
    ['sourceKind', sourceKind],
    ['sourceId', sourceKind === 'schedule' ? sha256('sourceId', input.sourceId) : input.sourceId],
    ['tenantId', input.tenantId],
    ['automationId', input.automationId]
  ]);
}

export function createQueueTaskId(input: {
  executionRequestId: string;
  tenantId: string;
  automationId: string;
}): string {
  assertStrictInput(input, ['executionRequestId', 'tenantId', 'automationId']);
  return identity('queue-task:v1', [
    ['executionRequestId', sha256('executionRequestId', input.executionRequestId)],
    ['tenantId', input.tenantId],
    ['automationId', input.automationId]
  ]);
}

export function createRunId(input: { executionRequestId: string; queueTaskId: string }): string {
  assertStrictInput(input, ['executionRequestId', 'queueTaskId']);
  return identity('run:v1', [
    ['executionRequestId', sha256('executionRequestId', input.executionRequestId)],
    ['queueTaskId', sha256('queueTaskId', input.queueTaskId)]
  ]);
}

export function createArtifactClaimId(input: {
  artifactScopeKey: string;
  executionRequestId: string;
  runId: string;
}): string {
  assertStrictInput(input, ['artifactScopeKey', 'executionRequestId', 'runId']);
  return identity('artifact-claim:v1', [
    ['artifactScopeKey', input.artifactScopeKey],
    ['executionRequestId', sha256('executionRequestId', input.executionRequestId)],
    ['runId', sha256('runId', input.runId)]
  ]);
}

export function createSourceClaimId(input: {
  artifactClaimId: string;
  sourceRegistrationId: string;
}): string {
  assertStrictInput(input, ['artifactClaimId', 'sourceRegistrationId']);
  return identity('source-snapshot:v1', [
    ['artifactClaimId', sha256('artifactClaimId', input.artifactClaimId)],
    ['sourceRegistrationId', input.sourceRegistrationId]
  ]);
}

export function createArtifactAbandonmentEvidenceId(input: {
  artifactClaimId: string;
  expectedClaimVersion: number;
  reasonCode: ArtifactAbandonmentReasonCode;
}): string {
  assertStrictInput(input, ['artifactClaimId', 'expectedClaimVersion', 'reasonCode']);
  return identity('artifact-abandonment:v1', [
    ['artifactClaimId', sha256('artifactClaimId', input.artifactClaimId)],
    ['expectedClaimVersion', positiveInteger('expectedClaimVersion', input.expectedClaimVersion)],
    ['reasonCode', oneOf('reasonCode', input.reasonCode, ARTIFACT_ABANDONMENT_REASONS)]
  ]);
}

export function createVerificationHoldId(input: {
  tenantId: string;
  queueTaskId: string;
  leasedVersion: number;
  queueAttempt: number;
  runId: string;
}): string {
  assertStrictInput(input, ['tenantId', 'queueTaskId', 'leasedVersion', 'queueAttempt', 'runId']);
  return identity('verification-hold:v1', [
    ['tenantId', input.tenantId],
    ['queueTaskId', sha256('queueTaskId', input.queueTaskId)],
    ['leasedVersion', positiveInteger('leasedVersion', input.leasedVersion)],
    ['queueAttempt', positiveInteger('queueAttempt', input.queueAttempt)],
    ['runId', sha256('runId', input.runId)]
  ]);
}

export function createVerificationAttemptId(input: {
  holdId: string;
  verifierRevision: string;
  subattempt: number;
}): string {
  assertStrictInput(input, ['holdId', 'verifierRevision', 'subattempt']);
  return identity('verification-attempt:v1', [
    ['holdId', sha256('holdId', input.holdId)],
    ['verifierRevision', input.verifierRevision],
    ['subattempt', positiveInteger('subattempt', input.subattempt)]
  ]);
}

export function createVerifiedSettlementId(input: { holdId: string; attemptId: string }): string {
  assertStrictInput(input, ['holdId', 'attemptId']);
  return identity('verified-settlement:v1', [
    ['holdId', sha256('holdId', input.holdId)],
    ['attemptId', sha256('attemptId', input.attemptId)],
    ['outcome', 'succeeded']
  ]);
}

export function createFailedSettlementId(input: {
  holdId: string;
  attemptId: string;
  reasonCode: VerificationReasonCode;
}): string {
  assertStrictInput(input, ['holdId', 'attemptId', 'reasonCode']);
  return identity('failed-settlement:v1', [
    ['holdId', sha256('holdId', input.holdId)],
    ['attemptId', sha256('attemptId', input.attemptId)],
    ['reasonCode', oneOf('reasonCode', input.reasonCode, VERIFICATION_REASON_CODES)]
  ]);
}

export function createProjectionJobId(input: {
  settlementId: string;
  finalizationAction: FinalizationAction;
}): string {
  assertStrictInput(input, ['settlementId', 'finalizationAction']);
  return identity('completion-projection:v1', [
    ['settlementId', sha256('settlementId', input.settlementId)],
    [
      'finalizationAction',
      oneOf('finalizationAction', input.finalizationAction, FINALIZATION_ACTIONS)
    ]
  ]);
}

export function createProjectionReceiptKey(input: {
  runId: string;
  projectionKind: CompletionProjectionKind;
  projectorVersion: string;
}): string {
  assertStrictInput(input, ['runId', 'projectionKind', 'projectorVersion']);
  return identity('projection-receipt:v1', [
    ['runId', sha256('runId', input.runId)],
    ['projectionKind', oneOf('projectionKind', input.projectionKind, COMPLETION_PROJECTION_KINDS)],
    ['projectorVersion', input.projectorVersion]
  ]);
}

export function createIncidentId(input: {
  kind: string;
  subjectId: string;
  policyVersion: string;
}): string {
  assertStrictInput(input, ['kind', 'subjectId', 'policyVersion']);
  return identity('incident:v1', [
    ['kind', code('kind', input.kind)],
    ['subjectId', sha256('subjectId', input.subjectId)],
    ['policyVersion', input.policyVersion]
  ]);
}

export function createAcceptedLossDecisionId(input: {
  incidentId: string;
  expectedIncidentVersion: number;
  subjectId: string;
  remediationEvidenceSha256: string;
  newCampaignBoundarySha256: string;
}): string {
  assertStrictInput(input, [
    'incidentId',
    'expectedIncidentVersion',
    'subjectId',
    'remediationEvidenceSha256',
    'newCampaignBoundarySha256'
  ]);
  return identity('accepted-loss:v1', [
    ['incidentId', sha256('incidentId', input.incidentId)],
    [
      'expectedIncidentVersion',
      positiveInteger('expectedIncidentVersion', input.expectedIncidentVersion)
    ],
    ['subjectId', sha256('subjectId', input.subjectId)],
    [
      'remediationEvidenceSha256',
      sha256('remediationEvidenceSha256', input.remediationEvidenceSha256)
    ],
    [
      'newCampaignBoundarySha256',
      sha256('newCampaignBoundarySha256', input.newCampaignBoundarySha256)
    ]
  ]);
}

export function createNotificationId(input: {
  eventKind: string;
  eventId: string;
  bindingDigest: string;
  templateVersion: string;
}): string {
  assertStrictInput(input, ['eventKind', 'eventId', 'bindingDigest', 'templateVersion']);
  return identity('notification:v1', [
    ['eventKind', code('eventKind', input.eventKind)],
    ['eventId', sha256('eventId', input.eventId)],
    ['bindingDigest', sha256('bindingDigest', input.bindingDigest)],
    ['templateVersion', input.templateVersion]
  ]);
}

export function createToolSmithProposalId(input: {
  tenantId: string;
  automationId: string;
  ruleVersion: string;
}): string {
  assertStrictInput(input, ['tenantId', 'automationId', 'ruleVersion']);
  return identity('toolsmith:v1', [
    ['tenantId', input.tenantId],
    ['automationId', input.automationId],
    ['ruleVersion', input.ruleVersion]
  ]);
}

export function createControlMutationId(input: {
  kind: ControlMutationKind;
  planFingerprint: string;
  expectedPriorStateSha256: string;
}): string {
  assertStrictInput(input, ['kind', 'planFingerprint', 'expectedPriorStateSha256']);
  return identity('control-mutation:v1', [
    ['kind', oneOf('kind', input.kind, CONTROL_MUTATION_KINDS)],
    ['planFingerprint', sha256('planFingerprint', input.planFingerprint)],
    ['expectedPriorStateSha256', sha256('expectedPriorStateSha256', input.expectedPriorStateSha256)]
  ]);
}
