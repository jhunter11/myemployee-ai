import { z } from 'zod';

const BlueprintIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{2,63}$/);
const OperationalIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/);
const ScopeIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{2,31}:[A-Za-z0-9._:-]{2,127}$/);
const GrantIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{1,62}\.[a-z][a-z0-9_-]{1,62}$/);
export const BlueprintDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);

const UniqueStringArraySchema = <T extends z.ZodType<string>>(member: T, maximum: number) =>
  z
    .array(member)
    .max(maximum)
    .refine((values) => new Set(values).size === values.length, 'values must be unique');

export const BlueprintActorSchema = z.strictObject({
  id: OperationalIdSchema,
  kind: z.enum(['human', 'agent', 'system'])
});

export const BlueprintProposerSchema = z.strictObject({
  id: OperationalIdSchema,
  kind: z.enum(['human', 'agent', 'research_feed'])
});

export const BlueprintStateSchema = z.enum([
  'proposed',
  'sandboxed',
  'evaluated',
  'awaiting_approval',
  'shadow',
  'canary',
  'active',
  'rejected',
  'rolled_back',
  'retired'
]);

export const BlueprintGatePolicySchema = z.strictObject({
  requiredTrials: z.number().int().min(1).max(100),
  requireCompleteTrajectories: z.literal(true),
  requireHiddenHoldouts: z.literal(true),
  maxPolicyViolations: z.literal(0),
  maxScopeViolations: z.literal(0),
  maxBudgetBreaches: z.literal(0),
  maxIrreversibleEffects: z.literal(0),
  maxQualityRegressionBps: z.number().int().min(0).max(10_000),
  maxInterventionIncreaseBps: z.number().int().min(0).max(10_000)
});

export const BlueprintEconomicsPolicySchema = z.strictObject({
  pricingVersion: z.string().trim().min(1).max(128),
  minKnownCostCoverageBps: z.number().int().min(1).max(10_000),
  maxCostPerSuccessfulTaskMicrousd: z.number().int().min(0).max(1_000_000_000_000),
  maxP95LatencyMs: z.number().int().min(1).max(86_400_000),
  maxUnexplainedCostIncreaseBps: z.number().int().min(0).max(10_000)
});

export const BlueprintGateObservationSchema = z.strictObject({
  policy: z.strictObject({
    policyViolations: z.number().int().min(0).max(1_000_000),
    scopeViolations: z.number().int().min(0).max(1_000_000),
    budgetBreaches: z.number().int().min(0).max(1_000_000),
    irreversibleEffects: z.number().int().min(0).max(1_000_000),
    trialsCompleted: z.number().int().min(0).max(1_000_000),
    trajectoriesComplete: z.boolean(),
    hiddenHoldoutsPassed: z.boolean(),
    qualityRegressionBps: z.number().int().min(-10_000).max(10_000),
    interventionIncreaseBps: z.number().int().min(-10_000).max(10_000)
  }),
  economics: z.strictObject({
    pricingVersion: z.string().trim().min(1).max(128).nullable(),
    knownCostCoverageBps: z.number().int().min(0).max(10_000),
    successfulTasks: z.number().int().min(0).max(1_000_000),
    costPerSuccessfulTaskMicrousd: z.number().int().min(0).max(1_000_000_000_000).nullable(),
    p95LatencyMs: z.number().int().min(0).max(86_400_000).nullable(),
    unexplainedCostIncreaseBps: z.number().int().min(-10_000).max(10_000).nullable()
  })
});

export const BlueprintConfigSchema = z
  .strictObject({
    blueprintId: BlueprintIdSchema,
    revision: z.number().int().min(1).max(1_000_000),
    previousRevision: z.number().int().min(1).max(999_999).nullable(),
    ownerScopeId: ScopeIdSchema,
    objective: z.string().trim().min(1).max(2_000),
    inputContractDigest: BlueprintDigestSchema,
    outputContractDigest: BlueprintDigestSchema,
    workflowPattern: z.enum(['sequential', 'parallel_join', 'reviewer_loop']),
    implementationDigest: BlueprintDigestSchema,
    toolGrants: UniqueStringArraySchema(GrantIdSchema, 64),
    sleeveGrants: z
      .array(
        z.strictObject({
          sleeveId: ScopeIdSchema,
          permissions: UniqueStringArraySchema(z.enum(['read', 'append', 'write']), 3).min(1)
        })
      )
      .max(32),
    networkPolicy: z
      .strictObject({
        mode: z.enum(['none', 'allowlist']),
        allowedHosts: UniqueStringArraySchema(
          z.string().regex(/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/),
          32
        )
      })
      .superRefine((policy, context) => {
        if (policy.mode === 'none' && policy.allowedHosts.length !== 0) {
          context.addIssue({
            code: 'custom',
            path: ['allowedHosts'],
            message: 'network mode none cannot allow hosts'
          });
        }
        if (policy.mode === 'allowlist' && policy.allowedHosts.length === 0) {
          context.addIssue({
            code: 'custom',
            path: ['allowedHosts'],
            message: 'allowlist mode requires at least one host'
          });
        }
      }),
    sideEffectPolicy: z.enum(['none', 'reversible_internal']),
    budgets: z.strictObject({
      maxDurationMs: z.number().int().min(1_000).max(86_400_000),
      maxTurns: z.number().int().min(1).max(1_000),
      maxToolCalls: z.number().int().min(0).max(10_000),
      maxInputTokens: z.number().int().min(0).max(10_000_000),
      maxOutputTokens: z.number().int().min(0).max(10_000_000),
      maxCostMicrousd: z.number().int().min(0).max(1_000_000_000_000),
      maxDepth: z.number().int().min(0).max(32),
      maxFanout: z.number().int().min(0).max(128)
    }),
    evalSuite: z.strictObject({
      suiteId: BlueprintIdSchema,
      revision: z.number().int().min(1).max(1_000_000),
      graderDigest: BlueprintDigestSchema,
      hiddenHoldoutDigest: BlueprintDigestSchema
    }),
    gatePolicy: BlueprintGatePolicySchema,
    economicsPolicy: BlueprintEconomicsPolicySchema,
    rollout: z.strictObject({
      shadowMode: z.literal('read_only'),
      canaryTaskCount: z.number().int().min(1).max(100),
      canaryRisk: z.literal('low'),
      canaryEffects: z.literal('reversible_internal')
    }),
    provenance: z.strictObject({
      sourceKind: z.enum(['operator', 'toolsmith', 'research_feed']),
      sourceRef: OperationalIdSchema,
      evidenceDigest: BlueprintDigestSchema
    }),
    rollbackRevision: z.number().int().min(1).max(999_999).nullable()
  })
  .superRefine((config, context) => {
    if (config.revision === 1) {
      if (config.previousRevision !== null || config.rollbackRevision !== null) {
        context.addIssue({
          code: 'custom',
          path: ['previousRevision'],
          message: 'revision one cannot reference an earlier revision'
        });
      }
    } else {
      if (config.previousRevision !== config.revision - 1) {
        context.addIssue({
          code: 'custom',
          path: ['previousRevision'],
          message: 'a revision must immediately follow its previous revision'
        });
      }
      if (config.rollbackRevision === null || config.rollbackRevision >= config.revision) {
        context.addIssue({
          code: 'custom',
          path: ['rollbackRevision'],
          message: 'a later revision requires an earlier rollback revision'
        });
      }
    }

    const sleeves = config.sleeveGrants.map(({ sleeveId }) => sleeveId);
    if (new Set(sleeves).size !== sleeves.length) {
      context.addIssue({
        code: 'custom',
        path: ['sleeveGrants'],
        message: 'sleeve grants must be unique by sleeve id'
      });
    }
  });

export const CreateBlueprintProposalInputSchema = z.strictObject({
  config: BlueprintConfigSchema,
  proposer: BlueprintProposerSchema,
  proposedAt: z.iso.datetime()
});

export const AdvanceBlueprintInputSchema = z.strictObject({
  blueprintId: BlueprintIdSchema,
  revision: z.number().int().min(1).max(1_000_000),
  expectedVersion: z.number().int().min(1),
  targetState: z.enum([
    'sandboxed',
    'evaluated',
    'awaiting_approval',
    'shadow',
    'canary',
    'active'
  ]),
  actor: BlueprintActorSchema,
  evidenceDigest: BlueprintDigestSchema,
  observedAt: z.iso.datetime(),
  observation: BlueprintGateObservationSchema.optional()
});

const TerminalBlueprintInputBaseSchema = z.strictObject({
  blueprintId: BlueprintIdSchema,
  revision: z.number().int().min(1).max(1_000_000),
  expectedVersion: z.number().int().min(1),
  actor: BlueprintActorSchema,
  evidenceDigest: BlueprintDigestSchema,
  observedAt: z.iso.datetime()
});

export const BlueprintReasonCodeSchema = z.enum([
  'operator_rejected',
  'operator_rollback',
  'operator_retired',
  'automatic_gate_failure',
  'policy_violation',
  'scope_violation',
  'budget_breach',
  'quality_regression',
  'economics_regression'
]);

export const RejectBlueprintInputSchema = TerminalBlueprintInputBaseSchema.extend({
  reasonCode: z.literal('operator_rejected')
});
export const RollbackBlueprintInputSchema = TerminalBlueprintInputBaseSchema.extend({
  reasonCode: BlueprintReasonCodeSchema.exclude(['operator_rejected', 'operator_retired'])
});
export const RetireBlueprintInputSchema = TerminalBlueprintInputBaseSchema.extend({
  reasonCode: z.literal('operator_retired')
});

export type BlueprintActor = z.infer<typeof BlueprintActorSchema>;
export type BlueprintProposer = z.infer<typeof BlueprintProposerSchema>;
export type BlueprintState = z.infer<typeof BlueprintStateSchema>;
export type BlueprintReasonCode = z.infer<typeof BlueprintReasonCodeSchema>;
export type BlueprintConfig = z.infer<typeof BlueprintConfigSchema>;
export type BlueprintGatePolicy = z.infer<typeof BlueprintGatePolicySchema>;
export type BlueprintEconomicsPolicy = z.infer<typeof BlueprintEconomicsPolicySchema>;
export type BlueprintGateObservation = z.infer<typeof BlueprintGateObservationSchema>;
export type CreateBlueprintProposalInput = z.infer<typeof CreateBlueprintProposalInputSchema>;
export type AdvanceBlueprintInput = z.infer<typeof AdvanceBlueprintInputSchema>;
export type RejectBlueprintInput = z.infer<typeof RejectBlueprintInputSchema>;
export type RollbackBlueprintInput = z.infer<typeof RollbackBlueprintInputSchema>;
export type RetireBlueprintInput = z.infer<typeof RetireBlueprintInputSchema>;

export const BLUEPRINT_RUNTIME_CAPABILITIES = Object.freeze({
  lifecycleOnly: true as const,
  sandboxRunner: 'not_implemented' as const,
  modelExecution: 'not_implemented' as const
});

export interface BlueprintGateDecision {
  passed: boolean;
  reasons: string[];
}

export interface BlueprintRecord {
  blueprintId: string;
  revision: number;
  config: BlueprintConfig;
  configDigest: string;
  implementationId: string;
  state: BlueprintState;
  stateVersion: number;
  proposer: BlueprintProposer;
  createdAt: string;
  updatedAt: string;
  runtime: typeof BLUEPRINT_RUNTIME_CAPABILITIES;
}

export type BlueprintDecisionCode =
  | 'proposal_recorded'
  | 'stage_evidence_recorded'
  | 'gate_passed'
  | 'operator_approved'
  | 'operator_rejected'
  | 'operator_rollback'
  | 'operator_retired'
  | 'automatic_gate_rollback';

export interface BlueprintEvent {
  sequence: number;
  blueprintId: string;
  revision: number;
  fromState: BlueprintState | null;
  toState: BlueprintState;
  stateVersion: number;
  actor: BlueprintActor | BlueprintProposer;
  decisionCode: BlueprintDecisionCode;
  reasonCode: BlueprintReasonCode | null;
  evidenceDigest: string;
  gateDecision: BlueprintGateDecision | null;
  observation: BlueprintGateObservation | null;
  observedAt: string;
}
