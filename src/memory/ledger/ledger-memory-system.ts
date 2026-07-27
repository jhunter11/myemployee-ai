import type SQLite from 'better-sqlite3';

import type { BoundAgentAccess } from '../../agents/access-control-repository';
import {
  compileScopedContext,
  type ScopedContextCompilation
} from '../../knowledge/context-compiler';
import { ScopedLexicalRetrievalService } from '../../knowledge/lexical-retrieval-service';
import { MemoryFragmentRepository } from '../../knowledge/memory-fragment-repository';
import {
  MemoryFragmentInputSchema,
  type LexicalRetrievalResult,
  type MemoryFragmentInput,
  type MemoryFragmentRecord
} from '../../knowledge/retrieval-contracts';
import { AppError } from '../../utils/errors';
import type {
  ConsolidationProposalStore,
  MemorySystem,
  MemorySystemCapabilities,
  ProceduralPromotionStore,
  WorkingMemoryStore
} from '../system/contracts';
import { sha256 } from '../system/hashing';
import { DURABLE_STORE_CLASSES } from '../system/store-classes';
import { canonicalize } from './canonical';
import { MEMORY_COMMAND_SCHEMA_VERSION, type LedgerCommand } from './commands';
import { LedgerRepository } from './ledger-repository';

export interface LedgerMemorySystemOptions {
  sqlite: SQLite.Database;
  access: BoundAgentAccess;
  /**
   * The registered agent a ledger write is attributed to.
   *
   * Optional only because the shared backend factory constructs every backend the
   * same way. When it is absent the author is RESOLVED from the sleeve's active
   * grant holders and must be unique — see {@link LedgerMemorySystem.resolveAuthor}.
   * It is never guessed.
   */
  authorAgentId?: string;
}

/**
 * Backend D — the deterministic ledger.
 *
 * This is the report's LEDGER-PLUS-PROJECTION design, wired into the
 * interchangeable memory seam. The ledger is the system of record: every write
 * travels the command path (`OBSERVE -> PROPOSE -> ADD`) through the deterministic
 * reducer, gets a bitemporal revision, a canonical hash, and a provenance
 * footprint. `memory_fragments` stays exactly what it was — the RETRIEVAL
 * SUBSTRATE — so `retrieve()` and `compileContext()` remain behaviorally identical
 * to the flat backend and the seam stays genuinely interchangeable.
 *
 * Why the revision references the fragment instead of carrying its text: the
 * canonical form caps a string at 8,000 characters on purpose (an unbounded
 * canonicalizer on an agent-authored write path is a denial-of-service surface),
 * while a fragment may hold 64KB. Storing the fragment id, source id, and content
 * digest gives the ledger a tamper-evident anchor without duplicating the body —
 * and it makes erasure tractable, since a fragment can be redacted or
 * crypto-shredded without rewriting immutable ledger history.
 *
 * The three-stage write is not ceremony. It is the protocol: an observation
 * becomes a draft, the draft becomes a proposal, and only an accepted proposal
 * becomes canonical. Each stage compare-and-swaps on the previous head, so a
 * concurrent writer on the same thread loses the race loudly rather than
 * interleaving silently.
 */
export class LedgerMemorySystem implements MemorySystem {
  readonly id = 'ledger' as const;
  /**
   * Honest capabilities. The ledger implements the three DURABLE store classes; it
   * has no run-local working store, and consolidation and procedural promotion are
   * the typed-hybrid backend's propose-only channels, not this one's.
   */
  readonly capabilities: MemorySystemCapabilities = Object.freeze({
    workingMemory: false,
    consolidation: false,
    proceduralPromotion: false,
    storeClasses: DURABLE_STORE_CLASSES
  });

  private readonly sqlite: SQLite.Database;
  private readonly fragments: MemoryFragmentRepository;
  private readonly retrieval: ScopedLexicalRetrievalService;
  private readonly repository: LedgerRepository;
  private readonly authorAgentId: string | null;

  constructor(options: LedgerMemorySystemOptions) {
    this.sqlite = options.sqlite;
    this.fragments = new MemoryFragmentRepository(options.sqlite);
    this.retrieval = new ScopedLexicalRetrievalService(options.sqlite, options.access);
    this.repository = new LedgerRepository(options.sqlite);
    this.authorAgentId = options.authorAgentId ?? null;
  }

  /**
   * Who authored this revision?
   *
   * An explicit binding always wins. Otherwise the author is READ OUT of the
   * access-control tables: if exactly one agent holds an active grant on the
   * sleeve, attributing the write to it is a fact about who is authorized there,
   * not an inference. Zero or several holders is ambiguous, and an ambiguous
   * author is refused rather than resolved by a tiebreak — provenance that might
   * be wrong is worse than a write that did not happen.
   */
  private resolveAuthor(sleeveId: string): string {
    if (this.authorAgentId !== null) return this.authorAgentId;
    const holders = this.sqlite
      .prepare(
        `SELECT DISTINCT grants.agent_id AS agent_id
         FROM agent_sleeve_grants AS grants
         JOIN access_agents AS agents ON agents.agent_id = grants.agent_id
         WHERE grants.sleeve_id = ? AND grants.state = 'active' AND agents.state = 'active'
         ORDER BY grants.agent_id ASC`
      )
      .all(sleeveId) as { agent_id: string }[];
    const sole = holders[0];
    if (holders.length !== 1 || sole === undefined) {
      throw new AppError(
        409,
        'MEMORY_LEDGER_AUTHOR_UNBOUND',
        `Ledger writes require an explicit authorAgentId: sleeve '${sleeveId}' has ` +
          `${holders.length} authorized agents, so provenance cannot be attributed`
      );
    }
    return sole.agent_id;
  }

  /** The system of record itself, for time travel, replay, and audit queries. */
  ledger(): LedgerRepository {
    return this.repository;
  }

  /**
   * Deterministic thread identity for a fragment. Scoped by sleeve so the same
   * fragment id in two sleeves is two threads — collapsing them would be a
   * cross-sleeve join by accident.
   */
  static memoryIdForFragment(sleeveId: string, fragmentId: string): string {
    return `mem_${sha256(canonicalize({ sleeveId, fragmentId })).slice(0, 40)}`;
  }

  private static commandIds(
    fragment: MemoryFragmentInput,
    stage: 'observe' | 'propose' | 'add'
  ): { commandId: string; idempotencyKey: string } {
    const seed = sha256(
      canonicalize({
        sleeveId: fragment.sleeveId,
        fragmentId: fragment.id,
        sourceHash: fragment.sourceHash,
        recordedAt: fragment.recordedAt,
        stage
      })
    );
    return { commandId: `cmd_${seed.slice(0, 40)}`, idempotencyKey: `idk_${seed.slice(0, 40)}` };
  }

  /**
   * The claim a fragment asserts, in canonical form: a REFERENCE plus digests, not
   * the body. Structured rather than a triple because a fragment is prose, and the
   * conflict engine must not pretend it can adjudicate prose.
   */
  private static payloadFor(fragment: MemoryFragmentInput) {
    return {
      form: 'structured' as const,
      fields: {
        fragment_id: fragment.id,
        source_id: fragment.sourceId,
        source_hash: fragment.sourceHash,
        extraction_version: fragment.extractionVersion,
        title: fragment.title,
        content_sha256: sha256(fragment.content)
      }
    };
  }

  private static draftFor(fragment: MemoryFragmentInput) {
    return {
      kind: fragment.kind,
      // No entity key: a prose fragment has no deterministic dedupe anchor, and
      // inventing one would make unrelated fragments look like competing claims.
      entityKey: null,
      payloadCanonical: LedgerMemorySystem.payloadFor(fragment),
      eventTime: null,
      observedAt: fragment.recordedAt,
      validFrom: fragment.validFrom,
      validUntil: fragment.validUntil,
      derivationMethod: 'direct_observation' as const,
      confidencePermille: fragment.confidencePermille,
      sensitivity: fragment.sensitivity,
      retentionPolicy: 'until_superseded' as const,
      legalHold: false,
      workflowId: null,
      runId: null,
      sourceEventIds: [],
      // The fragment itself is the readable evidence behind the claim, which keeps
      // the record contract's evidence obligation satisfied for semantic and
      // procedural kinds without inventing provenance the caller did not supply.
      evidenceRefs: [{ type: 'artifact' as const, id: fragment.id }],
      derivedFrom: []
    };
  }

  private async submitStage(command: LedgerCommand): Promise<string> {
    const result = await this.repository.submit(command);
    const revisionId = result.revisions[0]?.revisionId;
    if (revisionId === undefined) {
      throw new AppError(
        500,
        'MEMORY_LEDGER_WRITE_INCOMPLETE',
        `Ledger command '${command.commandId}' produced no revision`
      );
    }
    return revisionId;
  }

  /**
   * Durable write, through the ledger.
   *
   * The ledger commits FIRST. If any stage is refused, no fragment is written and
   * the caller sees the typed refusal — the retrieval substrate never gets a row
   * the system of record declined to accept.
   */
  async write(rawInput: unknown): Promise<MemoryFragmentRecord> {
    const fragment = MemoryFragmentInputSchema.parse(rawInput);
    const issuedBy = this.resolveAuthor(fragment.sleeveId);
    const memoryId = LedgerMemorySystem.memoryIdForFragment(fragment.sleeveId, fragment.id);
    const draft = LedgerMemorySystem.draftFor(fragment);
    const envelope = {
      schemaVersion: MEMORY_COMMAND_SCHEMA_VERSION,
      ownerScopeId: fragment.ownerScopeId,
      sleeveId: fragment.sleeveId,
      issuedBy,
      issuedAt: fragment.recordedAt,
      // A programmatic write is a tool observation and nothing more. Claiming a
      // higher tier here would let any caller mint operator-grade authority.
      authorityTier: 'tool_observation' as const,
      approvalState: 'auto_accepted' as const,
      decidedAt: null
    };

    const observe = LedgerMemorySystem.commandIds(fragment, 'observe');
    const observedRevisionId = await this.submitStage({
      ...envelope,
      ...observe,
      op: 'OBSERVE',
      memoryId,
      draft
    } as LedgerCommand);

    const propose = LedgerMemorySystem.commandIds(fragment, 'propose');
    const proposedRevisionId = await this.submitStage({
      ...envelope,
      ...propose,
      op: 'PROPOSE',
      memoryId,
      baseRevisionId: observedRevisionId,
      draft
    } as LedgerCommand);

    const add = LedgerMemorySystem.commandIds(fragment, 'add');
    await this.submitStage({
      ...envelope,
      ...add,
      op: 'ADD',
      memoryId,
      baseRevisionId: proposedRevisionId,
      draft
    } as LedgerCommand);

    return this.fragments.put(fragment);
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
