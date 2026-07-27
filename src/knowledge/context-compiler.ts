import { createHash } from 'node:crypto';

import { z } from 'zod';

import { ControlScopeIdSchema, MemorySleeveIdSchema } from '../agents/access-control-contracts';
import { AppError } from '../utils/errors';
import {
  MemoryFragmentIdSchema,
  MemorySourceHashSchema,
  MemorySourceIdSchema
} from './retrieval-contracts';

const reservationSchema = z.strictObject({
  output: z.number().int().min(0).max(262_144),
  policy: z.number().int().min(0).max(262_144),
  toolSchema: z.number().int().min(0).max(262_144),
  workingState: z.number().int().min(0).max(262_144),
  safety: z.number().int().min(0).max(262_144)
});

const contextCandidateSchema = z.strictObject({
  id: MemoryFragmentIdSchema,
  ownerScopeId: ControlScopeIdSchema,
  sleeveId: MemorySleeveIdSchema,
  sourceId: MemorySourceIdSchema,
  sourceHash: MemorySourceHashSchema,
  content: z.string().min(1).max(65_536),
  required: z.boolean(),
  priority: z.number().int().min(0).max(100),
  relevancePermille: z.number().int().min(0).max(1_000),
  confidencePermille: z.number().int().min(0).max(1_000),
  recordedAt: z.iso.datetime(),
  coverageKeys: z.array(z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/)).max(20),
  retrievalEligible: z.boolean(),
  expiresAt: z.iso.datetime().nullable(),
  supersededByFragmentId: MemoryFragmentIdSchema.nullable()
});

export const ScopedContextCompilerInputSchema = z
  .strictObject({
    ownerScopeId: ControlScopeIdSchema,
    sleeveId: MemorySleeveIdSchema,
    totalCapacityTokens: z.number().int().min(1).max(262_144),
    reservations: reservationSchema,
    maxFragmentsPerSource: z.number().int().min(1).max(10),
    evaluatedAt: z.iso.datetime(),
    fragments: z.array(contextCandidateSchema).max(128)
  })
  .superRefine((input, context) => {
    const ids = new Set<string>();
    for (const fragment of input.fragments) {
      if (ids.has(fragment.id)) {
        context.addIssue({
          code: 'custom',
          path: ['fragments'],
          message: `Duplicate context fragment id: ${fragment.id}`
        });
      }
      ids.add(fragment.id);
      if (new Set(fragment.coverageKeys).size !== fragment.coverageKeys.length) {
        context.addIssue({
          code: 'custom',
          path: ['fragments'],
          message: `Duplicate coverage key on fragment: ${fragment.id}`
        });
      }
    }
  });

type ContextCandidate = z.infer<typeof contextCandidateSchema>;

type ContextOmissionReason =
  | 'duplicate_content'
  | 'expired'
  | 'superseded'
  | 'retrieval_disabled'
  | 'source_cap'
  | 'evidence_budget_exceeded'
  | 'required_budget_exceeded'
  | 'reservation_capacity_unavailable';

interface ConsolidatedCandidate extends ContextCandidate {
  fragmentIds: string[];
  sourceIds: string[];
  contentHash: string;
  estimatedTokens: number;
  inputOrder: number;
}

export interface CompiledContextFragment {
  id: string;
  fragmentIds: string[];
  sourceIds: string[];
  sourceHash: string;
  content: string;
  contentHash: string;
  estimatedTokens: number;
  required: boolean;
  selectionUtility: number;
  selectionReason: 'required' | 'utility_per_token';
}

export interface ContextManifestOmission {
  id: string;
  sourceId: string;
  sourceHash: string;
  contentHash: string;
  estimatedTokens: number;
  reason: ContextOmissionReason;
}

export interface ScopedContextCompilation {
  status: 'ready' | 'blocked';
  blockReason: 'reservations_exceed_capacity' | 'required_evidence_exceeds_capacity' | null;
  ownerScopeId: string;
  sleeveId: string;
  estimateBasis: 'capacity_estimate_utf8_bytes_divided_by_4';
  reservations: z.infer<typeof reservationSchema>;
  capacity: {
    total: number;
    reserved: number;
    availableEvidence: number;
    usedEvidence: number;
    remainingEvidence: number;
  };
  selected: CompiledContextFragment[];
  manifest: {
    selected: Array<{
      id: string;
      fragmentIds: string[];
      sourceIds: string[];
      contentHash: string;
      estimatedTokens: number;
      reason: 'required' | 'utility_per_token';
    }>;
    omitted: ContextManifestOmission[];
    fingerprint: string;
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function estimatedTokens(content: string): number {
  return Math.ceil(Buffer.byteLength(content, 'utf8') / 4);
}

function omission(
  fragment: ContextCandidate | ConsolidatedCandidate,
  reason: ContextOmissionReason
): ContextManifestOmission {
  return {
    id: fragment.id,
    sourceId: fragment.sourceId,
    sourceHash: fragment.sourceHash,
    contentHash: sha256(fragment.content),
    estimatedTokens: estimatedTokens(fragment.content),
    reason
  };
}

function selectedFragment(
  fragment: ConsolidatedCandidate,
  selectionUtility: number,
  reason: 'required' | 'utility_per_token'
): CompiledContextFragment {
  return {
    id: fragment.id,
    fragmentIds: [...fragment.fragmentIds],
    sourceIds: [...fragment.sourceIds],
    sourceHash: fragment.sourceHash,
    content: fragment.content,
    contentHash: fragment.contentHash,
    estimatedTokens: fragment.estimatedTokens,
    required: fragment.required,
    selectionUtility,
    selectionReason: reason
  };
}

function selectionUtility(
  fragment: ConsolidatedCandidate,
  coveredKeys: ReadonlySet<string>,
  evaluatedAt: string
): number {
  const ageDays = Math.max(
    0,
    Math.floor((Date.parse(evaluatedAt) - Date.parse(fragment.recordedAt)) / 86_400_000)
  );
  const freshness = Math.max(0, 1_000 - Math.min(ageDays, 1_000));
  const uncovered = fragment.coverageKeys.filter((key) => !coveredKeys.has(key)).length;
  const points =
    fragment.priority * 100 +
    fragment.relevancePermille * 10 +
    fragment.confidencePermille +
    freshness +
    uncovered * 500 +
    100;
  return Math.floor((points * 1_000) / fragment.estimatedTokens);
}

function resultWithManifest(
  base: Omit<ScopedContextCompilation, 'manifest'>,
  omitted: ContextManifestOmission[]
): ScopedContextCompilation {
  const manifestSelected = base.selected.map((fragment) => ({
    id: fragment.id,
    fragmentIds: [...fragment.fragmentIds],
    sourceIds: [...fragment.sourceIds],
    contentHash: fragment.contentHash,
    estimatedTokens: fragment.estimatedTokens,
    reason: fragment.selectionReason
  }));
  const unsignedManifest = { selected: manifestSelected, omitted };
  return {
    ...base,
    manifest: {
      ...unsignedManifest,
      fingerprint: sha256(JSON.stringify(unsignedManifest))
    }
  };
}

/**
 * Compiles deterministic whole-fragment evidence only after reserving every
 * protected context category. The estimate is capacity planning, never usage.
 */
export function compileScopedContext(rawInput: unknown): ScopedContextCompilation {
  const input = ScopedContextCompilerInputSchema.parse(rawInput);
  if (
    input.fragments.some(
      (fragment) =>
        fragment.ownerScopeId !== input.ownerScopeId || fragment.sleeveId !== input.sleeveId
    )
  ) {
    throw new AppError(
      403,
      'CONTEXT_SCOPE_FORBIDDEN',
      'Context compilation cannot cross an authorized memory sleeve'
    );
  }

  const reserved = Object.values(input.reservations).reduce((total, value) => total + value, 0);
  const availableEvidence = Math.max(0, input.totalCapacityTokens - reserved);
  const common = {
    ownerScopeId: input.ownerScopeId,
    sleeveId: input.sleeveId,
    estimateBasis: 'capacity_estimate_utf8_bytes_divided_by_4' as const,
    reservations: input.reservations
  };
  const omitted: ContextManifestOmission[] = [];
  const eligible: Array<ContextCandidate & { inputOrder: number }> = [];
  input.fragments.forEach((fragment, inputOrder) => {
    if (!fragment.retrievalEligible) {
      omitted.push(omission(fragment, 'retrieval_disabled'));
    } else if (fragment.supersededByFragmentId !== null) {
      omitted.push(omission(fragment, 'superseded'));
    } else if (fragment.expiresAt !== null && fragment.expiresAt <= input.evaluatedAt) {
      omitted.push(omission(fragment, 'expired'));
    } else {
      eligible.push({ ...fragment, inputOrder });
    }
  });

  const byHash = new Map<string, ConsolidatedCandidate>();
  const unique: ConsolidatedCandidate[] = [];
  for (const fragment of eligible) {
    const contentHash = sha256(fragment.content);
    const duplicate = byHash.get(contentHash);
    if (duplicate !== undefined) {
      duplicate.fragmentIds.push(fragment.id);
      if (!duplicate.sourceIds.includes(fragment.sourceId))
        duplicate.sourceIds.push(fragment.sourceId);
      duplicate.required ||= fragment.required;
      duplicate.priority = Math.max(duplicate.priority, fragment.priority);
      duplicate.relevancePermille = Math.max(
        duplicate.relevancePermille,
        fragment.relevancePermille
      );
      duplicate.confidencePermille = Math.max(
        duplicate.confidencePermille,
        fragment.confidencePermille
      );
      for (const key of fragment.coverageKeys) {
        if (!duplicate.coverageKeys.includes(key)) duplicate.coverageKeys.push(key);
      }
      omitted.push(omission(fragment, 'duplicate_content'));
      continue;
    }
    const consolidated: ConsolidatedCandidate = {
      ...fragment,
      fragmentIds: [fragment.id],
      sourceIds: [fragment.sourceId],
      contentHash,
      estimatedTokens: estimatedTokens(fragment.content)
    };
    byHash.set(contentHash, consolidated);
    unique.push(consolidated);
  }

  const baseCapacity = {
    total: input.totalCapacityTokens,
    reserved,
    availableEvidence,
    usedEvidence: 0,
    remainingEvidence: availableEvidence
  };
  if (reserved > input.totalCapacityTokens) {
    omitted.push(
      ...unique.map((fragment) => omission(fragment, 'reservation_capacity_unavailable'))
    );
    return resultWithManifest(
      {
        ...common,
        status: 'blocked',
        blockReason: 'reservations_exceed_capacity',
        capacity: baseCapacity,
        selected: []
      },
      omitted
    );
  }

  const required = unique
    .filter((fragment) => fragment.required)
    .sort((left, right) => left.inputOrder - right.inputOrder);
  const requiredTokens = required.reduce((total, fragment) => total + fragment.estimatedTokens, 0);
  if (requiredTokens > availableEvidence) {
    omitted.push(
      ...unique.map((fragment) =>
        omission(
          fragment,
          fragment.required ? 'required_budget_exceeded' : 'evidence_budget_exceeded'
        )
      )
    );
    return resultWithManifest(
      {
        ...common,
        status: 'blocked',
        blockReason: 'required_evidence_exceeds_capacity',
        capacity: baseCapacity,
        selected: []
      },
      omitted
    );
  }

  const selected = required.map((fragment) => selectedFragment(fragment, 0, 'required'));
  let usedEvidence = requiredTokens;
  const coveredKeys = new Set(required.flatMap((fragment) => fragment.coverageKeys));
  const sourceCounts = new Map<string, number>();
  for (const fragment of required) {
    sourceCounts.set(fragment.sourceId, (sourceCounts.get(fragment.sourceId) ?? 0) + 1);
  }
  const remaining = unique.filter((fragment) => !fragment.required);
  while (remaining.length > 0) {
    const ranked = remaining
      .map((fragment) => ({
        fragment,
        utility: selectionUtility(fragment, coveredKeys, input.evaluatedAt)
      }))
      .sort(
        (left, right) =>
          right.utility - left.utility ||
          left.fragment.inputOrder - right.fragment.inputOrder ||
          left.fragment.id.localeCompare(right.fragment.id)
      );
    const next = ranked[0];
    if (next === undefined) break;
    const index = remaining.indexOf(next.fragment);
    remaining.splice(index, 1);

    if ((sourceCounts.get(next.fragment.sourceId) ?? 0) >= input.maxFragmentsPerSource) {
      omitted.push(omission(next.fragment, 'source_cap'));
      continue;
    }
    if (usedEvidence + next.fragment.estimatedTokens > availableEvidence) {
      omitted.push(omission(next.fragment, 'evidence_budget_exceeded'));
      continue;
    }
    selected.push(selectedFragment(next.fragment, next.utility, 'utility_per_token'));
    usedEvidence += next.fragment.estimatedTokens;
    sourceCounts.set(next.fragment.sourceId, (sourceCounts.get(next.fragment.sourceId) ?? 0) + 1);
    next.fragment.coverageKeys.forEach((key) => coveredKeys.add(key));
  }

  return resultWithManifest(
    {
      ...common,
      status: 'ready',
      blockReason: null,
      capacity: {
        ...baseCapacity,
        usedEvidence,
        remainingEvidence: availableEvidence - usedEvidence
      },
      selected
    },
    omitted
  );
}
