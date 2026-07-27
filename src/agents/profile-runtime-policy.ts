import { z } from 'zod';

import { AppError } from '../utils/errors';
import {
  AgentLifecycleSchema,
  AgentProfileSchema,
  AgentRuntimeModeSchema,
  type AgentLifecycle,
  type AgentProfile,
  type AgentRuntimeMode
} from './profile-catalog';

export const AgentMemoryCellSchema = z.enum(['full', 'run_bounded']);
export const AgentCheckpointModeSchema = z.enum(['stage_checkpoint_v1', 'fail_closed']);
export const AgentRuntimeExecutionSchema = z.enum(['enabled', 'not_configured', 'disabled']);

export type AgentMemoryCell = z.infer<typeof AgentMemoryCellSchema>;
export type AgentCheckpointMode = z.infer<typeof AgentCheckpointModeSchema>;
export type AgentRuntimeExecution = z.infer<typeof AgentRuntimeExecutionSchema>;

const LIFECYCLE_POLICY = {
  durable: {
    memoryCell: 'full',
    checkpointMode: 'stage_checkpoint_v1'
  },
  template: {
    memoryCell: 'run_bounded',
    checkpointMode: 'fail_closed'
  }
} as const satisfies Readonly<
  Record<
    AgentLifecycle,
    Readonly<{
      memoryCell: AgentMemoryCell;
      checkpointMode: AgentCheckpointMode;
    }>
  >
>;

const EXECUTION_BY_RUNTIME_MODE = {
  deterministic: 'enabled',
  profile_only: 'not_configured',
  disabled: 'disabled'
} as const satisfies Readonly<Record<AgentRuntimeMode, AgentRuntimeExecution>>;

const AgentRuntimePolicyRecordSchema = z
  .strictObject({
    profileId: AgentProfileSchema.shape.id,
    profileRevision: AgentProfileSchema.shape.revision,
    lifecycle: AgentLifecycleSchema,
    runtimeMode: AgentRuntimeModeSchema,
    execution: AgentRuntimeExecutionSchema,
    memoryCell: AgentMemoryCellSchema,
    checkpointMode: AgentCheckpointModeSchema
  })
  .superRefine((policy, context) => {
    const lifecyclePolicy = LIFECYCLE_POLICY[policy.lifecycle];
    if (
      policy.memoryCell !== lifecyclePolicy.memoryCell ||
      policy.checkpointMode !== lifecyclePolicy.checkpointMode
    ) {
      context.addIssue({
        code: 'custom',
        path: ['lifecycle'],
        message: 'memory cell and checkpoint mode must exactly match the profile lifecycle'
      });
    }

    if (policy.execution !== EXECUTION_BY_RUNTIME_MODE[policy.runtimeMode]) {
      context.addIssue({
        code: 'custom',
        path: ['execution'],
        message: 'execution availability must exactly match the profile runtime mode'
      });
    }
  });

export const AgentRuntimePolicySchema = AgentRuntimePolicyRecordSchema.transform((policy) =>
  Object.freeze(policy)
);

export type AgentRuntimePolicy = z.infer<typeof AgentRuntimePolicySchema>;

export type ExecutableAgentRuntimePolicy = AgentRuntimePolicy &
  Readonly<{
    runtimeMode: 'deterministic';
    execution: 'enabled';
  }>;

export class AgentRuntimeUnavailableError extends AppError {
  constructor(policy: AgentRuntimePolicy) {
    super(503, 'AGENT_RUNTIME_UNAVAILABLE', 'Agent execution runtime is not available', {
      profileId: policy.profileId,
      profileRevision: policy.profileRevision,
      runtimeMode: policy.runtimeMode,
      execution: policy.execution
    });
    this.name = 'AgentRuntimeUnavailableError';
  }
}

/**
 * Resolves cell and checkpoint behavior only from lifecycle. Runtime
 * availability remains an independent, fail-closed decision.
 */
export function resolveAgentRuntimePolicy(profile: AgentProfile): AgentRuntimePolicy {
  return AgentRuntimePolicySchema.parse({
    profileId: profile.id,
    profileRevision: profile.revision,
    lifecycle: profile.lifecycle,
    runtimeMode: profile.runtimeMode,
    execution: EXECUTION_BY_RUNTIME_MODE[profile.runtimeMode],
    ...LIFECYCLE_POLICY[profile.lifecycle]
  });
}

export function isAgentRuntimeExecutable(
  policy: AgentRuntimePolicy
): policy is ExecutableAgentRuntimePolicy {
  return policy.runtimeMode === 'deterministic' && policy.execution === 'enabled';
}

export function assertAgentRuntimeExecutable(
  policy: AgentRuntimePolicy
): asserts policy is ExecutableAgentRuntimePolicy {
  if (!isAgentRuntimeExecutable(policy)) throw new AgentRuntimeUnavailableError(policy);
}
