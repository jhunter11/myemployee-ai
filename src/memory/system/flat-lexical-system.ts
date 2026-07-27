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
import type {
  ConsolidationProposalStore,
  MemorySystem,
  MemorySystemCapabilities,
  ProceduralPromotionStore,
  WorkingMemoryStore
} from './contracts';

export interface FlatLexicalMemorySystemOptions {
  sqlite: SQLite.Database;
  access: BoundAgentAccess;
}

/**
 * Backend A. A uniform facade over the existing flat memory substrate:
 * {@link MemoryFragmentRepository}, {@link ScopedLexicalRetrievalService}, and
 * {@link compileScopedContext}. It changes no behavior of those services — it
 * only proves the interchangeable seam. The typed store capabilities are absent,
 * so the capability accessors return `null`.
 */
export class FlatLexicalMemorySystem implements MemorySystem {
  readonly id = 'flat' as const;
  readonly capabilities: MemorySystemCapabilities = Object.freeze({
    workingMemory: false,
    consolidation: false,
    proceduralPromotion: false,
    storeClasses: Object.freeze(['episodic', 'semantic', 'procedural'] as const)
  });

  private readonly fragments: MemoryFragmentRepository;
  private readonly retrieval: ScopedLexicalRetrievalService;

  constructor(options: FlatLexicalMemorySystemOptions) {
    this.fragments = new MemoryFragmentRepository(options.sqlite);
    this.retrieval = new ScopedLexicalRetrievalService(options.sqlite, options.access);
  }

  write(input: unknown): Promise<MemoryFragmentRecord> {
    return this.fragments.put(input);
  }

  retrieve(query: unknown): Promise<LexicalRetrievalResult> {
    return this.retrieval.query(query);
  }

  compileContext(input: unknown): ScopedContextCompilation {
    return compileScopedContext(input);
  }

  workingMemory(): WorkingMemoryStore | null {
    return null;
  }

  consolidation(): ConsolidationProposalStore | null {
    return null;
  }

  procedures(): ProceduralPromotionStore | null {
    return null;
  }
}
