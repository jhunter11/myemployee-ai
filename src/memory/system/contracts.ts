import { z } from 'zod';

import {
  AccessAgentIdSchema,
  AccessSensitivitySchema,
  ControlScopeIdSchema,
  MemorySleeveIdSchema
} from '../../agents/access-control-contracts';
import type { ScopedContextCompilation } from '../../knowledge/context-compiler';
import {
  MemoryFragmentIdSchema,
  MemoryKindSchema,
  type LexicalRetrievalResult,
  type MemoryFragmentRecord
} from '../../knowledge/retrieval-contracts';
import { AppError } from '../../utils/errors';
import { storeClassForKind, type MemoryStoreClass } from './store-classes';

/**
 * The interchangeable memory backends, ordered by increasing structure:
 *   flat_untyped   — EXPERIMENTAL CONTROL ONLY: tags and lexical ranking with no
 *                    temporal reasoning, matching the literature's flat baseline.
 *                    Never select it for production; it returns stale facts by design.
 *   flat           — one store, metadata tags, temporally-filtered lexical retrieval
 *   typed_hybrid   — CoALA store classes with propose-only consolidation
 *   typed_temporal — typed_hybrid + validity-window reasoning and stale suppression
 *   ledger         — event-sourced revisions with bitemporal semantics and deterministic projections
 */
export const MemorySystemIdSchema = z.enum([
  'flat_untyped',
  'flat',
  'typed_hybrid',
  'typed_temporal',
  'ledger'
]);
export type MemorySystemId = z.infer<typeof MemorySystemIdSchema>;

const entryIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const runIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const slotKeyPattern = /^[a-z][a-z0-9_:-]{0,63}$/;
const plannerVersionPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export const MemoryStoreClassSchema = z.enum(['working', 'episodic', 'semantic', 'procedural']);
export const MemoryTemporalStateSchema = z.enum(['current', 'historical', 'transitional']);
export const ConsolidationTargetStoreSchema = z.enum(['semantic', 'procedural']);

/**
 * Raised when a backend that does not implement a capability is asked to use it.
 * Prefer the null capability accessors (`workingMemory()` etc.); this exists so a
 * forced call still fails closed with a typed, secret-free error.
 */
export class MemorySystemUnsupportedError extends AppError {
  constructor(systemId: MemorySystemId, capability: string) {
    super(
      501,
      'MEMORY_SYSTEM_UNSUPPORTED',
      `Memory system '${systemId}' does not support '${capability}'`
    );
  }
}

// --- Working memory (run-local) --------------------------------------------

export const WorkingMemoryEntryInputSchema = z
  .strictObject({
    id: z.string().regex(entryIdPattern),
    ownerScopeId: ControlScopeIdSchema,
    sleeveId: MemorySleeveIdSchema,
    runId: z.string().regex(runIdPattern),
    slotKey: z.string().regex(slotKeyPattern),
    content: z.string().min(1).max(65_536),
    sensitivity: AccessSensitivitySchema,
    recordedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    supersedesEntryId: z.string().regex(entryIdPattern).nullable()
  })
  .superRefine((entry, context) => {
    if (Date.parse(entry.expiresAt) <= Date.parse(entry.recordedAt)) {
      context.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: 'expiresAt must follow recordedAt'
      });
    }
    if (entry.supersedesEntryId === entry.id) {
      context.addIssue({
        code: 'custom',
        path: ['supersedesEntryId'],
        message: 'A working entry cannot supersede itself'
      });
    }
  });

export const WorkingMemoryRecordSchema = WorkingMemoryEntryInputSchema.safeExtend({
  contentSha256: z.string().regex(/^[a-f0-9]{64}$/),
  supersededByEntryId: z.string().regex(entryIdPattern).nullable()
});

export const WorkingMemoryReadQuerySchema = z.strictObject({
  ownerScopeId: ControlScopeIdSchema,
  sleeveId: MemorySleeveIdSchema,
  runId: z.string().regex(runIdPattern),
  slotKey: z.string().regex(slotKeyPattern).nullable(),
  evaluatedAt: z.iso.datetime(),
  limit: z.number().int().min(1).max(100)
});

export type WorkingMemoryEntryInput = z.infer<typeof WorkingMemoryEntryInputSchema>;
export type WorkingMemoryRecord = z.infer<typeof WorkingMemoryRecordSchema>;
export type WorkingMemoryReadQuery = z.infer<typeof WorkingMemoryReadQuerySchema>;

// --- Consolidation candidates (episodic -> semantic/procedural) -------------

export const ConsolidationCandidateInputSchema = z
  .strictObject({
    id: z.string().regex(entryIdPattern),
    ownerScopeId: ControlScopeIdSchema,
    sleeveId: MemorySleeveIdSchema,
    targetStore: ConsolidationTargetStoreSchema,
    proposedKind: MemoryKindSchema,
    title: z.string().trim().min(1).max(240),
    content: z.string().min(1).max(65_536),
    sourceFragmentIds: z.array(MemoryFragmentIdSchema).min(1).max(64),
    evidenceCount: z.number().int().min(1).max(100_000),
    temporalState: MemoryTemporalStateSchema,
    confidencePermille: z.number().int().min(0).max(1_000),
    rationale: z.string().trim().min(1).max(2_000),
    plannerVersion: z.string().regex(plannerVersionPattern),
    proposedBy: AccessAgentIdSchema,
    sensitivity: AccessSensitivitySchema,
    recordedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    supersedesCandidateId: z.string().regex(entryIdPattern).nullable()
  })
  .superRefine((candidate, context) => {
    if (storeClassForKind(candidate.proposedKind) !== candidate.targetStore) {
      context.addIssue({
        code: 'custom',
        path: ['proposedKind'],
        message: `proposedKind '${candidate.proposedKind}' does not belong to target store '${candidate.targetStore}'`
      });
    }
    if (candidate.evidenceCount < candidate.sourceFragmentIds.length) {
      context.addIssue({
        code: 'custom',
        path: ['evidenceCount'],
        message: 'evidenceCount cannot be smaller than the linked provenance sample'
      });
    }
    if (new Set(candidate.sourceFragmentIds).size !== candidate.sourceFragmentIds.length) {
      context.addIssue({
        code: 'custom',
        path: ['sourceFragmentIds'],
        message: 'sourceFragmentIds must be unique'
      });
    }
    if (Date.parse(candidate.expiresAt) <= Date.parse(candidate.recordedAt)) {
      context.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: 'expiresAt must follow recordedAt'
      });
    }
    if (candidate.supersedesCandidateId === candidate.id) {
      context.addIssue({
        code: 'custom',
        path: ['supersedesCandidateId'],
        message: 'A candidate cannot supersede itself'
      });
    }
  });

export const ConsolidationCandidateRecordSchema = ConsolidationCandidateInputSchema.safeExtend({
  contentSha256: z.string().regex(/^[a-f0-9]{64}$/),
  supersededByCandidateId: z.string().regex(entryIdPattern).nullable()
});

export const ConsolidationCandidateQuerySchema = z.strictObject({
  ownerScopeId: ControlScopeIdSchema,
  sleeveId: MemorySleeveIdSchema,
  targetStore: ConsolidationTargetStoreSchema.nullable(),
  evaluatedAt: z.iso.datetime(),
  limit: z.number().int().min(1).max(100)
});

export type ConsolidationCandidateInput = z.infer<typeof ConsolidationCandidateInputSchema>;
export type ConsolidationCandidateRecord = z.infer<typeof ConsolidationCandidateRecordSchema>;
export type ConsolidationCandidateQuery = z.infer<typeof ConsolidationCandidateQuerySchema>;

// --- Procedure candidates (repeated-workflow promotion) ---------------------

export const ProcedureStepSchema = z.string().trim().min(1).max(500);

export const ProcedureCandidateInputSchema = z
  .strictObject({
    id: z.string().regex(entryIdPattern),
    ownerScopeId: ControlScopeIdSchema,
    sleeveId: MemorySleeveIdSchema,
    workflowSignature: z.string().regex(/^[a-f0-9]{64}$/),
    title: z.string().trim().min(1).max(240),
    steps: z.array(ProcedureStepSchema).min(1).max(64),
    successCount: z.number().int().min(1).max(100_000),
    firstSeenAt: z.iso.datetime(),
    lastSeenAt: z.iso.datetime(),
    rationale: z.string().trim().min(1).max(2_000),
    plannerVersion: z.string().regex(plannerVersionPattern),
    proposedBy: AccessAgentIdSchema,
    sensitivity: AccessSensitivitySchema,
    recordedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    supersedesCandidateId: z.string().regex(entryIdPattern).nullable()
  })
  .superRefine((candidate, context) => {
    if (Date.parse(candidate.lastSeenAt) < Date.parse(candidate.firstSeenAt)) {
      context.addIssue({
        code: 'custom',
        path: ['lastSeenAt'],
        message: 'lastSeenAt must be >= firstSeenAt'
      });
    }
    if (Date.parse(candidate.expiresAt) <= Date.parse(candidate.recordedAt)) {
      context.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: 'expiresAt must follow recordedAt'
      });
    }
    if (candidate.supersedesCandidateId === candidate.id) {
      context.addIssue({
        code: 'custom',
        path: ['supersedesCandidateId'],
        message: 'A candidate cannot supersede itself'
      });
    }
  });

export const ProcedureCandidateRecordSchema = ProcedureCandidateInputSchema.safeExtend({
  contentSha256: z.string().regex(/^[a-f0-9]{64}$/),
  supersededByCandidateId: z.string().regex(entryIdPattern).nullable()
});

export const ProcedureCandidateQuerySchema = z.strictObject({
  ownerScopeId: ControlScopeIdSchema,
  sleeveId: MemorySleeveIdSchema,
  evaluatedAt: z.iso.datetime(),
  limit: z.number().int().min(1).max(100)
});

export type ProcedureStep = z.infer<typeof ProcedureStepSchema>;
export type ProcedureCandidateInput = z.infer<typeof ProcedureCandidateInputSchema>;
export type ProcedureCandidateRecord = z.infer<typeof ProcedureCandidateRecordSchema>;
export type ProcedureCandidateQuery = z.infer<typeof ProcedureCandidateQuerySchema>;

// --- The interchangeable seam ----------------------------------------------

export interface MemorySystemCapabilities {
  readonly workingMemory: boolean;
  readonly consolidation: boolean;
  readonly proceduralPromotion: boolean;
  readonly storeClasses: readonly MemoryStoreClass[];
}

/** Run-local working state. Records are append-only and never promoted. */
export interface WorkingMemoryStore {
  record(input: unknown): Promise<WorkingMemoryRecord>;
  read(query: unknown): Promise<WorkingMemoryRecord[]>;
}

/** Propose-only channel that distills episodic evidence into semantic/procedural candidates. */
export interface ConsolidationProposalStore {
  propose(input: unknown): Promise<ConsolidationCandidateRecord>;
  listOpen(query: unknown): Promise<ConsolidationCandidateRecord[]>;
}

/** Propose-only channel for repeated-workflow (Voyager-style) procedure promotion. */
export interface ProceduralPromotionStore {
  propose(input: unknown): Promise<ProcedureCandidateRecord>;
  listOpen(query: unknown): Promise<ProcedureCandidateRecord[]>;
}

/**
 * The interchangeable memory backend. Mirrors the model-provider seam: one
 * uniform contract, swappable implementations, fail-closed. Backends share the
 * memory_fragments substrate and core authorization/temporal filters; an experimental
 * backend may apply an audited, deterministic re-rank over that already-admissible set.
 * The capability accessors return `null` on backends that do not implement the typed
 * stores (today: the flat backend).
 */
export interface MemorySystem {
  readonly id: MemorySystemId;
  readonly capabilities: MemorySystemCapabilities;
  /** Durable fragment write (episodic/semantic/procedural), sleeve- and sensitivity-checked. */
  write(input: unknown): Promise<MemoryFragmentRecord>;
  /** Authorized lexical retrieval over durable fragments. */
  retrieve(query: unknown): Promise<LexicalRetrievalResult>;
  /** Deterministic, budget-bounded context assembly. */
  compileContext(input: unknown): ScopedContextCompilation;
  workingMemory(): WorkingMemoryStore | null;
  consolidation(): ConsolidationProposalStore | null;
  procedures(): ProceduralPromotionStore | null;
}
