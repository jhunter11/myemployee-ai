import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runGraphCli } from '../../src/memory/graph-cli';

const execFileAsync = promisify(execFile);
const projectRoot = join(__dirname, '..', '..');

describe('memory graph CLI', () => {
  let temporaryRoot: string;

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'jarvis-graph-cli-'));
  });

  afterEach(async () => {
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  it('initializes, validates, and reports a headless Markdown graph', async () => {
    const output: string[] = [];
    const graphRoot = join(temporaryRoot, 'memory', 'graph');

    const index = await runGraphCli({
      graphRoot,
      now: () => '2026-07-18T12:00:00.000Z',
      write: (message) => output.push(message)
    });

    expect(index.nodes).toHaveLength(3);
    expect(index.edges).toHaveLength(4);
    expect(output).toEqual([
      JSON.stringify({
        event: 'memory_graph_rebuilt',
        graphRoot,
        nodes: 3,
        edges: 4
      })
    ]);
    expect(JSON.parse(await readFile(join(graphRoot, 'graph.json'), 'utf8'))).toEqual(index);
  });

  it('exits non-zero when a wiki-link is broken', async () => {
    const graphRoot = join(temporaryRoot, 'memory', 'graph');
    await runGraphCli({ graphRoot, write: () => undefined });
    await writeFile(
      join(graphRoot, 'broken.md'),
      [
        '---',
        'id: "broken"',
        'type: "test"',
        'title: "Broken"',
        'created_at: "2026-07-18T12:00:00.000Z"',
        'updated_at: "2026-07-18T12:00:00.000Z"',
        'tags: ["test"]',
        '---',
        '',
        '[[missing/node]]',
        ''
      ].join('\n')
    );

    let exitCode: unknown;
    try {
      await execFileAsync(
        process.execPath,
        [
          join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
          join(projectRoot, 'src', 'memory', 'graph-cli.ts')
        ],
        {
          cwd: projectRoot,
          env: { ...process.env, JARVIS_GRAPH_ROOT: graphRoot }
        }
      );
    } catch (error) {
      exitCode = (error as { code?: unknown }).code;
    }

    expect(exitCode).toBe(1);
  });
});
