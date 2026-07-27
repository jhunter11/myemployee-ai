import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildAnchorIndex, type AnchorIndex } from '../../src/knowledge/anchors';
import { collectIndexableFiles } from '../../src/knowledge/code-index';
import {
  classifyAcceptance,
  extractCitations,
  inferCandidateLinks,
  verifyTask,
  type TaskVerification
} from '../../src/queue/task-verifier';
import { WorkIndexManifestSchema } from '../../src/queue/work-index-seed';

const PROJECT_ROOT = resolve(__dirname, '..', '..');

async function repositoryAnchorIndex(): Promise<AnchorIndex> {
  const paths = await collectIndexableFiles(PROJECT_ROOT);
  const files = await Promise.all(
    paths.map(async (path) => ({
      path,
      contents: await readFile(join(PROJECT_ROOT, path), 'utf8')
    }))
  );
  return buildAnchorIndex(files);
}

const emptyIndex = buildAnchorIndex([]);

describe('extractCitations', () => {
  it('finds path:line references', () => {
    const citations = extractCitations('see src/task-market/x402-runtime.ts:503 for the cast');

    expect(citations).toHaveLength(1);
    expect(citations[0]).toMatchObject({
      kind: 'path_line',
      path: 'src/task-market/x402-runtime.ts',
      line: 503
    });
  });

  it('finds anchor references', () => {
    const citations = extractCitations('described at anchor:tm.mcp.batch-surface');

    expect(citations).toHaveLength(1);
    expect(citations[0]).toMatchObject({ kind: 'anchor', reference: 'tm.mcp.batch-surface' });
  });
});

describe('classifyAcceptance', () => {
  it('recognises acceptance that can be settled by running a known script', () => {
    expect(classifyAcceptance('npm run lint exits 0')).toEqual({
      kind: 'executable',
      command: 'npm run lint'
    });
  });

  it('treats judgement-shaped acceptance as prose', () => {
    expect(
      classifyAcceptance('Every rung has a security argument that stands on its own.')
    ).toEqual({ kind: 'prose', command: null });
  });

  it('reports absent acceptance', () => {
    expect(classifyAcceptance(undefined).kind).toBe('absent');
  });
});

describe('verifyTask', () => {
  it('verifies a real citation in this repository', async () => {
    const verification = await verifyTask(
      { id: 't1', evidence: 'src/knowledge/anchors.ts:1', acceptance: 'npm run lint exits 0' },
      PROJECT_ROOT,
      emptyIndex
    );

    expect(verification.verdict).toBe('verified');
    expect(verification.acceptanceKind).toBe('executable');
    expect(verification.citedPaths).toEqual(['src/knowledge/anchors.ts']);
    expect(verification.evidenceDigest).not.toBeNull();
  });

  it('reports a citation to a file that does not exist as unresolvable', async () => {
    const verification = await verifyTask(
      { id: 't2', evidence: 'src/does/not/exist.ts:12' },
      PROJECT_ROOT,
      emptyIndex
    );

    expect(verification.verdict).toBe('unresolvable_evidence');
  });

  it('reports a line beyond end of file as stale rather than verified', async () => {
    const verification = await verifyTask(
      { id: 't3', evidence: 'src/knowledge/anchors.ts:999999' },
      PROJECT_ROOT,
      emptyIndex
    );

    expect(verification.verdict).toBe('stale_evidence');
  });

  it('warns that a line-number citation is weaker than an anchor', async () => {
    const verification = await verifyTask(
      { id: 't4', evidence: 'src/knowledge/anchors.ts:1' },
      PROJECT_ROOT,
      emptyIndex
    );

    expect(verification.reasons.join(' ')).toMatch(/prefer an anchor/);
  });

  it('reports a task with no citation as no_evidence', async () => {
    const verification = await verifyTask(
      { id: 't5', evidence: 'this is prose with no citation' },
      PROJECT_ROOT,
      emptyIndex
    );

    expect(verification.verdict).toBe('no_evidence');
  });

  it('reports an ambiguous anchor as ambiguous_evidence', async () => {
    // Built at runtime: a literal marker in this file would register as a real repository
    // anchor and fail the hygiene test in tests/knowledge/anchors.test.ts.
    const marker = `@${'anchor'}`;
    const ambiguous = buildAnchorIndex([
      { path: 'a.ts', contents: `// ${marker} tm.dup.here - first` },
      { path: 'b.ts', contents: `// ${marker} tm.dup.here - second` }
    ]);
    const verification = await verifyTask(
      { id: 't6', evidence: 'see anchor:tm.dup.here' },
      PROJECT_ROOT,
      ambiguous
    );

    expect(verification.verdict).toBe('ambiguous_evidence');
  });
});

describe('inferCandidateLinks', () => {
  const base: Omit<TaskVerification, 'taskId' | 'citedPaths'> = {
    verdict: 'verified',
    evidenceDigest: 'd',
    citations: [],
    acceptanceKind: 'prose',
    acceptanceCommand: null,
    estimatedEffortLines: 0,
    reasons: []
  };

  it('links tasks that cite the same file', () => {
    const links = inferCandidateLinks(
      [
        { ...base, taskId: 'a', citedPaths: ['src/x.ts'] },
        { ...base, taskId: 'b', citedPaths: ['src/x.ts'] }
      ],
      () => []
    );

    expect(links).toEqual([{ taskId: 'a', linkedTaskId: 'b', reason: 'shared_file' }]);
  });

  it('links tasks connected through the import graph', () => {
    const links = inferCandidateLinks(
      [
        { ...base, taskId: 'a', citedPaths: ['src/leaf.ts'] },
        { ...base, taskId: 'b', citedPaths: ['src/importer.ts'] }
      ],
      (path) => (path === 'src/leaf.ts' ? ['src/importer.ts'] : [])
    );

    expect(links).toEqual([{ taskId: 'a', linkedTaskId: 'b', reason: 'import_reachable' }]);
  });

  it('does not link tasks that share nothing structural', () => {
    const links = inferCandidateLinks(
      [
        { ...base, taskId: 'a', citedPaths: ['src/x.ts'] },
        { ...base, taskId: 'b', citedPaths: ['src/y.ts'] }
      ],
      () => []
    );

    expect(links).toEqual([]);
  });
});

describe('the checked-in work index', () => {
  it('every task with evidence resolves against the repository', async () => {
    const manifest = WorkIndexManifestSchema.parse(
      JSON.parse(await readFile(join(PROJECT_ROOT, 'docs/work-index.json'), 'utf8'))
    );
    const anchorIndex = await repositoryAnchorIndex();

    const verifications = await Promise.all(
      manifest.tasks.map((task) =>
        verifyTask(
          { id: task.id, evidence: task.evidence, acceptance: task.acceptance },
          PROJECT_ROOT,
          anchorIndex
        )
      )
    );

    const broken = verifications.filter(
      (verification) =>
        verification.verdict === 'unresolvable_evidence' ||
        verification.verdict === 'ambiguous_evidence'
    );

    expect(broken.map((verification) => verification.taskId)).toEqual([]);
  });
});
