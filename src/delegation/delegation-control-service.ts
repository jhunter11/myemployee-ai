import { createHash } from 'node:crypto';

import {
  CommandPrincipalSchema,
  ServerScopeBindingSchema,
  type CommandPrincipal,
  type ServerScopeBinding
} from '../commands/contracts';
import { AppError } from '../utils/errors';
import {
  CancelDelegationRunRequestSchema,
  CreateDelegationRootRequestSchema,
  DelegateRunRequestSchema,
  DelegationRunRecordSchema,
  FinishDelegationRunRequestSchema,
  RecordDelegationSpanRequestSchema,
  RetryDelegationRunRequestSchema,
  StartDelegationRunRequestSchema,
  type DelegationProjection,
  type DelegationRunRecord,
  type DelegationSpanRecord
} from './contracts';
import { DelegationConflictError, DelegationNotFoundError } from './delegation-repository';
import type { SqliteDelegationRepository } from './delegation-repository';

export interface DelegationControlPolicy {
  maxDepth: number;
  maxFanOut: number;
  maxAttempts: number;
}

export class DelegationAccessDeniedError extends AppError {
  constructor(message: string) {
    super(403, 'DELEGATION_ACCESS_DENIED', message);
    this.name = 'DelegationAccessDeniedError';
  }
}

function digest(parts: readonly (string | number | null)[]): string {
  return `sha256:${createHash('sha256').update(parts.join('\u001f')).digest('hex')}`;
}

function runId(input: {
  binding: ServerScopeBinding;
  principal: CommandPrincipal;
  idempotencyKey: string;
}): string {
  return `run:${createHash('sha256')
    .update(
      [
        input.binding.scopeId,
        input.binding.tenantId,
        input.principal.id,
        input.principal.channel,
        input.idempotencyKey
      ].join('\u001f')
    )
    .digest('hex')}`;
}

function spanId(input: {
  binding: ServerScopeBinding;
  principal: CommandPrincipal;
  runId: string;
  idempotencyKey: string;
}): string {
  return `span:${createHash('sha256')
    .update(
      [
        input.binding.scopeId,
        input.binding.tenantId,
        input.principal.id,
        input.runId,
        input.idempotencyKey
      ].join('\u001f')
    )
    .digest('hex')}`;
}

function validatePolicy(policy: DelegationControlPolicy): DelegationControlPolicy {
  if (!Number.isInteger(policy.maxDepth) || policy.maxDepth < 1 || policy.maxDepth > 32) {
    throw new RangeError('maxDepth must be an integer between 1 and 32');
  }
  if (!Number.isInteger(policy.maxFanOut) || policy.maxFanOut < 1 || policy.maxFanOut > 64) {
    throw new RangeError('maxFanOut must be an integer between 1 and 64');
  }
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1 || policy.maxAttempts > 16) {
    throw new RangeError('maxAttempts must be an integer between 1 and 16');
  }
  return { ...policy };
}

function assertScopeBinding(binding: ServerScopeBinding): void {
  const expectedPrefix =
    binding.trustDomain === 'mcp_x402'
      ? 'mcp'
      : binding.trustDomain === 'system'
        ? 'harness'
        : binding.trustDomain;
  if (!binding.scopeId.startsWith(`${expectedPrefix}:`)) {
    throw new DelegationAccessDeniedError('Server scope binding does not match its trust domain');
  }
  if (
    (binding.trustDomain === 'personal' || binding.trustDomain === 'system') &&
    binding.tenantId !== null
  ) {
    throw new DelegationAccessDeniedError('This trust domain cannot bind a tenant');
  }
}

export function authorizeDelegationContext(input: {
  principal: unknown;
  binding: unknown;
  authority: 'read' | 'execute_internal';
}): { principal: CommandPrincipal; binding: ServerScopeBinding } {
  const principal = CommandPrincipalSchema.parse(input.principal);
  const binding = ServerScopeBindingSchema.parse(input.binding);
  assertScopeBinding(binding);
  if (!principal.authority.includes(input.authority)) {
    throw new DelegationAccessDeniedError(`Principal lacks ${input.authority} authority`);
  }
  if (input.authority === 'execute_internal' && principal.kind === 'channel_adapter') {
    throw new DelegationAccessDeniedError('Channel adapters cannot execute delegated work');
  }
  return { principal, binding };
}

function assertIdempotencyChannel(principal: CommandPrincipal, idempotencyKey: string): void {
  if (!idempotencyKey.startsWith(`${principal.channel}:`)) {
    throw new DelegationAccessDeniedError(
      'Idempotency key channel does not match authenticated principal'
    );
  }
}

function assertExactReplay(existing: DelegationRunRecord, requestDigest: string): void {
  if (existing.requestDigest !== requestDigest) {
    throw new DelegationConflictError(
      'DELEGATION_IDEMPOTENCY_CONFLICT',
      'Idempotency key was already bound to different delegation content'
    );
  }
}

export class DelegationControlService {
  private readonly now: () => string;
  private readonly policy: DelegationControlPolicy;

  constructor(
    private readonly options: {
      repository: SqliteDelegationRepository;
      policy: DelegationControlPolicy;
      now?: () => string;
    }
  ) {
    this.policy = validatePolicy(options.policy);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async createRoot(input: { principal: unknown; binding: unknown; request: unknown }): Promise<{
    run: DelegationRunRecord;
    replayed: boolean;
  }> {
    await Promise.resolve();
    const { principal, binding } = authorizeDelegationContext({
      principal: input.principal,
      binding: input.binding,
      authority: 'execute_internal'
    });
    const request = CreateDelegationRootRequestSchema.parse(input.request);
    assertIdempotencyChannel(principal, request.idempotencyKey);
    const id = runId({ binding, principal, idempotencyKey: request.idempotencyKey });
    const requestDigest = digest([
      'root',
      request.assignedAgentId,
      request.operationCode,
      request.inputDigest
    ]);
    const createdAt = new Date(this.now()).toISOString();
    const run = DelegationRunRecordSchema.parse({
      id,
      rootRunId: id,
      parentRunId: null,
      retryOfRunId: null,
      scopeId: binding.scopeId,
      trustDomain: binding.trustDomain,
      tenantId: binding.tenantId,
      policyVersion: binding.policyVersion,
      principalId: principal.id,
      channel: principal.channel,
      idempotencyKey: request.idempotencyKey,
      requestDigest,
      assignedAgentId: request.assignedAgentId,
      operationCode: request.operationCode,
      inputDigest: request.inputDigest,
      depth: 0,
      attempt: 1,
      status: 'queued',
      version: 1,
      maxDepth: this.policy.maxDepth,
      maxFanOut: this.policy.maxFanOut,
      maxAttempts: this.policy.maxAttempts,
      createdAt,
      updatedAt: createdAt,
      terminalAt: null
    });
    const result = this.options.repository.createRoot({ run, actorPrincipalId: principal.id });
    assertExactReplay(result.run, requestDigest);
    return { run: result.run, replayed: !result.created };
  }

  async delegate(input: { principal: unknown; binding: unknown; request: unknown }): Promise<{
    run: DelegationRunRecord;
    replayed: boolean;
  }> {
    await Promise.resolve();
    const { principal, binding } = authorizeDelegationContext({
      principal: input.principal,
      binding: input.binding,
      authority: 'execute_internal'
    });
    const request = DelegateRunRequestSchema.parse(input.request);
    assertIdempotencyChannel(principal, request.idempotencyKey);
    const parent = this.options.repository.findRun(binding, request.parentRunId);
    if (parent === null) throw new DelegationNotFoundError();
    const requestDigest = digest([
      'delegation',
      request.parentRunId,
      request.assignedAgentId,
      request.operationCode,
      request.inputDigest
    ]);
    const createdAt = new Date(this.now()).toISOString();
    const run = DelegationRunRecordSchema.parse({
      id: runId({ binding, principal, idempotencyKey: request.idempotencyKey }),
      rootRunId: parent.rootRunId,
      parentRunId: parent.id,
      retryOfRunId: null,
      scopeId: parent.scopeId,
      trustDomain: parent.trustDomain,
      tenantId: parent.tenantId,
      policyVersion: parent.policyVersion,
      principalId: principal.id,
      channel: principal.channel,
      idempotencyKey: request.idempotencyKey,
      requestDigest,
      assignedAgentId: request.assignedAgentId,
      operationCode: request.operationCode,
      inputDigest: request.inputDigest,
      depth: parent.depth + 1,
      attempt: 1,
      status: 'queued',
      version: 1,
      maxDepth: parent.maxDepth,
      maxFanOut: parent.maxFanOut,
      maxAttempts: parent.maxAttempts,
      createdAt,
      updatedAt: createdAt,
      terminalAt: null
    });
    const result = this.options.repository.createChild({
      run,
      parentRunId: parent.id,
      edgeKind: 'delegation',
      actorPrincipalId: principal.id,
      eventType: 'run_queued',
      eventCode: request.operationCode
    });
    assertExactReplay(result.run, requestDigest);
    if (result.run.parentRunId !== parent.id) {
      throw new DelegationConflictError(
        'DELEGATION_IDEMPOTENCY_CONFLICT',
        'Idempotency key was already bound to different delegation content'
      );
    }
    return { run: result.run, replayed: !result.created };
  }

  async startRun(input: {
    principal: unknown;
    binding: unknown;
    request: unknown;
  }): Promise<DelegationRunRecord> {
    await Promise.resolve();
    const { principal, binding } = authorizeDelegationContext({
      principal: input.principal,
      binding: input.binding,
      authority: 'execute_internal'
    });
    const request = StartDelegationRunRequestSchema.parse(input.request);
    return this.options.repository.transition({
      binding,
      runId: request.runId,
      expectedVersion: request.expectedVersion,
      from: 'queued',
      to: 'running',
      eventType: 'run_started',
      eventCode: 'worker_started',
      actorPrincipalId: principal.id,
      at: new Date(this.now()).toISOString()
    });
  }

  async finishRun(input: {
    principal: unknown;
    binding: unknown;
    request: unknown;
  }): Promise<DelegationRunRecord> {
    await Promise.resolve();
    const { principal, binding } = authorizeDelegationContext({
      principal: input.principal,
      binding: input.binding,
      authority: 'execute_internal'
    });
    const request = FinishDelegationRunRequestSchema.parse(input.request);
    return this.options.repository.transition({
      binding,
      runId: request.runId,
      expectedVersion: request.expectedVersion,
      from: 'running',
      to: request.outcome,
      eventType: request.outcome === 'succeeded' ? 'run_succeeded' : 'run_failed',
      eventCode: request.resultCode,
      actorPrincipalId: principal.id,
      evidenceDigest: request.evidenceDigest,
      at: new Date(this.now()).toISOString()
    });
  }

  async retryRun(input: { principal: unknown; binding: unknown; request: unknown }): Promise<{
    run: DelegationRunRecord;
    replayed: boolean;
  }> {
    await Promise.resolve();
    const { principal, binding } = authorizeDelegationContext({
      principal: input.principal,
      binding: input.binding,
      authority: 'execute_internal'
    });
    const request = RetryDelegationRunRequestSchema.parse(input.request);
    assertIdempotencyChannel(principal, request.idempotencyKey);
    const source = this.options.repository.findRun(binding, request.runId);
    if (source === null) throw new DelegationNotFoundError();
    const requestDigest = digest([
      'retry',
      source.id,
      source.assignedAgentId,
      source.operationCode,
      source.inputDigest,
      source.attempt + 1
    ]);
    const createdAt = new Date(this.now()).toISOString();
    const run = DelegationRunRecordSchema.parse({
      id: runId({ binding, principal, idempotencyKey: request.idempotencyKey }),
      rootRunId: source.rootRunId,
      parentRunId: source.id,
      retryOfRunId: source.id,
      scopeId: source.scopeId,
      trustDomain: source.trustDomain,
      tenantId: source.tenantId,
      policyVersion: source.policyVersion,
      principalId: principal.id,
      channel: principal.channel,
      idempotencyKey: request.idempotencyKey,
      requestDigest,
      assignedAgentId: source.assignedAgentId,
      operationCode: source.operationCode,
      inputDigest: source.inputDigest,
      depth: source.depth + 1,
      attempt: source.attempt + 1,
      status: 'queued',
      version: 1,
      maxDepth: source.maxDepth,
      maxFanOut: source.maxFanOut,
      maxAttempts: source.maxAttempts,
      createdAt,
      updatedAt: createdAt,
      terminalAt: null
    });
    const result = this.options.repository.createChild({
      run,
      parentRunId: source.id,
      edgeKind: 'retry',
      actorPrincipalId: principal.id,
      eventType: 'run_retried',
      eventCode: 'retry_scheduled',
      expectedParentVersion: request.expectedVersion
    });
    assertExactReplay(result.run, requestDigest);
    if (result.run.retryOfRunId !== source.id) {
      throw new DelegationConflictError(
        'DELEGATION_IDEMPOTENCY_CONFLICT',
        'Idempotency key was already bound to different delegation content'
      );
    }
    return { run: result.run, replayed: !result.created };
  }

  async requestCancellation(input: {
    principal: unknown;
    binding: unknown;
    request: unknown;
  }): Promise<{
    changedRunIds: string[];
    states: Partial<Record<'cancel_requested' | 'cancelled', number>>;
  }> {
    await Promise.resolve();
    const { principal, binding } = authorizeDelegationContext({
      principal: input.principal,
      binding: input.binding,
      authority: 'execute_internal'
    });
    const request = CancelDelegationRunRequestSchema.parse(input.request);
    return this.options.repository.cancelSubtree({
      binding,
      runId: request.runId,
      expectedVersion: request.expectedVersion,
      reasonCode: request.reasonCode,
      actorPrincipalId: principal.id,
      at: new Date(this.now()).toISOString()
    });
  }

  async acknowledgeCancellation(input: {
    principal: unknown;
    binding: unknown;
    request: unknown;
  }): Promise<DelegationRunRecord> {
    await Promise.resolve();
    const { principal, binding } = authorizeDelegationContext({
      principal: input.principal,
      binding: input.binding,
      authority: 'execute_internal'
    });
    const request = StartDelegationRunRequestSchema.parse(input.request);
    return this.options.repository.transition({
      binding,
      runId: request.runId,
      expectedVersion: request.expectedVersion,
      from: 'cancel_requested',
      to: 'cancelled',
      eventType: 'run_cancelled',
      eventCode: 'worker_cancelled',
      actorPrincipalId: principal.id,
      at: new Date(this.now()).toISOString()
    });
  }

  async recordSpan(input: {
    principal: unknown;
    binding: unknown;
    request: unknown;
  }): Promise<DelegationSpanRecord & { replayed: boolean }> {
    await Promise.resolve();
    const { principal, binding } = authorizeDelegationContext({
      principal: input.principal,
      binding: input.binding,
      authority: 'execute_internal'
    });
    const request = RecordDelegationSpanRequestSchema.parse(input.request);
    assertIdempotencyChannel(principal, request.idempotencyKey);
    const durationMs = Date.parse(request.endedAt) - Date.parse(request.startedAt);
    if (!Number.isInteger(durationMs) || durationMs < 0 || durationMs > 86_400_000) {
      throw new RangeError('span duration must be between 0 and 86400000 milliseconds');
    }
    const requestDigest = digest([
      'span',
      request.runId,
      request.parentSpanId,
      request.kind,
      request.nameCode,
      request.outcome,
      request.startedAt,
      request.endedAt,
      request.evidenceDigest ?? null
    ]);
    const result = this.options.repository.recordSpan({
      binding,
      runId: request.runId,
      principalId: principal.id,
      idempotencyKey: request.idempotencyKey,
      requestDigest,
      spanId: spanId({
        binding,
        principal,
        runId: request.runId,
        idempotencyKey: request.idempotencyKey
      }),
      parentSpanId: request.parentSpanId,
      kind: request.kind,
      nameCode: request.nameCode,
      outcome: request.outcome,
      startedAt: request.startedAt,
      endedAt: request.endedAt,
      durationMs,
      evidenceDigest: request.evidenceDigest,
      recordedAt: new Date(this.now()).toISOString()
    });
    if (result.requestDigest !== requestDigest) {
      throw new DelegationConflictError(
        'DELEGATION_IDEMPOTENCY_CONFLICT',
        'Idempotency key was already bound to different span content'
      );
    }
    return { ...result.span, replayed: !result.created };
  }

  async snapshot(input: {
    principal: unknown;
    binding: unknown;
    rootRunId: unknown;
    limit: unknown;
  }): Promise<DelegationProjection> {
    await Promise.resolve();
    const { binding } = authorizeDelegationContext({
      principal: input.principal,
      binding: input.binding,
      authority: 'read'
    });
    const request = StartDelegationRunRequestSchema.pick({ runId: true }).extend({
      limit: StartDelegationRunRequestSchema.shape.expectedVersion.min(1).max(200)
    });
    const parsed = request.parse({ runId: input.rootRunId, limit: input.limit });
    return this.options.repository.snapshot(binding, parsed.runId, parsed.limit);
  }
}
