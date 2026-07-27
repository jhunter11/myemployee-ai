import { createHash } from 'node:crypto';

import {
  ContextBudgetInputSchema,
  type ContextBudgetInput,
  type ContextProvenance
} from './contracts';

type OmissionReason = 'budget_exceeded' | 'required_budget_exceeded';

interface ContextMetadata {
  id: string;
  contentHash: string;
  utf8Bytes: number;
  estimatedTokens: number;
  provenance: ContextProvenance[];
}

export interface SelectedContextFragment extends ContextMetadata {
  sourceIds: string[];
  priority: number;
  required: boolean;
  content: string;
}

export interface OmittedContextFragment extends ContextMetadata {
  reason: OmissionReason;
}

export interface DeduplicatedContextFragment {
  id: string;
  canonicalId: string;
  contentHash: string;
  utf8Bytes: number;
  estimatedTokens: number;
  provenance: ContextProvenance;
  reason: 'duplicate_content';
}

export interface ContextBudgetResult {
  status: 'ready' | 'blocked';
  blockReason: 'required_context_exceeds_budget' | null;
  estimateBasis: 'capacity_estimate_utf8_bytes_divided_by_4';
  limits: { maxUtf8Bytes: number; maxEstimatedTokens: number };
  totals: {
    inputFragments: number;
    uniqueFragments: number;
    selectedFragments: number;
    selectedUtf8Bytes: number;
    selectedEstimatedTokens: number;
    requiredUtf8Bytes: number;
    requiredEstimatedTokens: number;
  };
  selected: SelectedContextFragment[];
  omitted: OmittedContextFragment[];
  deduplicated: DeduplicatedContextFragment[];
}

interface ConsolidatedFragment extends SelectedContextFragment {
  inputOrder: number;
}

function contentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function estimatedTokens(utf8Bytes: number): number {
  return Math.ceil(utf8Bytes / 4);
}

function metadata(fragment: ConsolidatedFragment, reason: OmissionReason): OmittedContextFragment {
  return {
    id: fragment.id,
    contentHash: fragment.contentHash,
    utf8Bytes: fragment.utf8Bytes,
    estimatedTokens: fragment.estimatedTokens,
    provenance: [...fragment.provenance],
    reason
  };
}

function stablePriority(left: ConsolidatedFragment, right: ConsolidatedFragment): number {
  return right.priority - left.priority || left.inputOrder - right.inputOrder;
}

/**
 * Builds a deterministic whole-fragment context manifest. Estimated tokens
 * are a labeled capacity heuristic; provider-observed usage belongs only in
 * the model usage ledger.
 */
export function budgetContext(rawInput: unknown): ContextBudgetResult {
  const input: ContextBudgetInput = ContextBudgetInputSchema.parse(rawInput);
  const byHash = new Map<string, ConsolidatedFragment>();
  const unique: ConsolidatedFragment[] = [];
  const deduplicated: DeduplicatedContextFragment[] = [];

  input.fragments.forEach((fragment, inputOrder) => {
    const hash = contentHash(fragment.content);
    const utf8Bytes = Buffer.byteLength(fragment.content, 'utf8');
    const tokenEstimate = estimatedTokens(utf8Bytes);
    const canonical = byHash.get(hash);
    if (canonical !== undefined) {
      canonical.sourceIds.push(fragment.id);
      canonical.priority = Math.max(canonical.priority, fragment.priority);
      canonical.required ||= fragment.required;
      canonical.provenance.push(fragment.provenance);
      deduplicated.push({
        id: fragment.id,
        canonicalId: canonical.id,
        contentHash: hash,
        utf8Bytes,
        estimatedTokens: tokenEstimate,
        provenance: fragment.provenance,
        reason: 'duplicate_content'
      });
      return;
    }
    const consolidated: ConsolidatedFragment = {
      id: fragment.id,
      sourceIds: [fragment.id],
      priority: fragment.priority,
      required: fragment.required,
      provenance: [fragment.provenance],
      content: fragment.content,
      contentHash: hash,
      utf8Bytes,
      estimatedTokens: tokenEstimate,
      inputOrder
    };
    byHash.set(hash, consolidated);
    unique.push(consolidated);
  });

  const required = unique.filter((fragment) => fragment.required);
  const requiredUtf8Bytes = required.reduce((total, fragment) => total + fragment.utf8Bytes, 0);
  const requiredEstimatedTokens = required.reduce(
    (total, fragment) => total + fragment.estimatedTokens,
    0
  );
  const baseTotals = {
    inputFragments: input.fragments.length,
    uniqueFragments: unique.length,
    requiredUtf8Bytes,
    requiredEstimatedTokens
  };
  const common = {
    estimateBasis: 'capacity_estimate_utf8_bytes_divided_by_4' as const,
    limits: {
      maxUtf8Bytes: input.maxUtf8Bytes,
      maxEstimatedTokens: input.maxEstimatedTokens
    },
    deduplicated
  };

  if (
    requiredUtf8Bytes > input.maxUtf8Bytes ||
    requiredEstimatedTokens > input.maxEstimatedTokens
  ) {
    return {
      status: 'blocked',
      blockReason: 'required_context_exceeds_budget',
      ...common,
      totals: {
        ...baseTotals,
        selectedFragments: 0,
        selectedUtf8Bytes: 0,
        selectedEstimatedTokens: 0
      },
      selected: [],
      omitted: unique.map((fragment) =>
        metadata(fragment, fragment.required ? 'required_budget_exceeded' : 'budget_exceeded')
      )
    };
  }

  const selectedSet = new Set(required);
  let selectedUtf8Bytes = requiredUtf8Bytes;
  let selectedEstimatedTokens = requiredEstimatedTokens;
  for (const fragment of unique.filter((candidate) => !candidate.required).sort(stablePriority)) {
    if (
      selectedUtf8Bytes + fragment.utf8Bytes <= input.maxUtf8Bytes &&
      selectedEstimatedTokens + fragment.estimatedTokens <= input.maxEstimatedTokens
    ) {
      selectedSet.add(fragment);
      selectedUtf8Bytes += fragment.utf8Bytes;
      selectedEstimatedTokens += fragment.estimatedTokens;
    }
  }
  const selected = unique
    .filter((fragment) => selectedSet.has(fragment))
    .sort(stablePriority)
    .map((fragment) => ({
      id: fragment.id,
      sourceIds: [...fragment.sourceIds],
      priority: fragment.priority,
      required: fragment.required,
      provenance: [...fragment.provenance],
      content: fragment.content,
      contentHash: fragment.contentHash,
      utf8Bytes: fragment.utf8Bytes,
      estimatedTokens: fragment.estimatedTokens
    }));
  const omitted = unique
    .filter((fragment) => !selectedSet.has(fragment))
    .sort(stablePriority)
    .map((fragment) => metadata(fragment, 'budget_exceeded'));

  return {
    status: 'ready',
    blockReason: null,
    ...common,
    totals: {
      ...baseTotals,
      selectedFragments: selected.length,
      selectedUtf8Bytes,
      selectedEstimatedTokens
    },
    selected,
    omitted
  };
}
