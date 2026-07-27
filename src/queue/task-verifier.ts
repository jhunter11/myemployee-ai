import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { resolveAnchor, type AnchorIndex } from '../knowledge/anchors';

/**
 * Tier-0 task verification: everything decidable without a model call.
 *
 * The ordering is the whole point. A model is expensive and an fs.stat is free, so every check
 * that can be settled deterministically runs first and only the semantic residue is ever worth
 * spending tokens on. Per src/economics/model-router.ts this is the
 * DETERMINISTIC_IMPLEMENTATION_AVAILABLE tier, which AGENTS.md requires be preferred.
 */

/**
 * The extension allowlist is load-bearing, not cosmetic: `192.168.5.2:3000` is structurally
 * identical to `path/file.ts:503`, so without it an IP and port parses as a citation.
 */
const CITABLE_EXTENSIONS =
  'ts|tsx|js|mjs|cjs|json|md|sh|yaml|yml|conf|sql|sqlite|toml|plist|html|css';
const CITATION_PATTERN = new RegExp(
  `\\b([A-Za-z0-9_./-]+\\.(?:${CITABLE_EXTENSIONS})):(\\d+)\\b`,
  'g'
);
const ANCHOR_CITATION_PATTERN = /\banchor:([a-z][a-z0-9]*(?:\.[a-z0-9][a-z0-9-]*)+)\b/g;

/**
 * Acceptance criteria that name one of these scripts can be settled by running it. Anything else
 * is prose and needs judgement. This is an allowlist rather than a parser on purpose: executing
 * arbitrary strings lifted from a manifest would make the manifest a code-execution channel.
 */
const EXECUTABLE_ACCEPTANCE = new Map<RegExp, string>([
  [/npm run lint\b.*\bexits? 0\b/i, 'npm run lint'],
  [/npm run typecheck\b/i, 'npm run typecheck'],
  [/npm run format:check\b/i, 'npm run format:check'],
  [/npm run build\b/i, 'npm run build'],
  [/npm test\b/i, 'npm test'],
  [/git status is clean for ([A-Za-z0-9_./-]+)/i, 'git status --porcelain']
]);

export type TaskVerdict =
  'verified' | 'stale_evidence' | 'unresolvable_evidence' | 'no_evidence' | 'ambiguous_evidence';

export interface ResolvedCitation {
  kind: 'anchor' | 'path_line';
  reference: string;
  path: string;
  line: number | null;
  digest: string;
  status: 'resolved' | 'missing' | 'ambiguous' | 'line_out_of_range';
}

export interface TaskVerification {
  taskId: string;
  verdict: TaskVerdict;
  evidenceDigest: string | null;
  citations: ResolvedCitation[];
  acceptanceKind: 'executable' | 'prose' | 'absent';
  acceptanceCommand: string | null;
  estimatedEffortLines: number;
  citedPaths: string[];
  reasons: string[];
}

export interface VerifiableTask {
  id: string;
  evidence?: string;
  acceptance?: string;
}

export function extractCitations(
  evidence: string
): Array<{ kind: 'anchor' | 'path_line'; reference: string; path: string; line: number | null }> {
  const citations: Array<{
    kind: 'anchor' | 'path_line';
    reference: string;
    path: string;
    line: number | null;
  }> = [];

  for (const match of evidence.matchAll(ANCHOR_CITATION_PATTERN)) {
    const reference = match[1];
    if (reference === undefined) continue;
    citations.push({ kind: 'anchor', reference, path: '', line: null });
  }
  for (const match of evidence.matchAll(CITATION_PATTERN)) {
    const path = match[1];
    const line = match[2];
    if (path === undefined || line === undefined) continue;
    citations.push({
      kind: 'path_line',
      reference: match[0],
      path,
      line: Number.parseInt(line, 10)
    });
  }
  return citations;
}

export function classifyAcceptance(acceptance: string | undefined): {
  kind: 'executable' | 'prose' | 'absent';
  command: string | null;
} {
  if (acceptance === undefined || acceptance.trim().length === 0) {
    return { kind: 'absent', command: null };
  }
  for (const [pattern, command] of EXECUTABLE_ACCEPTANCE) {
    if (pattern.test(acceptance)) return { kind: 'executable', command };
  }
  return { kind: 'prose', command: null };
}

async function fileExists(absolute: string): Promise<boolean> {
  try {
    await access(absolute);
    return true;
  } catch {
    return false;
  }
}

export async function verifyTask(
  task: VerifiableTask,
  repositoryRoot: string,
  anchorIndex: AnchorIndex
): Promise<TaskVerification> {
  const acceptance = classifyAcceptance(task.acceptance);
  const reasons: string[] = [];
  const citations: ResolvedCitation[] = [];
  let estimatedEffortLines = 0;

  const extracted = task.evidence === undefined ? [] : extractCitations(task.evidence);

  for (const citation of extracted) {
    if (citation.kind === 'anchor') {
      const resolution = resolveAnchor(anchorIndex, citation.reference);
      if (resolution.status === 'resolved') {
        citations.push({
          kind: 'anchor',
          reference: citation.reference,
          path: resolution.anchor.path,
          line: resolution.anchor.line,
          digest: resolution.anchor.digest,
          status: 'resolved'
        });
      } else {
        citations.push({
          kind: 'anchor',
          reference: citation.reference,
          path: '',
          line: null,
          digest: '',
          status: resolution.status === 'missing' ? 'missing' : 'ambiguous'
        });
        reasons.push(`anchor ${citation.reference} is ${resolution.status}`);
      }
      continue;
    }

    const absolute = join(repositoryRoot, citation.path);
    if (!(await fileExists(absolute))) {
      citations.push({
        kind: 'path_line',
        reference: citation.reference,
        path: citation.path,
        line: citation.line,
        digest: '',
        status: 'missing'
      });
      reasons.push(`cited path ${citation.path} does not exist`);
      continue;
    }

    const contents = await readFile(absolute, 'utf8');
    const lines = contents.split(/\r?\n/);
    estimatedEffortLines += lines.length;

    if (citation.line !== null && citation.line > lines.length) {
      citations.push({
        kind: 'path_line',
        reference: citation.reference,
        path: citation.path,
        line: citation.line,
        digest: '',
        status: 'line_out_of_range'
      });
      reasons.push(`cited line ${citation.line} exceeds ${citation.path} length ${lines.length}`);
      continue;
    }

    const cited = (citation.line === null ? contents : lines[citation.line - 1]) ?? '';
    citations.push({
      kind: 'path_line',
      reference: citation.reference,
      path: citation.path,
      line: citation.line,
      digest: createHash('sha256').update(cited.trim(), 'utf8').digest('hex'),
      status: 'resolved'
    });
    // A line-number citation cannot distinguish "still correct" from "silently shifted", so it
    // never earns the same confidence as an anchor.
    reasons.push(`citation ${citation.reference} uses a line number; prefer an anchor`);
  }

  const verdict = decideVerdict(extracted.length, citations);
  const evidenceDigest =
    citations.length === 0
      ? null
      : createHash('sha256')
          .update(
            citations
              .map((citation) => `${citation.reference}:${citation.digest}`)
              .sort()
              .join('|'),
            'utf8'
          )
          .digest('hex');

  return {
    taskId: task.id,
    verdict,
    evidenceDigest,
    citations,
    acceptanceKind: acceptance.kind,
    acceptanceCommand: acceptance.command,
    estimatedEffortLines,
    citedPaths: [...new Set(citations.map((citation) => citation.path).filter(Boolean))].sort(),
    reasons
  };
}

function decideVerdict(
  extractedCount: number,
  citations: readonly ResolvedCitation[]
): TaskVerdict {
  if (extractedCount === 0) return 'no_evidence';
  if (citations.some((citation) => citation.status === 'ambiguous')) return 'ambiguous_evidence';
  if (citations.some((citation) => citation.status === 'missing')) return 'unresolvable_evidence';
  if (citations.some((citation) => citation.status === 'line_out_of_range')) {
    return 'stale_evidence';
  }
  return 'verified';
}

/**
 * Structural link inference. Two tasks are candidate-linked when they cite overlapping files, or
 * when one cites a file that transitively imports a file the other cites. This replaces most of
 * what would otherwise be a model call; only conceptual coupling between components that share
 * no files still needs judgement.
 */
export function inferCandidateLinks(
  verifications: readonly TaskVerification[],
  blastRadius: (path: string) => string[]
): Array<{ taskId: string; linkedTaskId: string; reason: 'shared_file' | 'import_reachable' }> {
  const links: Array<{
    taskId: string;
    linkedTaskId: string;
    reason: 'shared_file' | 'import_reachable';
  }> = [];

  for (let left = 0; left < verifications.length; left += 1) {
    for (let right = left + 1; right < verifications.length; right += 1) {
      const a = verifications[left];
      const b = verifications[right];
      if (a === undefined || b === undefined) continue;
      const bPaths = new Set(b.citedPaths);

      if (a.citedPaths.some((path) => bPaths.has(path))) {
        links.push({ taskId: a.taskId, linkedTaskId: b.taskId, reason: 'shared_file' });
        continue;
      }
      const reachable = new Set(a.citedPaths.flatMap((path) => blastRadius(path)));
      if (b.citedPaths.some((path) => reachable.has(path))) {
        links.push({ taskId: a.taskId, linkedTaskId: b.taskId, reason: 'import_reachable' });
      }
    }
  }

  return links;
}
