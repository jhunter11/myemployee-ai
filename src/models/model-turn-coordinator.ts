import { z } from 'zod';

import { ClientIdSchema } from '../config/schemas';
import { ModelRouteInputSchema, type ModelRouteInput } from '../economics/contracts';
import {
  ModelExecutionProviderSchema,
  ModelExecutionSurfaceSchema,
  ModelExecutionTierSchema,
  type ModelExecutionEnablement,
  type ModelExecutionSurface
} from '../economics/model-execution-enablement';
import {
  routeModelWork,
  type LogicalModelRoute,
  type ModelRouteReason
} from '../economics/model-router';
import { ModelGenerationRequestSchema, type ModelGenerationRequest } from './contracts';
import type {
  ModelExecutionAdmissionFence,
  ModelExecutionInput,
  ModelExecutionOutcome,
  ModelExecutor,
  ModelOperation
} from './model-executor';

/**
 * The fixed pre-LLM limits are deliberately narrower than the provider adapter
 * schemas. Adapters remain reusable low-level components; every production turn
 * must cross this aggregate context/output/time boundary first.
 */
export const MODEL_TURN_LIMITS = Object.freeze({
  maxInputUtf8Bytes: 131_072,
  maxEstimatedInputTokens: 32_768,
  maxOutputTokens: 4_096,
  maxTimeoutMs: 120_000,
  maxReasons: 8
});

export type ModelTurnBoundaryErrorCode =
  | 'INVALID_SURFACE'
  | 'INVALID_CLIENT_SCOPE'
  | 'INVALID_REQUEST'
  | 'TOOLS_NOT_SUPPORTED'
  | 'CONTEXT_LIMIT_EXCEEDED'
  | 'OUTPUT_LIMIT_EXCEEDED'
  | 'TIMEOUT_LIMIT_EXCEEDED';

const ERROR_MESSAGES: Record<ModelTurnBoundaryErrorCode, string> = {
  INVALID_SURFACE: 'model turn surface binding is invalid',
  INVALID_CLIENT_SCOPE: 'model turn client binding is invalid',
  INVALID_REQUEST: 'model turn request is invalid',
  TOOLS_NOT_SUPPORTED: 'model turn tools are not supported',
  CONTEXT_LIMIT_EXCEEDED: 'model turn context limit exceeded',
  OUTPUT_LIMIT_EXCEEDED: 'model turn output limit exceeded',
  TIMEOUT_LIMIT_EXCEEDED: 'model turn timeout limit exceeded'
};

/**
 * Stable, content-free validation failure. It intentionally does not retain the
 * Zod error or raw request, so prompt bytes cannot leak through an error message.
 */
export class ModelTurnBoundaryError extends Error {
  constructor(readonly code: ModelTurnBoundaryErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'ModelTurnBoundaryError';
  }
}

export interface ModelTurnEnablementReader {
  current(): Promise<ModelExecutionEnablement>;
}

export interface ModelTurnExecutor {
  execute(
    input: ModelExecutionInput,
    admission: ModelExecutionAdmissionFence
  ): Promise<ModelExecutionOutcome>;
}

export type ModelTurnCoordinatorReason =
  ModelRouteReason | 'ENABLEMENT_UNAVAILABLE' | 'SURFACE_NOT_ENABLED' | 'ENABLEMENT_CHANGED';

interface ModelTurnOutcomeBase {
  tier: 0 | 1 | 2 | 3;
  route: LogicalModelRoute;
  enablementVersion: number | null;
  reasons: ModelTurnCoordinatorReason[];
}

export type ModelTurnCoordinatorOutcome =
  | (ModelTurnOutcomeBase & {
      status: 'not_required';
      fallback: 'deterministic';
      tier: 0;
      route: 'deterministic';
    })
  | (ModelTurnOutcomeBase & {
      status: 'denied';
    })
  | (ModelTurnOutcomeBase & {
      status: 'executed';
      tier: 1 | 2 | 3;
      route: 'local' | 'economy' | 'frontier';
      execution: ModelExecutionOutcome;
    });

const ModelTurnRequestSchema = z.strictObject({
  route: ModelRouteInputSchema,
  generation: ModelGenerationRequestSchema
});

/**
 * The durable repository already validates this record. The coordinator parses
 * it again at the trust boundary because fakes, future readers, or corrupt
 * implementations must not turn malformed state into execution authority.
 */
const ModelExecutionEnablementRecordSchema = z
  .strictObject({
    enabled: z.boolean(),
    version: z.number().int().min(1),
    updatedAt: z.iso.datetime(),
    updatedBy: z.string().trim().min(3).max(160),
    reason: z.string().trim().min(3).max(160),
    approver: z.string().trim().min(3).max(160).nullable(),
    approvedAt: z.iso.datetime().nullable(),
    allowedTiers: z.array(ModelExecutionTierSchema).max(3),
    allowedSurfaces: z.array(ModelExecutionSurfaceSchema).max(8),
    allowedProviders: z.array(ModelExecutionProviderSchema).max(8)
  })
  .superRefine((record, context) => {
    const consistent = record.enabled
      ? record.approver !== null &&
        record.approvedAt !== null &&
        record.allowedTiers.length > 0 &&
        record.allowedSurfaces.length > 0 &&
        record.allowedProviders.length > 0
      : record.approver === null &&
        record.approvedAt === null &&
        record.allowedTiers.length === 0 &&
        record.allowedSurfaces.length === 0 &&
        record.allowedProviders.length === 0;
    if (!consistent) {
      context.addIssue({
        code: 'custom',
        message: 'enablement approval/allow-list state is inconsistent'
      });
    }
  });

interface ParsedModelTurnRequest {
  route: ModelRouteInput;
  generation: ModelGenerationRequest;
}

function parseRequest(raw: unknown): ParsedModelTurnRequest {
  const parsed = ModelTurnRequestSchema.safeParse(raw);
  if (!parsed.success) throw new ModelTurnBoundaryError('INVALID_REQUEST');
  if (parsed.data.generation.tools !== undefined) {
    throw new ModelTurnBoundaryError('TOOLS_NOT_SUPPORTED');
  }

  const inputUtf8Bytes =
    Buffer.byteLength(parsed.data.generation.system, 'utf8') +
    parsed.data.generation.messages.reduce(
      (total, message) => total + Buffer.byteLength(message.content, 'utf8'),
      0
    );
  const estimatedInputTokens = Math.ceil(inputUtf8Bytes / 4);
  if (
    inputUtf8Bytes > MODEL_TURN_LIMITS.maxInputUtf8Bytes ||
    estimatedInputTokens > MODEL_TURN_LIMITS.maxEstimatedInputTokens
  ) {
    throw new ModelTurnBoundaryError('CONTEXT_LIMIT_EXCEEDED');
  }
  if (parsed.data.generation.maxOutputTokens > MODEL_TURN_LIMITS.maxOutputTokens) {
    throw new ModelTurnBoundaryError('OUTPUT_LIMIT_EXCEEDED');
  }
  if (parsed.data.generation.timeoutMs > MODEL_TURN_LIMITS.maxTimeoutMs) {
    throw new ModelTurnBoundaryError('TIMEOUT_LIMIT_EXCEEDED');
  }

  return { route: parsed.data.route, generation: parsed.data.generation };
}

function boundedReasons(
  reasons: readonly ModelTurnCoordinatorReason[]
): ModelTurnCoordinatorReason[] {
  return [...new Set(reasons)].slice(0, MODEL_TURN_LIMITS.maxReasons);
}

function sameArray<T extends number | string>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function gateChanged(before: ModelExecutionEnablement, after: ModelExecutionEnablement): boolean {
  return (
    before.version !== after.version ||
    before.enabled !== after.enabled ||
    !sameArray(before.allowedTiers, after.allowedTiers) ||
    !sameArray(before.allowedSurfaces, after.allowedSurfaces) ||
    !sameArray(before.allowedProviders, after.allowedProviders)
  );
}

function modelOperation(workType: ModelRouteInput['workType']): ModelOperation {
  switch (workType) {
    case 'classification':
    case 'extraction':
    case 'drafting':
    case 'summarization':
    case 'synthesis':
    case 'code':
    case 'review':
      return workType;
    case 'deterministic':
      throw new Error('deterministic work must not reach the model executor');
  }
}

/**
 * Trusted coordination boundary for one text-only model surface and tenant.
 *
 * Surface and client scope are constructor-bound, never request-selected. Raw
 * text can choose neither a tenant nor a provider. The provider-agnostic router
 * evaluates the full durable enablement record, and a second read fences the
 * kill switch and every execution allow-list immediately before the low-level
 * executor call.
 */
export class ModelTurnCoordinator {
  private readonly surface: ModelExecutionSurface;
  private readonly clientId: string | null;
  private readonly enablement: ModelTurnEnablementReader;
  private readonly executor: ModelTurnExecutor;

  constructor(options: {
    surface: unknown;
    clientId: unknown;
    enablement: ModelTurnEnablementReader;
    executor: ModelTurnExecutor | ModelExecutor;
  }) {
    const surface = ModelExecutionSurfaceSchema.safeParse(options.surface);
    if (!surface.success) throw new ModelTurnBoundaryError('INVALID_SURFACE');
    const clientId = ClientIdSchema.nullable().safeParse(options.clientId);
    if (!clientId.success) throw new ModelTurnBoundaryError('INVALID_CLIENT_SCOPE');

    this.surface = surface.data;
    this.clientId = clientId.data;
    this.enablement = options.enablement;
    this.executor = options.executor;
  }

  async execute(raw: unknown): Promise<ModelTurnCoordinatorOutcome> {
    const input = parseRequest(raw);
    const initial = await this.readEnablement();
    const decision = routeModelWork(
      input.route,
      initial === null
        ? undefined
        : {
            enabled: initial.enabled,
            allowedTiers: [...initial.allowedTiers],
            version: initial.version
          }
    );

    if (decision.route === 'deterministic') {
      return {
        status: 'not_required',
        fallback: 'deterministic',
        tier: 0,
        route: 'deterministic',
        enablementVersion: initial?.version ?? null,
        reasons: boundedReasons(decision.reasons)
      };
    }
    if (decision.tier === 0) {
      throw new Error('non-deterministic model route cannot use tier zero');
    }

    if (initial === null) {
      return {
        status: 'denied',
        tier: decision.tier,
        route: decision.route,
        enablementVersion: null,
        reasons: ['ENABLEMENT_UNAVAILABLE']
      };
    }

    if (!decision.modelExecutionAllowed) {
      return {
        status: 'denied',
        tier: decision.tier,
        route: decision.route,
        enablementVersion: initial.version,
        reasons: boundedReasons(decision.reasons)
      };
    }

    if (!initial.allowedSurfaces.includes(this.surface)) {
      return {
        status: 'denied',
        tier: decision.tier,
        route: decision.route,
        enablementVersion: initial.version,
        reasons: boundedReasons(['SURFACE_NOT_ENABLED', ...decision.reasons])
      };
    }

    // This is intentionally the final awaited dependency before execute().
    const current = await this.readEnablement();
    if (current === null) {
      return {
        status: 'denied',
        tier: decision.tier,
        route: decision.route,
        enablementVersion: null,
        reasons: ['ENABLEMENT_UNAVAILABLE']
      };
    }
    if (gateChanged(initial, current)) {
      return {
        status: 'denied',
        tier: decision.tier,
        route: decision.route,
        enablementVersion: current.version,
        reasons: ['ENABLEMENT_CHANGED']
      };
    }

    const admissionState: {
      version: number | null;
      reason: 'ENABLEMENT_UNAVAILABLE' | 'ENABLEMENT_CHANGED';
    } = {
      version: current.version,
      reason: 'ENABLEMENT_CHANGED'
    };
    const admission: ModelExecutionAdmissionFence = {
      enablementVersion: current.version,
      revalidate: async (enablementVersion) => {
        if (enablementVersion !== current.version) return false;
        const latest = await this.readEnablement();
        if (latest === null) {
          admissionState.version = null;
          admissionState.reason = 'ENABLEMENT_UNAVAILABLE';
          return false;
        }
        admissionState.version = latest.version;
        if (gateChanged(current, latest)) {
          admissionState.reason = 'ENABLEMENT_CHANGED';
          return false;
        }
        return true;
      }
    };
    const execution = await this.executor.execute(
      {
        operation: modelOperation(input.route.workType),
        clientId: this.clientId,
        route: decision.route,
        generation: input.generation,
        allowedProviders: [...current.allowedProviders]
      },
      admission
    );
    if (execution.status === 'admission_revoked') {
      return {
        status: 'denied',
        tier: decision.tier,
        route: decision.route,
        enablementVersion: admissionState.version,
        reasons: [admissionState.reason]
      };
    }
    return {
      status: 'executed',
      tier: decision.tier,
      route: decision.route,
      enablementVersion: current.version,
      reasons: boundedReasons(decision.reasons),
      execution
    };
  }

  private async readEnablement(): Promise<ModelExecutionEnablement | null> {
    try {
      const record = await this.enablement.current();
      const parsed = ModelExecutionEnablementRecordSchema.safeParse(record);
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }
}
