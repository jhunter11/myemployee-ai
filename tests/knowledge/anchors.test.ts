import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  anchorDigest,
  buildAnchorIndex,
  duplicateAnchorIds,
  isValidAnchorId,
  resolveAnchor,
  scanFileForAnchors
} from '../../src/knowledge/anchors';
import { collectIndexableFiles } from '../../src/knowledge/code-index';

const PROJECT_ROOT = resolve(__dirname, '..', '..');

const MARKER = '@anchor';
const markdownAnchor = (id: string): string => `<!-- ${MARKER} ${id} -->`;
const sourceAnchor = (id: string, sentence: string): string => `// ${MARKER} ${id} - ${sentence}`;

describe('anchor ids', () => {
  it('accepts dotted lowercase namespaces and rejects malformed ids', () => {
    expect(isValidAnchorId('tm.mcp.batch-surface')).toBe(true);
    expect(isValidAnchorId('ag.ci.data-model')).toBe(true);
    expect(isValidAnchorId('nodots')).toBe(false);
    expect(isValidAnchorId('Tm.Upper.Case')).toBe(false);
    expect(isValidAnchorId('tm..empty')).toBe(false);
  });
});

describe('anchor digests', () => {
  it('ignores reflowing and indentation but not wording', () => {
    expect(anchorDigest('The endpoint accepts arrays.')).toBe(
      anchorDigest('   The   endpoint\n accepts arrays.  ')
    );
    expect(anchorDigest('The endpoint accepts arrays.')).not.toBe(
      anchorDigest('The endpoint rejects arrays.')
    );
  });
});

describe('scanFileForAnchors', () => {
  it('reads the following non-empty line as the markdown sentence', () => {
    const contents = [markdownAnchor('tm.example.one'), '', 'The anchored claim.'].join('\n');
    const { anchors } = scanFileForAnchors('docs/x.md', contents);

    const [anchor] = anchors;
    if (anchor === undefined) throw new Error('expected one anchor');
    expect(anchors).toHaveLength(1);
    expect(anchor.sentence).toBe('The anchored claim.');
    expect(anchor.line).toBe(1);
  });

  it('reads the trailing sentence as the source sentence', () => {
    const contents = sourceAnchor('tm.example.two', 'the transport fans out per element');
    const { anchors } = scanFileForAnchors('src/x.ts', contents);

    const [anchor] = anchors;
    if (anchor === undefined) throw new Error('expected one anchor');
    expect(anchors).toHaveLength(1);
    expect(anchor.sentence).toBe('the transport fans out per element');
  });

  it('skips fenced code blocks so documenting the convention creates no anchors', () => {
    const contents = [
      '```markdown',
      markdownAnchor('tm.example.fenced'),
      'A documented example.',
      '```'
    ].join('\n');

    expect(scanFileForAnchors('docs/anchors.md', contents).anchors).toHaveLength(0);
  });

  it('reports malformed ids and empty sentences as issues rather than anchors', () => {
    const contents = [sourceAnchor('NotValid', 'x'), sourceAnchor('tm.example.three', '')].join(
      '\n'
    );
    const { anchors, issues } = scanFileForAnchors('src/x.ts', contents);

    expect(anchors).toHaveLength(0);
    expect(issues.map((issue) => issue.kind)).toEqual(['invalid_id', 'empty_sentence']);
  });
});

describe('resolveAnchor arity rule', () => {
  const index = buildAnchorIndex([
    { path: 'a.ts', contents: sourceAnchor('tm.example.unique', 'only here') },
    { path: 'b.ts', contents: sourceAnchor('tm.example.twice', 'first') },
    { path: 'c.ts', contents: sourceAnchor('tm.example.twice', 'second') }
  ]);

  it('resolves an anchor that appears exactly once', () => {
    const resolution = resolveAnchor(index, 'tm.example.unique');
    expect(resolution.status).toBe('resolved');
  });

  it('reports a deleted anchor as missing', () => {
    expect(resolveAnchor(index, 'tm.example.gone').status).toBe('missing');
  });

  it('reports a repeated anchor as ambiguous with every occurrence', () => {
    const resolution = resolveAnchor(index, 'tm.example.twice');
    expect(resolution.status).toBe('ambiguous');
    if (resolution.status !== 'ambiguous') throw new Error('expected ambiguous');
    expect(resolution.occurrences.map((occurrence) => occurrence.path)).toEqual(['b.ts', 'c.ts']);
  });
});

describe('repository anchor hygiene', () => {
  it('contains no ambiguous or malformed anchors', async () => {
    const paths = await collectIndexableFiles(PROJECT_ROOT);
    const files = await Promise.all(
      paths.map(async (path) => ({
        path,
        contents: await readFile(join(PROJECT_ROOT, path), 'utf8')
      }))
    );
    const index = buildAnchorIndex(files);

    expect(duplicateAnchorIds(index)).toEqual([]);
    expect(index.issues).toEqual([]);
  });
});
