import type { LexicalRetrievalItem, MemoryFragmentId } from '../../knowledge/retrieval-contracts';
import { AppError } from '../../utils/errors';
import { sha256 } from './hashing';
import {
  MEMORY_STORE_POLICIES,
  storeClassForKind,
  type MemoryKind,
  type MemoryStoreClass
} from './store-classes';

/**
 * Version stamp for the re-ranking rule itself. It is deliberately NOT the
 * manifest's `algorithm` field: the audited manifest still says
 * `sqlite_fts5_bm25_v1` because SQLite's BM25 is still what produced the
 * candidate set. This stamp records the *second* pass applied on top.
 */
export const STORE_RETRIEVAL_POLICY_VERSION = 'store_bm25_reweight_v1' as const;

/** Raised when a re-rank is asked to order an input that cannot be ordered deterministically. */
export class StoreRetrievalPolicyError extends AppError {
  constructor(message: string) {
    super(422, 'MEMORY_STORE_RERANK_INVALID', message);
  }
}

export type DurableStoreClass = Exclude<MemoryStoreClass, 'working'>;

/** (title, content, tags) column weights, mirroring the FTS5 column order. */
export type FtsWeightVector = readonly [title: number, content: number, tags: number];

/** The per-column term-coverage profile a candidate earned, in FTS5 column order. */
export type ColumnMatchVector = readonly [title: number, content: number, tags: number];

/**
 * The subset of an audited retrieval item the re-ranker needs. Typed as a `Pick`
 * of {@link LexicalRetrievalItem} so a real retrieval result can be passed
 * straight through with no adapter and no widening.
 */
export type StoreRerankCandidate = Pick<
  LexicalRetrievalItem,
  'id' | 'kind' | 'title' | 'content' | 'tags' | 'bm25' | 'rank'
>;

export interface StoreRerankInput {
  /** The audited query terms, verbatim from `LexicalSelectionManifest.normalizedTerms`. */
  readonly normalizedTerms: readonly string[];
  /** Candidates produced by the audited retrieval path. Re-ranking never adds to this set. */
  readonly candidates: readonly StoreRerankCandidate[];
}

export interface StoreRankedCandidate {
  readonly fragmentId: MemoryFragmentId;
  readonly kind: MemoryKind;
  readonly storeClass: DurableStoreClass;
  readonly weights: FtsWeightVector;
  readonly columnMatches: ColumnMatchVector;
  /** Integer: sum over columns of weight * distinct-query-token matches. Higher is better. */
  readonly storeScore: number;
  /** SQLite BM25 as returned by the audited path (more negative = better), carried for audit. */
  readonly baseBm25: number;
  /** 1-based rank the audited path assigned before re-ranking. */
  readonly baseRank: number;
  /** 1-based rank after re-ranking. */
  readonly rank: number;
  /** `baseRank - rank`: positive means the store policy promoted this candidate. */
  readonly rankDelta: number;
}

export interface StoreRerankResult {
  readonly policyVersion: typeof STORE_RETRIEVAL_POLICY_VERSION;
  /** The FTS-equivalent tokens the score was computed against, in stable order. */
  readonly queryTokens: readonly string[];
  readonly ranked: readonly StoreRankedCandidate[];
  readonly fingerprint: string;
}

/** The column weights `store-classes.ts` declares for the store this kind routes to. */
export function ftsWeightsForKind(kind: MemoryKind): FtsWeightVector {
  return MEMORY_STORE_POLICIES[storeClassForKind(kind)].ftsWeights;
}

const DIACRITIC_PATTERN = /\p{Diacritic}/gu;
const TOKEN_PATTERN = /[\p{L}\p{N}]+/gu;

/**
 * Tokenizes exactly the way the index does. `memory_fragments_fts` is declared
 * `tokenize = 'unicode61 remove_diacritics 2'`, so it folds diacritics, lowercases,
 * and splits on every non-alphanumeric character — including `_`, which the audited
 * *query* tokenizer keeps inside a term. Folding both sides here means the re-ranker
 * scores against the same tokens SQLite actually matched on; scoring against a
 * different tokenization would silently reorder candidates on a technicality.
 */
export function ftsTokens(text: string): string[] {
  const folded = text.normalize('NFD').replace(DIACRITIC_PATTERN, '').toLocaleLowerCase('en-US');
  return folded.match(TOKEN_PATTERN) ?? [];
}

/** The manifest's query terms re-expanded into index-equivalent tokens, order-stable and unique. */
export function queryTokensFor(normalizedTerms: readonly string[]): string[] {
  const tokens = new Set<string>();
  for (const term of normalizedTerms) {
    for (const token of ftsTokens(term)) {
      tokens.add(token);
    }
  }
  return [...tokens];
}

/** Count of distinct query tokens present in one column. Deterministic and integer-valued. */
function columnCoverage(text: string, queryTokens: ReadonlySet<string>): number {
  const columnTokens = new Set(ftsTokens(text));
  let matched = 0;
  for (const token of queryTokens) {
    if (columnTokens.has(token)) matched += 1;
  }
  return matched;
}

/** Codepoint order, not `localeCompare`: collation must not drift with the host's ICU build. */
function compareFragmentIds(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * Turns the per-store `ftsWeights` declared in `store-classes.ts` into a real,
 * deterministic re-ranking of already-retrieved candidates.
 *
 * WHAT CHANGED VS FLAT RANKING
 * The audited path scores every row with one global vector —
 * `bm25(memory_fragments_fts, 8.0, 1.0, 2.0)` — regardless of what kind of memory
 * the row is. That vector happens to be the *semantic* store's policy, so under
 * flat ranking every store is ranked as if it were a semantic store. An episodic
 * `episode` whose evidence lives in its body is therefore scored as though only
 * its title mattered, and is buried under a semantic item that merely shares a
 * title token. This pass re-scores each candidate with its own store's vector.
 *
 * WHY THE WEIGHTS DIFFER BY STORE
 * Semantic [8,1,2] and procedural [8,2,3] keep the title premium because those
 * stores hold *named* knowledge under a `curated_supersede` / `validated_supersede`
 * write rule: the title is the canonical handle for the thing ("Acme billing
 * contact", "Monthly close"), and a body hit is corroboration rather than identity.
 * Episodic [4,2,2] halves the title premium and doubles body weight because the
 * episodic store is an `append_only_ledger` of concrete events whose titles are
 * often near-duplicates ("Weekly sync") while the discriminating detail is in the
 * body. This is exactly the report's "per-kind storage with per-kind retrieval".
 *
 * WHAT DID NOT CHANGE
 * The audited retrieval path remains the sole source of candidates and the sole
 * authorization gate. This function is pure, takes no database, and can only
 * REORDER what it was handed — it can never introduce a fragment, and it never
 * sees scope, sleeve, or sensitivity. Ties break on (storeScore desc,
 * fragmentId asc), the reproducibility rule the experimental program requires, so
 * two runs over the same candidate set produce byte-identical output.
 */
export function rerankByStorePolicy(input: StoreRerankInput): StoreRerankResult {
  const seen = new Set<string>();
  for (const candidate of input.candidates) {
    if (seen.has(candidate.id)) {
      throw new StoreRetrievalPolicyError(
        `Retrieval candidate '${candidate.id}' appears twice; ranking would be ambiguous`
      );
    }
    seen.add(candidate.id);
  }

  const queryTokens = queryTokensFor(input.normalizedTerms);
  const tokenSet = new Set(queryTokens);

  const scored = input.candidates.map((candidate) => {
    const storeClass = storeClassForKind(candidate.kind);
    const weights = MEMORY_STORE_POLICIES[storeClass].ftsWeights;
    const columnMatches: ColumnMatchVector = [
      columnCoverage(candidate.title, tokenSet),
      columnCoverage(candidate.content, tokenSet),
      // tags_text is the space-joined tag list; join the same way the trigger does.
      columnCoverage(candidate.tags.join(' '), tokenSet)
    ];
    const storeScore =
      weights[0] * columnMatches[0] + weights[1] * columnMatches[1] + weights[2] * columnMatches[2];
    return { candidate, storeClass, weights, columnMatches, storeScore };
  });

  const ordered = scored
    .slice()
    .sort(
      (left, right) =>
        right.storeScore - left.storeScore ||
        compareFragmentIds(left.candidate.id, right.candidate.id)
    );

  const ranked: StoreRankedCandidate[] = ordered.map((entry, index) => ({
    fragmentId: entry.candidate.id,
    kind: entry.candidate.kind,
    storeClass: entry.storeClass,
    weights: entry.weights,
    columnMatches: entry.columnMatches,
    storeScore: entry.storeScore,
    baseBm25: entry.candidate.bm25,
    baseRank: entry.candidate.rank,
    rank: index + 1,
    rankDelta: entry.candidate.rank - (index + 1)
  }));

  const fingerprint = sha256(
    JSON.stringify({
      policyVersion: STORE_RETRIEVAL_POLICY_VERSION,
      queryTokens,
      ranked: ranked.map((entry) => ({
        fragmentId: entry.fragmentId,
        storeScore: entry.storeScore,
        rank: entry.rank
      }))
    })
  );

  return { policyVersion: STORE_RETRIEVAL_POLICY_VERSION, queryTokens, ranked, fingerprint };
}
