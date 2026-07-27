import { createHash } from 'node:crypto';

/**
 * Content anchors replace `file.ts:503` citations. A line number drifts silently whenever
 * anything above it changes; an anchor drifts only when the anchored content itself changes,
 * which is exactly when a citing task should be re-verified.
 *
 * The concrete syntax for both Markdown and source files, plus the placement rules, live in
 * docs/anchors.md. Examples are kept out of this file on purpose: a literal marker written here
 * would be indexed as a real anchor and collide with the documented one.
 *
 * The arity of a lookup is the verdict: exactly one hit resolves, zero means the evidence was
 * deleted, and two or more means the convention was violated and the anchor is worthless.
 *
 * Fenced code blocks in Markdown are skipped so that documenting the convention does not
 * register anchors.
 */

const ANCHOR_MARKER = '@anchor';
const ANCHOR_ID_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z0-9][a-z0-9-]*)+$/;
const MARKDOWN_ANCHOR = /<!--\s*@anchor\s+([^\s>]+)\s*-->/;
const SOURCE_ANCHOR = /(?:\/\/|#|\*)\s*@anchor\s+(\S+)\s*(?:[-–—]\s*(.*))?$/;
const MAX_SENTENCE_LENGTH = 500;

export interface CodeAnchor {
  id: string;
  path: string;
  line: number;
  sentence: string;
  digest: string;
}

export type AnchorResolution =
  | { status: 'resolved'; anchor: CodeAnchor }
  | { status: 'missing'; id: string }
  | { status: 'ambiguous'; id: string; occurrences: Array<{ path: string; line: number }> };

export interface AnchorScanIssue {
  kind: 'invalid_id' | 'empty_sentence' | 'sentence_too_long';
  id: string;
  path: string;
  line: number;
}

export interface AnchorIndex {
  anchors: Map<string, CodeAnchor[]>;
  issues: AnchorScanIssue[];
}

export function isValidAnchorId(id: string): boolean {
  return ANCHOR_ID_PATTERN.test(id);
}

/**
 * Normalizes before hashing so that reflowing or re-indenting a sentence does not read as a
 * meaning change. Only the words matter.
 */
export function anchorDigest(sentence: string): string {
  const normalized = sentence.trim().replace(/\s+/g, ' ').toLowerCase();
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

function markdownSentence(lines: readonly string[], markerIndex: number): string {
  for (let index = markerIndex + 1; index < lines.length; index += 1) {
    const candidate = (lines[index] ?? '').trim();
    if (candidate.length > 0) return candidate;
  }
  return '';
}

export function scanFileForAnchors(
  path: string,
  contents: string
): {
  anchors: CodeAnchor[];
  issues: AnchorScanIssue[];
} {
  const anchors: CodeAnchor[] = [];
  const issues: AnchorScanIssue[] = [];
  if (!contents.includes(ANCHOR_MARKER)) return { anchors, issues };

  const lines = contents.split(/\r?\n/);
  let insideFence = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (/^\s*(?:```|~~~)/.test(line)) {
      insideFence = !insideFence;
      continue;
    }
    // Documenting the convention must not create anchors, so fenced examples never register.
    if (insideFence) continue;
    if (!line.includes(ANCHOR_MARKER)) continue;

    const markdownMatch = MARKDOWN_ANCHOR.exec(line);
    const sourceMatch = markdownMatch === null ? SOURCE_ANCHOR.exec(line) : null;
    if (markdownMatch === null && sourceMatch === null) continue;

    const id = (markdownMatch?.[1] ?? sourceMatch?.[1] ?? '').trim();
    const sentence =
      markdownMatch !== null ? markdownSentence(lines, index) : (sourceMatch?.[2] ?? '').trim();
    const lineNumber = index + 1;

    if (!isValidAnchorId(id)) {
      issues.push({ kind: 'invalid_id', id, path, line: lineNumber });
      continue;
    }
    if (sentence.length === 0) {
      issues.push({ kind: 'empty_sentence', id, path, line: lineNumber });
      continue;
    }
    if (sentence.length > MAX_SENTENCE_LENGTH) {
      issues.push({ kind: 'sentence_too_long', id, path, line: lineNumber });
      continue;
    }

    anchors.push({ id, path, line: lineNumber, sentence, digest: anchorDigest(sentence) });
  }

  return { anchors, issues };
}

export function buildAnchorIndex(
  files: ReadonlyArray<{ path: string; contents: string }>
): AnchorIndex {
  const anchors = new Map<string, CodeAnchor[]>();
  const issues: AnchorScanIssue[] = [];

  for (const file of files) {
    const scanned = scanFileForAnchors(file.path, file.contents);
    issues.push(...scanned.issues);
    for (const anchor of scanned.anchors) {
      const existing = anchors.get(anchor.id);
      if (existing === undefined) anchors.set(anchor.id, [anchor]);
      else existing.push(anchor);
    }
  }

  return { anchors, issues };
}

export function resolveAnchor(index: AnchorIndex, id: string): AnchorResolution {
  const found = index.anchors.get(id);
  if (found === undefined || found.length === 0) return { status: 'missing', id };
  if (found.length > 1) {
    return {
      status: 'ambiguous',
      id,
      occurrences: found.map((anchor) => ({ path: anchor.path, line: anchor.line }))
    };
  }
  const [anchor] = found;
  if (anchor === undefined) return { status: 'missing', id };
  return { status: 'resolved', anchor };
}

export function duplicateAnchorIds(index: AnchorIndex): string[] {
  return [...index.anchors.entries()]
    .filter(([, occurrences]) => occurrences.length > 1)
    .map(([id]) => id)
    .sort();
}
