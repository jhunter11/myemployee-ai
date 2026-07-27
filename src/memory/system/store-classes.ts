import type { z } from 'zod';

import type { MemoryKindSchema } from '../../knowledge/retrieval-contracts';

/**
 * CoALA store classes. The flat memory substrate stores every kind in one table
 * behind one retrieval path; the typed-hybrid backend activates these classes so
 * each has its own write rule, retention, and retrieval policy.
 *
 * `working` state is NOT derived from a fragment kind — it lives only in the
 * run-local `working_memory` store and never becomes a durable fragment.
 */
export type MemoryStoreClass = 'working' | 'episodic' | 'semantic' | 'procedural';

export type MemoryKind = z.infer<typeof MemoryKindSchema>;

/**
 * Kind -> durable store class. The mapping follows the research report's routing:
 *   episodic  <- the concrete record of what happened (events, artifacts, decisions)
 *   semantic  <- decontextualized knowledge that outlives one episode
 *   procedural<- reusable workflows and approved blueprints
 */
const KIND_TO_STORE_CLASS: Readonly<Record<MemoryKind, Exclude<MemoryStoreClass, 'working'>>> = {
  episode: 'episodic',
  artifact: 'episodic',
  decision: 'episodic',
  fact: 'semantic',
  identity: 'semantic',
  preference: 'semantic',
  policy: 'semantic',
  summary: 'semantic',
  procedure: 'procedural',
  blueprint: 'procedural'
};

export function storeClassForKind(kind: MemoryKind): Exclude<MemoryStoreClass, 'working'> {
  return KIND_TO_STORE_CLASS[kind];
}

const STORE_CLASS_TO_KINDS: Readonly<
  Record<Exclude<MemoryStoreClass, 'working'>, readonly MemoryKind[]>
> = {
  episodic: ['episode', 'artifact', 'decision'],
  semantic: ['fact', 'identity', 'preference', 'policy', 'summary'],
  procedural: ['procedure', 'blueprint']
};

export function kindsForStoreClass(
  storeClass: Exclude<MemoryStoreClass, 'working'>
): readonly MemoryKind[] {
  return STORE_CLASS_TO_KINDS[storeClass];
}

export type MemoryWriteRule =
  | 'run_local_scratch' // working: ephemeral, expiry-bound, never promoted
  | 'append_only_ledger' // episodic: immutable evidence, superseded not edited
  | 'curated_supersede' // semantic: durable facts revised only by supersession
  | 'validated_supersede'; // procedural: workflows/blueprints gated before durable use

export type MemoryRetention =
  | 'run_local' // discarded with the run's lifetime
  | 'local_durable' // stays authoritative inside its owning sleeve
  | 'promotable'; // may become a cross-sleeve SharedApprovedBundle after operator review

export type MemoryConsolidationRole = 'source' | 'target' | 'none';

export interface MemoryStorePolicy {
  readonly storeClass: MemoryStoreClass;
  readonly writeRule: MemoryWriteRule;
  readonly retention: MemoryRetention;
  /** Working state is never auto-promoted; all durable classes require operator review to cross a sleeve. */
  readonly autoPromotable: false;
  /**
   * Deterministic BM25 column weights (title, content, tags) applied when this
   * store is queried in isolation. Semantic/procedural weight titles higher
   * (stable named knowledge); episodic weights body content (concrete events).
   */
  readonly ftsWeights: readonly [title: number, content: number, tags: number];
  /** Episodic evidence feeds consolidation; semantic/procedural are its targets. */
  readonly consolidationRole: MemoryConsolidationRole;
  readonly description: string;
}

export const MEMORY_STORE_POLICIES: Readonly<Record<MemoryStoreClass, MemoryStorePolicy>> = {
  working: {
    storeClass: 'working',
    writeRule: 'run_local_scratch',
    retention: 'run_local',
    autoPromotable: false,
    ftsWeights: [1, 1, 1],
    consolidationRole: 'none',
    description: 'Run-local active goals and intermediate state; never promoted to durable memory.'
  },
  episodic: {
    storeClass: 'episodic',
    writeRule: 'append_only_ledger',
    retention: 'local_durable',
    autoPromotable: false,
    ftsWeights: [4, 2, 2],
    consolidationRole: 'source',
    description:
      'Append-only ledger of concrete events, artifacts, and decisions kept local to the sleeve.'
  },
  semantic: {
    storeClass: 'semantic',
    writeRule: 'curated_supersede',
    retention: 'promotable',
    autoPromotable: false,
    ftsWeights: [8, 1, 2],
    consolidationRole: 'target',
    description:
      'Decontextualized facts, identities, preferences, policies, and summaries with validity windows.'
  },
  procedural: {
    storeClass: 'procedural',
    writeRule: 'validated_supersede',
    retention: 'promotable',
    autoPromotable: false,
    ftsWeights: [8, 2, 3],
    consolidationRole: 'target',
    description: 'Validated reusable workflows and operator-sanctioned blueprints.'
  }
};

export function policyForKind(kind: MemoryKind): MemoryStorePolicy {
  return MEMORY_STORE_POLICIES[storeClassForKind(kind)];
}

/** The durable store classes, in a stable order for deterministic iteration. */
export const DURABLE_STORE_CLASSES: readonly Exclude<MemoryStoreClass, 'working'>[] = [
  'episodic',
  'semantic',
  'procedural'
];

/** All store classes including run-local working state. */
export const ALL_STORE_CLASSES: readonly MemoryStoreClass[] = [
  'working',
  'episodic',
  'semantic',
  'procedural'
];
