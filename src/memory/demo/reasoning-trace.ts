import type { ScopedContextCompilation } from '../../knowledge/context-compiler';
import type { LexicalRetrievalResult } from '../../knowledge/retrieval-contracts';
import type { MemorySystemId } from '../system/contracts';
import { sha256 } from '../system/hashing';
import { storeClassForKind, type MemoryStoreClass } from '../system/store-classes';
import {
  resolveEvidence,
  type EVIDENCE_RESOLVER_POLICY_VERSION,
  type EvidenceMatch,
  type EvidenceResolutionReason
} from './evidence-resolver';
import { sampleItemById, type SampleItemRole, type SampleQuestion } from './sample-memory';

/**
 * A readable, end-to-end account of how one question became one answer.
 *
 * The research reports converge on the point that memory must be scored as a
 * pipeline rather than by its final answer: a backend can look right while having
 * retrieved the wrong evidence, and can look wrong while having behaved correctly.
 * A trace therefore records every stage — what was authorized, what was retrieved,
 * what was suppressed *and why*, what survived the context budget, and what was
 * finally cited — so a disagreement between two backends can be located precisely
 * instead of argued about.
 *
 * Everything here is pure. Given the same retrieval result the trace is identical,
 * and its fingerprint proves it.
 */

export type TraceVerdict = 'selected' | 'omitted';

export interface TraceCandidate {
  readonly fragmentId: string;
  readonly sourceId: string;
  readonly verdict: TraceVerdict;
  /** Rank among selected items; null when omitted. */
  readonly rank: number | null;
  /** BM25 score, lower is a better match under SQLite's FTS5 scoring. */
  readonly bm25: number | null;
  readonly storeClass: MemoryStoreClass | null;
  readonly title: string | null;
  /** Why the retrieval path kept or dropped it — verbatim from the audited manifest. */
  readonly reason: string;
  /** The corpus role, when this fragment is a known sample item. */
  readonly role: SampleItemRole | null;
  readonly note: string | null;
}

export interface TraceResolution {
  readonly outcome: 'answered' | 'abstained';
  readonly answer: string;
  readonly citedFragmentIds: readonly string[];
  /**
   * The resolver is deterministic and model-free: it cites the strongest surviving
   * query match only when both query coverage and evidence confidence clear fixed
   * thresholds. It is a fixed stand-in for a language model so that any difference
   * between two traces is attributable to the memory backend rather than to sampling.
   */
  readonly resolverPolicy: typeof EVIDENCE_RESOLVER_POLICY_VERSION;
  readonly resolverReason: EvidenceResolutionReason;
  /** Best observable candidate, including when the resolver declined to cite it. */
  readonly evidenceMatch: EvidenceMatch | null;
}

/**
 * Correctness is scored at two independent layers, because conflating them is the
 * mistake the research reports warn about most: a system can retrieve exactly the
 * right evidence and still answer badly, or answer plausibly off the wrong evidence.
 *
 *   memory layer — did retrieval surface the required evidence and hold back the
 *                  stale, withdrawn, and out-of-scope items? This is the backend's
 *                  job, and it is what a backend comparison is actually measuring.
 *   answer layer — did the fixed, model-free resolver reach the right conclusion?
 *                  The resolver is held constant across backends, so a difference
 *                  here is downstream of a memory difference, never a backend's doing.
 */
export interface TraceAssessment {
  readonly memoryCorrect: boolean;
  /** Required evidence that never made it into the selected set. */
  readonly missingEvidence: readonly string[];
  /** Forbidden evidence that survived into the selected set — the disqualifying failure. */
  readonly leakedEvidence: readonly string[];
  readonly answerCorrect: boolean;
  readonly missingCitations: readonly string[];
  readonly forbiddenCited: readonly string[];
  readonly abstentionExpected: boolean;
  readonly abstentionCorrect: boolean;
  /** Suppressed items that the corpus marks as traps — proof the guard fired. */
  readonly suppressedTraps: readonly string[];
  readonly memoryFailureSummary: string | null;
  readonly answerFailureSummary: string | null;
}

export interface ReasoningTrace {
  readonly backend: MemorySystemId;
  readonly questionId: string;
  readonly question: string;
  readonly scopeId: string;
  readonly sleeveId: string;
  readonly evaluatedAt: string;
  readonly normalizedTerms: readonly string[];
  readonly candidates: readonly TraceCandidate[];
  readonly compilation: {
    readonly status: ScopedContextCompilation['status'];
    readonly usedEvidenceTokens: number;
    readonly availableEvidenceTokens: number;
    readonly selectedFragmentIds: readonly string[];
  } | null;
  readonly resolution: TraceResolution;
  readonly assessment: TraceAssessment;
  /** Stable over identical inputs — two runs of the same backend must match. */
  readonly fingerprint: string;
  /**
   * The same digest with the backend's NAME left out, so it captures only what the
   * backend did. `fingerprint` includes the id, which means two backends always
   * differ there even when they behaved identically — useless for the one
   * comparison this harness exists to make. Equal `behaviorFingerprint` is a
   * positive claim: these backends made the same decisions on this question.
   */
  readonly behaviorFingerprint: string;
}

export interface BuildReasoningTraceInput {
  readonly backend: MemorySystemId;
  readonly question: SampleQuestion;
  readonly retrieval: LexicalRetrievalResult;
  readonly evaluatedAt: string;
  readonly compilation?: ScopedContextCompilation | null;
}

function describeOmission(reason: string): string {
  switch (reason) {
    case 'superseded':
      return 'suppressed: a newer revision supersedes it';
    case 'validity_ended':
      return 'suppressed: its validity window closed before the query time';
    case 'not_yet_valid':
      return 'suppressed: not yet valid at the query time';
    case 'expired':
      return 'suppressed: past its expiry';
    case 'retrieval_disabled':
      return 'suppressed: withdrawn from retrieval by an operator';
    case 'result_limit':
      return 'dropped: ranked below the result limit';
    default:
      return `suppressed: ${reason}`;
  }
}

/** Builds the trace from the audited retrieval manifest — never from a re-derivation. */
export function buildReasoningTrace(input: BuildReasoningTraceInput): ReasoningTrace {
  const { retrieval, question } = input;
  const itemsById = new Map(retrieval.items.map((entry) => [entry.id, entry]));

  const selected: TraceCandidate[] = retrieval.manifest.selected.map((entry) => {
    const item = itemsById.get(entry.fragmentId);
    const sample = sampleItemById(entry.fragmentId);
    return {
      fragmentId: entry.fragmentId,
      sourceId: entry.sourceId,
      verdict: 'selected',
      rank: entry.rank,
      bm25: item?.bm25 ?? null,
      storeClass: item === undefined ? null : storeClassForKind(item.kind),
      title: item?.title ?? null,
      reason: 'selected: matched the query and passed every scope, validity, and eligibility check',
      role: sample?.role ?? null,
      note: sample?.note ?? null
    };
  });

  const omitted: TraceCandidate[] = retrieval.manifest.omitted.map((entry) => {
    const sample = sampleItemById(entry.fragmentId);
    return {
      fragmentId: entry.fragmentId,
      sourceId: entry.sourceId,
      verdict: 'omitted',
      rank: null,
      bm25: entry.bm25,
      storeClass: sample === undefined ? null : storeClassForKind(sample.fragment.kind),
      title: sample?.fragment.title ?? null,
      reason: describeOmission(entry.reason),
      role: sample?.role ?? null,
      note: sample?.note ?? null
    };
  });

  const candidates = [...selected, ...omitted];

  const compiledIds =
    input.compilation == null
      ? null
      : input.compilation.selected.flatMap((fragment) => fragment.fragmentIds);

  // Resolution: consider only what survived compilation if it ran, otherwise retrieval.
  // Compiler order is utility-per-token order, not answer relevance, so the resolver
  // re-scores the surviving set instead of blindly citing its first item.
  const survivingIds = compiledIds ?? selected.map((candidate) => candidate.fragmentId);
  const evidenceResolution = resolveEvidence({
    normalizedTerms: retrieval.manifest.normalizedTerms,
    retrievedItems: retrieval.items,
    survivingFragmentIds: survivingIds
  });
  const selectedItem = evidenceResolution.selectedItem;
  const abstentionAnswer =
    evidenceResolution.reason === 'insufficient_query_specificity'
      ? 'The question is too underspecified to select evidence safely.'
      : evidenceResolution.reason === 'confidence_below_threshold'
        ? 'The matching evidence is below the confidence floor, so the question is left unanswered.'
        : evidenceResolution.reason === 'insufficient_query_coverage'
          ? 'No evidence matched enough of the question to support an answer.'
          : 'No supporting evidence survived retrieval, so the question is left unanswered.';
  const resolution: TraceResolution =
    selectedItem === null
      ? {
          outcome: 'abstained',
          answer: abstentionAnswer,
          citedFragmentIds: [],
          resolverPolicy: evidenceResolution.policyVersion,
          resolverReason: evidenceResolution.reason,
          evidenceMatch: evidenceResolution.bestMatch
        }
      : {
          outcome: 'answered',
          answer: selectedItem.content,
          citedFragmentIds: [selectedItem.id],
          resolverPolicy: evidenceResolution.policyVersion,
          resolverReason: evidenceResolution.reason,
          evidenceMatch: evidenceResolution.bestMatch
        };

  // --- Memory layer: judged on what retrieval selected, not on the final answer.
  const selectedIds = new Set(selected.map((candidate) => candidate.fragmentId));
  const missingEvidence = question.expectedFragmentIds.filter((id) => !selectedIds.has(id));
  const leakedEvidence = question.forbiddenFragmentIds.filter((id) => selectedIds.has(id));
  const memoryCorrect = missingEvidence.length === 0 && leakedEvidence.length === 0;
  const memoryFailures: string[] = [];
  if (leakedEvidence.length > 0) {
    memoryFailures.push(`surfaced forbidden evidence: ${leakedEvidence.join(', ')}`);
  }
  if (missingEvidence.length > 0) {
    memoryFailures.push(`failed to surface required evidence: ${missingEvidence.join(', ')}`);
  }

  // --- Answer layer: the fixed resolver, held constant across every backend.
  const cited = new Set(resolution.citedFragmentIds);
  const missingCitations = question.expectedFragmentIds.filter((id) => !cited.has(id));
  const forbiddenCited = question.forbiddenFragmentIds.filter((id) => cited.has(id));
  const abstentionExpected = question.expectedFragmentIds.length === 0;
  const abstentionCorrect = abstentionExpected
    ? resolution.outcome === 'abstained'
    : resolution.outcome === 'answered';
  const answerCorrect =
    missingCitations.length === 0 && forbiddenCited.length === 0 && abstentionCorrect;
  const answerFailures: string[] = [];
  if (forbiddenCited.length > 0) {
    answerFailures.push(`cited forbidden evidence: ${forbiddenCited.join(', ')}`);
  }
  if (missingCitations.length > 0) {
    answerFailures.push(`missed required citation: ${missingCitations.join(', ')}`);
  }
  if (!abstentionCorrect) {
    answerFailures.push(
      abstentionExpected
        ? 'answered from loosely-matched evidence when it should have abstained'
        : 'abstained when evidence was available'
    );
  }

  const suppressedTraps = omitted
    .filter(
      (candidate) =>
        candidate.role === 'superseded' ||
        candidate.role === 'validity_ended' ||
        candidate.role === 'retrieval_disabled' ||
        candidate.role === 'cross_sleeve_trap'
    )
    .map((candidate) => candidate.fragmentId);

  const assessment: TraceAssessment = {
    memoryCorrect,
    missingEvidence,
    leakedEvidence,
    answerCorrect,
    missingCitations,
    forbiddenCited,
    abstentionExpected,
    abstentionCorrect,
    suppressedTraps,
    memoryFailureSummary: memoryFailures.length === 0 ? null : memoryFailures.join('; '),
    answerFailureSummary: answerFailures.length === 0 ? null : answerFailures.join('; ')
  };

  const compilation =
    input.compilation == null
      ? null
      : {
          status: input.compilation.status,
          usedEvidenceTokens: input.compilation.capacity.usedEvidence,
          availableEvidenceTokens: input.compilation.capacity.availableEvidence,
          selectedFragmentIds: compiledIds ?? []
        };
  const tracePayload = {
    questionId: question.id,
    question: question.question,
    scopeId: question.scopeId,
    sleeveId: question.sleeveId,
    evaluatedAt: input.evaluatedAt,
    normalizedTerms: retrieval.manifest.normalizedTerms,
    candidates,
    compilation,
    resolution,
    assessment
  };
  const behaviorFingerprint = sha256(JSON.stringify(tracePayload));
  const fingerprint = sha256(JSON.stringify({ backend: input.backend, ...tracePayload }));

  return {
    backend: input.backend,
    ...tracePayload,
    fingerprint,
    behaviorFingerprint
  };
}

/** Renders a trace as the indented reasoning path an operator reads in a terminal. */
export function renderReasoningTrace(trace: ReasoningTrace): string {
  const lines: string[] = [];
  lines.push(`Q: ${trace.question}`);
  lines.push(`   backend=${trace.backend}  sleeve=${trace.sleeveId}  at=${trace.evaluatedAt}`);
  lines.push('');
  lines.push(
    `  1. authorize  -> read grant on ${trace.sleeveId} (deny-first; other sleeves unreadable)`
  );
  lines.push(`  2. retrieve   -> terms [${trace.normalizedTerms.join(', ')}]`);

  const selected = trace.candidates.filter((candidate) => candidate.verdict === 'selected');
  const omitted = trace.candidates.filter((candidate) => candidate.verdict === 'omitted');

  if (selected.length === 0) {
    lines.push('       (nothing survived retrieval)');
  }
  for (const candidate of selected) {
    const score = candidate.bm25 === null ? '' : ` bm25=${candidate.bm25.toFixed(3)}`;
    lines.push(
      `       [${candidate.rank}] ${candidate.fragmentId} (${candidate.storeClass ?? '?'})${score}`
    );
    if (candidate.title !== null) lines.push(`           "${candidate.title}"`);
  }

  if (omitted.length > 0) {
    lines.push(`  3. suppress   -> ${omitted.length} candidate(s) held back`);
    for (const candidate of omitted) {
      lines.push(`       - ${candidate.fragmentId}: ${candidate.reason}`);
      if (candidate.note !== null) lines.push(`           why it matters: ${candidate.note}`);
    }
  } else {
    lines.push('  3. suppress   -> nothing held back');
  }

  if (trace.compilation !== null) {
    lines.push(
      `  4. compile    -> ${trace.compilation.status}, ` +
        `${trace.compilation.usedEvidenceTokens}/${trace.compilation.availableEvidenceTokens} evidence tokens used`
    );
  }

  lines.push(`  5. resolve    -> ${trace.resolution.outcome}`);
  lines.push(
    `       policy: ${trace.resolution.resolverPolicy} (${trace.resolution.resolverReason})`
  );
  if (trace.resolution.evidenceMatch !== null) {
    lines.push(
      `       best match: ${trace.resolution.evidenceMatch.fragmentId} ` +
        `coverage=${trace.resolution.evidenceMatch.meaningfulCoveragePermille}/1000 ` +
        `confidence=${trace.resolution.evidenceMatch.confidencePermille}/1000`
    );
  }
  lines.push(`       ${trace.resolution.answer}`);
  if (trace.resolution.citedFragmentIds.length > 0) {
    lines.push(`       cites: ${trace.resolution.citedFragmentIds.join(', ')}`);
  }
  lines.push('');
  lines.push(
    trace.assessment.memoryCorrect
      ? '  MEMORY: correct — surfaced what was required, held back what was not'
      : `  MEMORY: incorrect — ${trace.assessment.memoryFailureSummary ?? 'unknown failure'}`
  );
  lines.push(
    trace.assessment.answerCorrect
      ? '  ANSWER: correct'
      : `  ANSWER: incorrect — ${trace.assessment.answerFailureSummary ?? 'unknown failure'}`
  );
  if (trace.assessment.suppressedTraps.length > 0) {
    lines.push(`  guards fired on: ${trace.assessment.suppressedTraps.join(', ')}`);
  }
  lines.push(`  trace fingerprint: ${trace.fingerprint.slice(0, 16)}`);
  return lines.join('\n');
}
