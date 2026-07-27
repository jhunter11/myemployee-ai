import type SQLite from 'better-sqlite3';

import type { BoundAgentAccess } from '../../agents/access-control-repository';
import {
  compileScopedContext,
  type ScopedContextCompilation
} from '../../knowledge/context-compiler';
import { ScopedLexicalRetrievalService } from '../../knowledge/lexical-retrieval-service';
import { MemoryFragmentRepository } from '../../knowledge/memory-fragment-repository';
import type {
  LexicalRetrievalResult,
  MemoryFragmentRecord
} from '../../knowledge/retrieval-contracts';
import { ConsolidationCandidateRepository } from './consolidation-candidate-repository';
import type {
  ConsolidationProposalStore,
  MemorySystem,
  MemorySystemCapabilities,
  ProceduralPromotionStore,
  WorkingMemoryStore
} from './contracts';
import { sha256 } from './hashing';
import { ProcedureCandidateRepository } from './procedure-candidate-repository';
import { ALL_STORE_CLASSES } from './store-classes';
import { rerankByStorePolicy } from './store-retrieval-policy';
import { WorkingMemoryRepository } from './working-memory-repository';

export interface TypedHybridMemorySystemOptions {
  sqlite: SQLite.Database;
  access: BoundAgentAccess;
}

/**
 * Backend B — the CoALA typed-hybrid memory cell. It keeps the flat
 * `memory_fragments` table as the durable episodic/semantic/procedural substrate
 * (so every existing invariant survives) and adds three active store classes:
 *
 *   * working state via {@link WorkingMemoryRepository} (run-local, never promoted)
 *   * a propose-only consolidation channel ({@link ConsolidationCandidateRepository})
 *   * a propose-only procedural-promotion channel ({@link ProcedureCandidateRepository})
 *
 * `write` and `compileContext` are byte-for-byte the substrate services, so this
 * backend stays interchangeable with the flat backend on the write path.
 *
 * `retrieve` adds one deterministic pass the flat backend does not have: the
 * per-store `ftsWeights` declared in `store-classes.ts` are applied as a re-rank
 * over the audited candidate set. This is what makes typing observable at all —
 * without it a FlatTag-vs-TypedBasic comparison contrasts two identical retrieval
 * paths and can only ever measure noise. The re-rank reorders candidates; it never
 * admits one the substrate withheld, so scope, sensitivity, and temporal filtering
 * remain exactly where they were.
 *
 * Nothing in this backend moves memory across a sleeve. Cross-sleeve promotion
 * stays with the operator-reviewed SharedApprovedBundle path.
 */
export class TypedHybridMemorySystem implements MemorySystem {
  readonly id = 'typed_hybrid' as const;
  readonly capabilities: MemorySystemCapabilities = Object.freeze({
    workingMemory: true,
    consolidation: true,
    proceduralPromotion: true,
    storeClasses: ALL_STORE_CLASSES
  });

  private readonly fragments: MemoryFragmentRepository;
  private readonly retrieval: ScopedLexicalRetrievalService;
  private readonly working: WorkingMemoryRepository;
  private readonly consolidationStore: ConsolidationCandidateRepository;
  private readonly procedureStore: ProcedureCandidateRepository;

  constructor(options: TypedHybridMemorySystemOptions) {
    this.fragments = new MemoryFragmentRepository(options.sqlite);
    this.retrieval = new ScopedLexicalRetrievalService(options.sqlite, options.access);
    this.working = new WorkingMemoryRepository(options.sqlite);
    this.consolidationStore = new ConsolidationCandidateRepository(options.sqlite);
    this.procedureStore = new ProcedureCandidateRepository(options.sqlite);
  }

  write(input: unknown): Promise<MemoryFragmentRecord> {
    return this.fragments.put(input);
  }

  /**
   * The substrate decides WHAT is admissible; the store policy decides in WHAT
   * ORDER the admissible candidates are offered. Keeping those two decisions
   * separate is why a re-rank can never widen a result set: it permutes
   * `base.items` and nothing else.
   *
   * The manifest is rebuilt rather than carried over, because `selected` records a
   * rank per fragment — a manifest copied across a reorder would attest to an
   * order that no longer exists, and its fingerprint would certify the lie.
   */
  async retrieve(query: unknown): Promise<LexicalRetrievalResult> {
    const base = await this.retrieval.query(query);
    const ranking = rerankByStorePolicy({
      normalizedTerms: base.manifest.normalizedTerms,
      candidates: base.items
    });

    const byFragmentId = new Map(base.items.map((item) => [item.id, item]));
    const items = ranking.ranked
      .flatMap((entry) => {
        const item = byFragmentId.get(entry.fragmentId);
        return item === undefined ? [] : [item];
      })
      .map((item, index) => ({ ...item, rank: index + 1 }));

    const unsignedManifest = {
      algorithm: base.manifest.algorithm,
      ownerScopeId: base.manifest.ownerScopeId,
      sleeveId: base.manifest.sleeveId,
      evaluatedAt: base.manifest.evaluatedAt,
      queryHash: base.manifest.queryHash,
      normalizedTerms: base.manifest.normalizedTerms,
      selected: items.map((item) => ({
        fragmentId: item.id,
        sourceId: item.sourceId,
        rank: item.rank,
        reason: item.selectionReason
      })),
      // Untouched: the re-rank never revisits an omission the substrate made.
      omitted: base.manifest.omitted
    };

    return {
      ownerScopeId: base.ownerScopeId,
      sleeveId: base.sleeveId,
      items,
      manifest: {
        ...unsignedManifest,
        fingerprint: sha256(JSON.stringify(unsignedManifest))
      }
    };
  }

  compileContext(input: unknown): ScopedContextCompilation {
    return compileScopedContext(input);
  }

  workingMemory(): WorkingMemoryStore {
    return this.working;
  }

  consolidation(): ConsolidationProposalStore {
    return this.consolidationStore;
  }

  procedures(): ProceduralPromotionStore {
    return this.procedureStore;
  }
}
