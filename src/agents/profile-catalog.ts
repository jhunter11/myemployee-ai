import { z } from 'zod';

import { KnowledgeGraphPartitionSchema, KnowledgeScopeIdSchema } from '../knowledge/contracts';
import { AppError } from '../utils/errors';
import { archetypeFor, assertArchetypeConformance, BUDGETS, type BudgetKind } from './archetypes';
import { POD_RECIPES, type PodMember, type PodRecipe, type ToolSeed } from './pod-recipes';

const AgentIdSchema = z.string().regex(/^[a-z][a-z0-9-]{2,63}$/u);
const ManifestIdSchema = z.string().regex(/^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/u);
const TextSchema = z.string().trim().min(1).max(1_000);
const ShortTextSchema = z.string().trim().min(1).max(160);
export const AgentSleeveIdSchema = z.union([
  z
    .string()
    .regex(/^(?:personal|agency|task_market|shared|company|project):[a-z][a-z0-9_-]{1,127}$/u),
  z.string().regex(/^client:[a-z][a-z0-9_]{2,62}$/u),
  z.string().regex(/^agent:[a-z][a-z0-9-]{2,63}:scratch$/u)
]);

export const AgentTrustDomainSchema = z.enum(['personal', 'agency', 'task_market']);
export const AgentRuntimeModeSchema = z.enum(['deterministic', 'profile_only', 'disabled']);
export const AgentLifecycleSchema = z.enum(['durable', 'template']);
export const AgentRelationSchema = z.enum([
  'root',
  'coordinator',
  'specialist',
  'advisor',
  'builder',
  'reviewer',
  'verifier',
  'operator',
  'auditor'
]);

export const AgentToolGrantSchema = z.strictObject({
  id: ManifestIdSchema,
  access: z.enum(['read', 'propose', 'execute']),
  purpose: ShortTextSchema
});

const AgentMemoryDescriptorSchema = z.strictObject({
  scratchSleeveId: AgentSleeveIdSchema,
  readableSleeveIds: z.array(AgentSleeveIdSchema).min(1).max(16),
  proposeWritableSleeveIds: z.array(AgentSleeveIdSchema).max(16),
  retention: z.literal('run_bounded'),
  transcriptPromotion: z.literal('forbidden')
});

const AgentKnowledgeDescriptorSchema = z.strictObject({
  scopeId: KnowledgeScopeIdSchema,
  partitionId: KnowledgeGraphPartitionSchema,
  projection: z.enum(['metadata', 'content']),
  maxResults: z.number().int().min(1).max(25),
  filesystemPathExposed: z.literal(false)
});

const CheckpointFieldSchema = z.enum([
  'profile_revision',
  'scope_id',
  'stage',
  'next_safe_action',
  'input_artifact_digests',
  'output_artifact_digests',
  'evidence_refs',
  'grant_versions',
  'queue_run_ids',
  'remaining_budgets',
  'expiry',
  'last_confirmed_side_effect'
]);

const ExcludedCheckpointFieldSchema = z.enum([
  'whole_transcripts',
  'external_raw_text',
  'secrets',
  'hidden_reasoning'
]);

const ContinuationStageSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9_]{1,47}$/u),
  label: ShortTextSchema,
  completionEvidence: TextSchema
});

const AgentContinuationSchema = z.strictObject({
  stages: z
    .array(ContinuationStageSchema)
    .min(2)
    .max(16)
    .refine(
      (stages) => new Set(stages.map(({ id }) => id)).size === stages.length,
      'continuation stage IDs must be unique'
    ),
  checkpoint: z.strictObject({
    trigger: z.literal('after_each_stage'),
    requiredFields: z
      .array(CheckpointFieldSchema)
      .length(CheckpointFieldSchema.options.length)
      .refine(
        (fields) =>
          new Set(fields).size === CheckpointFieldSchema.options.length &&
          CheckpointFieldSchema.options.every((field) => fields.includes(field)),
        'checkpoint required fields must contain the exact safety set'
      ),
    excludedFields: z
      .array(ExcludedCheckpointFieldSchema)
      .length(ExcludedCheckpointFieldSchema.options.length)
      .refine(
        (fields) =>
          new Set(fields).size === ExcludedCheckpointFieldSchema.options.length &&
          ExcludedCheckpointFieldSchema.options.every((field) => fields.includes(field)),
        'checkpoint excluded fields must contain the exact safety set'
      )
  }),
  resume: z.strictObject({
    requirements: z.array(TextSchema).min(4).max(12),
    onUncertainty: z.literal('stop_and_escalate')
  }),
  output: z.strictObject({
    artifactType: ManifestIdSchema,
    requiredFields: z.array(ManifestIdSchema).min(1).max(24),
    evidenceRequired: z.boolean()
  }),
  completionCriteria: z.array(TextSchema).min(1).max(12),
  escalation: z.strictObject({
    target: z.union([z.literal('operator'), AgentIdSchema]),
    conditions: z.array(TextSchema).min(1).max(12)
  }),
  budgets: z.strictObject({
    maxTurns: z.number().int().min(1).max(64),
    maxToolCalls: z.number().int().min(0).max(256),
    maxDurationSeconds: z.number().int().min(1).max(86_400),
    maxEstimatedTokens: z.number().int().min(0).max(1_000_000),
    maxChildRuns: z.number().int().min(0).max(32)
  })
});

const AgentAvailabilitySchema = z.strictObject({
  state: z.enum(['available', 'not_configured', 'disabled']),
  evidenceRefs: z.array(z.string().trim().min(1).max(240)).min(1).max(8)
});

export const AgentProfileSchema = z.strictObject({
  id: AgentIdSchema,
  revision: z.number().int().min(1).max(1_000_000),
  displayName: ShortTextSchema,
  role: ShortTextSchema,
  purpose: TextSchema,
  parentId: AgentIdSchema.nullable(),
  relation: AgentRelationSchema,
  trustDomain: AgentTrustDomainSchema,
  lifecycle: AgentLifecycleSchema,
  runtimeMode: AgentRuntimeModeSchema,
  availability: AgentAvailabilitySchema,
  toolGrants: z
    .array(AgentToolGrantSchema)
    .min(1)
    .max(32)
    .refine(
      (grants) => new Set(grants.map(({ id }) => id)).size === grants.length,
      'tool grant IDs must be unique per profile'
    ),
  memory: AgentMemoryDescriptorSchema,
  knowledge: AgentKnowledgeDescriptorSchema,
  continuation: AgentContinuationSchema
});

export type AgentTrustDomain = z.infer<typeof AgentTrustDomainSchema>;
export type AgentRuntimeMode = z.infer<typeof AgentRuntimeModeSchema>;
export type AgentLifecycle = z.infer<typeof AgentLifecycleSchema>;
export type AgentToolGrant = z.infer<typeof AgentToolGrantSchema>;
export type AgentSleeveId = z.infer<typeof AgentSleeveIdSchema>;
export type AgentProfile = z.infer<typeof AgentProfileSchema>;

const forbiddenTaskMarketGrant =
  /(?:^|[.:-])(?:wallet|sign|signing|withdraw|private[_-]?key|seed|mainnet|payment[_-]?policy)(?:[._:-]|$)/iu;
const TOOL_NAMESPACES: Record<AgentTrustDomain, ReadonlySet<string>> = {
  personal: new Set(['profile', 'personal', 'shared']),
  agency: new Set([
    'agency',
    'queue',
    'run',
    'repo',
    'knowledge',
    'test',
    'audit',
    'public_research',
    'revenue',
    'client',
    'worker',
    'memory',
    'blueprint',
    'eval',
    'frequency'
  ]),
  task_market: new Set([
    'task_market',
    'mcp',
    'seller',
    'deployment',
    'security',
    'scout',
    'settlement',
    'chain'
  ])
};

function sleeveMatchesDomain(profile: AgentProfile, sleeveId: string): boolean {
  if (sleeveId === `agent:${profile.id}:scratch`) return true;
  if (profile.id === 'jarvis' && sleeveId === 'shared:jarvis_handoffs') return true;
  return sleeveId.startsWith(`${profile.trustDomain}:`);
}

function expectedKnowledgePrefix(trustDomain: AgentTrustDomain): string {
  if (trustDomain === 'personal') return 'harness:';
  return trustDomain === 'agency' ? 'project:agency_' : 'project:task_market_';
}

function expectedGraphPartition(scopeId: string): string {
  return scopeId.replace(/^(harness|project|client):/u, 'graphify/$1/');
}

function addCatalogIssue(
  context: z.RefinementCtx,
  index: number,
  path: Array<string | number>,
  message: string
): void {
  context.addIssue({ code: 'custom', path: [index, ...path], message });
}

export const AgentProfileCatalogSchema = z
  .array(AgentProfileSchema)
  .min(1)
  .max(100)
  .superRefine((profiles, context) => {
    const byId = new Map<string, { profile: AgentProfile; index: number }>();
    profiles.forEach((profile, index) => {
      if (byId.has(profile.id)) {
        addCatalogIssue(context, index, ['id'], `duplicate agent profile ID ${profile.id}`);
      } else {
        byId.set(profile.id, { profile, index });
      }

      if (profile.memory.scratchSleeveId !== `agent:${profile.id}:scratch`) {
        addCatalogIssue(
          context,
          index,
          ['memory', 'scratchSleeveId'],
          'scratch sleeve must belong to the exact agent profile'
        );
      }
      for (const [field, sleeves] of [
        ['readableSleeveIds', profile.memory.readableSleeveIds],
        ['proposeWritableSleeveIds', profile.memory.proposeWritableSleeveIds]
      ] as const) {
        for (const [sleeveIndex, sleeve] of sleeves.entries()) {
          if (sleeve.startsWith('client:')) {
            addCatalogIssue(
              context,
              index,
              ['memory', field, sleeveIndex],
              `client sleeve ${sleeve} requires a separately authorized temporary grant`
            );
            continue;
          }
          if (!sleeveMatchesDomain(profile, sleeve)) {
            addCatalogIssue(
              context,
              index,
              ['memory', field, sleeveIndex],
              `sleeve ${sleeve} does not match trust domain ${profile.trustDomain}`
            );
          }
        }
      }
      if (!profile.knowledge.scopeId.startsWith(expectedKnowledgePrefix(profile.trustDomain))) {
        addCatalogIssue(
          context,
          index,
          ['knowledge', 'scopeId'],
          'knowledge scope does not match the profile trust domain'
        );
      }
      if (profile.id === 'jarvis' && profile.knowledge.scopeId !== 'harness:jarvis') {
        addCatalogIssue(
          context,
          index,
          ['knowledge', 'scopeId'],
          'Jarvis knowledge must remain bound to the private harness scope'
        );
      }
      if (profile.knowledge.partitionId !== expectedGraphPartition(profile.knowledge.scopeId)) {
        addCatalogIssue(
          context,
          index,
          ['knowledge', 'partitionId'],
          'knowledge partition does not match the registered scope binding'
        );
      }
      for (const [grantIndex, grant] of profile.toolGrants.entries()) {
        const namespace = grant.id.split('.')[0] ?? '';
        if (!TOOL_NAMESPACES[profile.trustDomain].has(namespace)) {
          addCatalogIssue(
            context,
            index,
            ['toolGrants', grantIndex, 'id'],
            `tool namespace ${namespace} does not match trust domain ${profile.trustDomain}`
          );
        }
        if (profile.trustDomain === 'task_market') {
          if (forbiddenTaskMarketGrant.test(grant.id)) {
            addCatalogIssue(
              context,
              index,
              ['toolGrants', grantIndex, 'id'],
              'MCP/x402 profiles cannot receive wallet or signing authority'
            );
          }
          if (grant.access === 'execute') {
            addCatalogIssue(
              context,
              index,
              ['toolGrants', grantIndex, 'access'],
              'MCP/x402 profiles are simulation-only and cannot receive execute authority'
            );
          }
        }
      }

      const expectedAvailability =
        profile.runtimeMode === 'deterministic'
          ? 'available'
          : profile.runtimeMode === 'profile_only'
            ? 'not_configured'
            : 'disabled';
      if (profile.availability.state !== expectedAvailability) {
        addCatalogIssue(
          context,
          index,
          ['availability', 'state'],
          `availability must be ${expectedAvailability} for ${profile.runtimeMode}`
        );
      }
    });

    const roots = profiles.filter(({ parentId }) => parentId === null);
    if (roots.length !== 1 || roots[0]?.id !== 'jarvis') {
      context.addIssue({
        code: 'custom',
        message: 'catalog requires Jarvis as its only root profile'
      });
    }

    profiles.forEach((profile, index) => {
      if ((profile.parentId === null) !== (profile.relation === 'root')) {
        addCatalogIssue(
          context,
          index,
          ['relation'],
          'only the root profile may use the root relation'
        );
      }
      if (profile.parentId !== null) {
        const parent = byId.get(profile.parentId)?.profile;
        if (parent === undefined) {
          addCatalogIssue(context, index, ['parentId'], `parent ${profile.parentId} was not found`);
        } else if (parent.trustDomain !== profile.trustDomain) {
          const approvedRootBoundary =
            parent.id === 'jarvis' && ['agency', 'mcp-x402'].includes(profile.id);
          if (!approvedRootBoundary) {
            addCatalogIssue(
              context,
              index,
              ['parentId'],
              'parent edge crosses a trust domain without an approved Jarvis boundary'
            );
          }
        }
      }
      const target = profile.continuation.escalation.target;
      if (target !== 'operator' && !byId.has(target)) {
        addCatalogIssue(
          context,
          index,
          ['continuation', 'escalation', 'target'],
          `escalation target ${target} was not found`
        );
      } else if (target !== 'operator') {
        const targetProfile = byId.get(target)?.profile;
        const approvedReviewedHandoff =
          target === 'jarvis' && (profile.id === 'agency' || profile.id === 'mcp-x402');
        if (
          targetProfile !== undefined &&
          targetProfile.trustDomain !== profile.trustDomain &&
          !approvedReviewedHandoff
        ) {
          addCatalogIssue(
            context,
            index,
            ['continuation', 'escalation', 'target'],
            'cross-domain escalation requires an approved reviewed-handoff edge'
          );
        }
      }
    });

    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (id: string): void => {
      if (visited.has(id)) return;
      if (visiting.has(id)) {
        const index = byId.get(id)?.index ?? 0;
        addCatalogIssue(context, index, ['parentId'], `agent hierarchy contains a cycle at ${id}`);
        return;
      }
      visiting.add(id);
      const parentId = byId.get(id)?.profile.parentId;
      if (parentId !== null && parentId !== undefined && byId.has(parentId)) visit(parentId);
      visiting.delete(id);
      visited.add(id);
    };
    for (const id of byId.keys()) visit(id);
  });

const REQUIRED_CHECKPOINT_FIELDS = CheckpointFieldSchema.options;
const EXCLUDED_CHECKPOINT_FIELDS = ExcludedCheckpointFieldSchema.options;
const RESUME_REQUIREMENTS = [
  'Reload the pinned server-owned profile revision.',
  'Reauthorize every tool and sleeve grant before retrieval or execution.',
  'Verify all immutable input and output artifact digests.',
  'Reconcile queue, lease, run, and last-confirmed side-effect state before continuing.',
  'Stop instead of replaying work when durable state is uncertain.'
] as const;

interface ProfileSeed {
  id: string;
  displayName: string;
  role: string;
  purpose: string;
  parentId: string | null;
  relation: AgentProfile['relation'];
  trustDomain: AgentTrustDomain;
  lifecycle: AgentLifecycle;
  runtimeMode: AgentRuntimeMode;
  evidenceRefs: string[];
  tools: ToolSeed[];
  sleeve: string;
  scope: string;
  stages: string[];
  artifactType: string;
  outputFields: string[];
  completionCriteria: string[];
  escalationTarget: string;
  escalationConditions: string[];
  budget: BudgetKind;
}

function stage(id: string): z.infer<typeof ContinuationStageSchema> {
  const label = id.replaceAll('_', ' ');
  return {
    id,
    label: `${label[0]?.toUpperCase() ?? ''}${label.slice(1)}`,
    completionEvidence: `Record immutable evidence that the ${label} stage completed before advancing.`
  };
}

function makeProfile(seed: ProfileSeed): AgentProfile {
  const state =
    seed.runtimeMode === 'deterministic'
      ? 'available'
      : seed.runtimeMode === 'profile_only'
        ? 'not_configured'
        : 'disabled';
  const knowledgeKind = seed.trustDomain === 'personal' ? 'harness' : 'project';
  const knowledgeSubject =
    seed.trustDomain === 'personal' ? seed.scope : `${seed.trustDomain}_${seed.scope}`;
  const scopeId = `${knowledgeKind}:${knowledgeSubject}`;
  const defaultReadableSleeves = [`${seed.trustDomain}:core`, `${seed.trustDomain}:${seed.sleeve}`];
  const readableSleeveIds =
    seed.id === 'jarvis' ? ['personal:jarvis', 'shared:jarvis_handoffs'] : defaultReadableSleeves;
  return {
    id: seed.id,
    revision: 1,
    displayName: seed.displayName,
    role: seed.role,
    purpose: seed.purpose,
    parentId: seed.parentId,
    relation: seed.relation,
    trustDomain: seed.trustDomain,
    lifecycle: seed.lifecycle,
    runtimeMode: seed.runtimeMode,
    availability: { state, evidenceRefs: seed.evidenceRefs },
    toolGrants: seed.tools.map(([id, access, purpose]) => ({ id, access, purpose })),
    memory: {
      scratchSleeveId: `agent:${seed.id}:scratch`,
      readableSleeveIds,
      proposeWritableSleeveIds: [`${seed.trustDomain}:${seed.sleeve}`],
      retention: 'run_bounded',
      transcriptPromotion: 'forbidden'
    },
    knowledge: {
      scopeId,
      partitionId: expectedGraphPartition(scopeId),
      projection: 'content',
      maxResults: 12,
      filesystemPathExposed: false
    },
    continuation: {
      stages: seed.stages.map(stage),
      checkpoint: {
        trigger: 'after_each_stage',
        requiredFields: [...REQUIRED_CHECKPOINT_FIELDS],
        excludedFields: [...EXCLUDED_CHECKPOINT_FIELDS]
      },
      resume: {
        requirements: [...RESUME_REQUIREMENTS],
        onUncertainty: 'stop_and_escalate'
      },
      output: {
        artifactType: seed.artifactType,
        requiredFields: seed.outputFields,
        evidenceRequired: true
      },
      completionCriteria: seed.completionCriteria,
      escalation: {
        target: seed.escalationTarget,
        conditions: seed.escalationConditions
      },
      budgets: { ...BUDGETS[seed.budget] }
    }
  };
}

function memberSleeve(member: PodMember, recipe: PodRecipe): string {
  const archetype = archetypeFor(member.relation);
  if (archetype.sleeveRule === 'explicit') {
    if (member.sleeve === undefined) {
      throw new AppError(
        500,
        'POD_RECIPE_SLEEVE_REQUIRED',
        `Member ${member.id} uses the explicit sleeve rule and must name its sleeve`
      );
    }
    return member.sleeve;
  }
  if (member.sleeve !== undefined) return member.sleeve;
  return archetype.sleeveRule === 'pod_reviews' ? `${recipe.sleeve}_reviews` : recipe.sleeve;
}

function memberBudget(member: PodMember): BudgetKind {
  const archetype = archetypeFor(member.relation);
  const budget = member.budget ?? archetype.defaultBudget;
  if (!archetype.budgetKinds.includes(budget)) {
    throw new AppError(
      500,
      'POD_RECIPE_BUDGET_FORBIDDEN',
      `Member ${member.id} requests budget ${budget}, outside the ${member.relation} allowlist`
    );
  }
  return budget;
}

/**
 * Derives a full profile seed from a pod member. Parent wiring, escalation
 * target, sleeve, and budget come from the archetype; everything else is the
 * member's own domain content.
 */
function toSeed(member: PodMember, parentId: string | null, recipe: PodRecipe): ProfileSeed {
  const archetype = archetypeFor(member.relation);
  return {
    id: member.id,
    displayName: member.displayName,
    role: member.role,
    purpose: member.purpose,
    parentId,
    relation: member.relation,
    trustDomain: recipe.trustDomain,
    lifecycle: member.lifecycle,
    runtimeMode: member.runtimeMode,
    evidenceRefs: [...member.evidenceRefs],
    tools: [...member.tools],
    sleeve: memberSleeve(member, recipe),
    scope: recipe.scope,
    stages: [...member.stages],
    artifactType: member.artifactType,
    outputFields: [...member.outputFields],
    completionCriteria: [...member.completionCriteria],
    escalationTarget: archetype.escalatesTo === 'operator' ? 'operator' : (parentId ?? 'operator'),
    escalationConditions: [...member.escalationConditions],
    budget: memberBudget(member)
  };
}

export function expandRecipe(recipe: PodRecipe): ProfileSeed[] {
  return [
    toSeed(recipe.lead, recipe.parentId, recipe),
    ...recipe.members.map((member) => toSeed(member, recipe.lead.id, recipe))
  ];
}

const PROFILE_SEEDS: ProfileSeed[] = POD_RECIPES.flatMap(expandRecipe);

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

export function validateAgentProfiles(input: unknown): readonly AgentProfile[] {
  const profiles = AgentProfileCatalogSchema.parse(input);
  // Runs after the schema so structural catalog errors keep reporting first.
  for (const profile of profiles) assertArchetypeConformance(profile);
  return deepFreeze(profiles);
}

const catalog = validateAgentProfiles(PROFILE_SEEDS.map(makeProfile));
const catalogById = new Map(catalog.map((profile) => [profile.id, profile]));

export function listAgentProfiles(): readonly AgentProfile[] {
  return catalog;
}

export function findAgentProfile(id: string): AgentProfile | undefined {
  return catalogById.get(id);
}

export interface AgentHierarchyNode {
  id: string;
  displayName: string;
  role: string;
  parentId: string | null;
  relation: AgentProfile['relation'];
  trustDomain: AgentTrustDomain;
  lifecycle: AgentLifecycle;
  runtimeMode: AgentRuntimeMode;
  availability: AgentProfile['availability']['state'];
  depth: number;
  children: AgentHierarchyNode[];
}

export interface AgentHierarchyProjection {
  returnedCount: number;
  totalCount: number;
  truncated: boolean;
  roots: AgentHierarchyNode[];
}

const HierarchyOptionsSchema = z.strictObject({
  rootId: AgentIdSchema.optional(),
  maxDepth: z.number().int().min(0).max(8).default(8),
  maxNodes: z.number().int().min(1).max(100).default(100)
});

export function projectAgentHierarchy(
  rawOptions: { rootId?: string; maxDepth?: number; maxNodes?: number } = {}
): AgentHierarchyProjection {
  const options = HierarchyOptionsSchema.parse(rawOptions);
  const rootProfiles =
    options.rootId === undefined
      ? catalog.filter(({ parentId }) => parentId === null)
      : [catalogById.get(options.rootId)].filter(
          (profile): profile is AgentProfile => profile !== undefined
        );
  if (rootProfiles.length === 0) throw new Error('Hierarchy root profile was not found');

  const childrenByParent = new Map<string, AgentProfile[]>();
  for (const profile of catalog) {
    if (profile.parentId === null) continue;
    const children = childrenByParent.get(profile.parentId) ?? [];
    children.push(profile);
    childrenByParent.set(profile.parentId, children);
  }

  const descendants = new Set<string>();
  const countDescendants = (profile: AgentProfile): void => {
    if (descendants.has(profile.id)) return;
    descendants.add(profile.id);
    for (const child of childrenByParent.get(profile.id) ?? []) countDescendants(child);
  };
  rootProfiles.forEach(countDescendants);

  let remaining = options.maxNodes;
  let omittedForDepth = false;
  const build = (profile: AgentProfile, depth: number): AgentHierarchyNode | undefined => {
    if (remaining === 0) return undefined;
    remaining -= 1;
    const availableChildren = childrenByParent.get(profile.id) ?? [];
    if (depth >= options.maxDepth && availableChildren.length > 0) omittedForDepth = true;
    const children =
      depth >= options.maxDepth
        ? []
        : availableChildren.flatMap((child) => {
            const node = build(child, depth + 1);
            return node === undefined ? [] : [node];
          });
    return {
      id: profile.id,
      displayName: profile.displayName,
      role: profile.role,
      parentId: profile.parentId,
      relation: profile.relation,
      trustDomain: profile.trustDomain,
      lifecycle: profile.lifecycle,
      runtimeMode: profile.runtimeMode,
      availability: profile.availability.state,
      depth,
      children
    };
  };
  const roots = rootProfiles.flatMap((root) => {
    const node = build(root, 0);
    return node === undefined ? [] : [node];
  });
  const returnedCount = options.maxNodes - remaining;
  return deepFreeze({
    returnedCount,
    totalCount: descendants.size,
    truncated: returnedCount < descendants.size || omittedForDepth,
    roots
  });
}
