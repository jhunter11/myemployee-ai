import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AgentRun } from '../../src/config/schemas';
import { MarkdownGraph } from '../../src/memory/markdown-graph';

const now = '2026-07-18T12:00:00.000Z';

function completedRun(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: 'run-001',
    clientId: 'acme_corp',
    automation: 'daily-report',
    status: 'succeeded',
    input: { privateLead: 'lead@example.com' },
    output: { qualifiedCount: 4 },
    errorMessage: null,
    parentRunId: null,
    workerId: 'acme_daily_report',
    startedAt: now,
    completedAt: now,
    ...overrides
  };
}

describe('Markdown run memory', () => {
  let temporaryRoot: string;
  let graphRoot: string;
  let clientDirectory: string;
  let graph: MarkdownGraph;

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'jarvis-run-memory-'));
    graphRoot = join(temporaryRoot, 'memory', 'graph');
    clientDirectory = join(temporaryRoot, 'clients', 'acme_corp');
    graph = new MarkdownGraph({
      graphRoot,
      clientRoot: join(temporaryRoot, 'clients'),
      now: () => now
    });
    await graph.createClientNode({
      id: 'acme_corp',
      name: 'Acme Corporation',
      profile: 'data_processing',
      createdAt: now,
      clientDirectory
    });
  });

  afterEach(async () => {
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  it('records linked global metadata and a tenant-private success note', async () => {
    await graph.recordRun({ run: completedRun(), clientDirectory });
    const index = await graph.rebuild();

    const globalNote = await readFile(join(graphRoot, 'runs', 'run-001.md'), 'utf8');
    const privateNote = await readFile(
      join(clientDirectory, 'memory', 'notes', 'runs', 'run-001.md'),
      'utf8'
    );
    expect(globalNote).toContain('[[clients/acme_corp]]');
    expect(globalNote).toContain('[[automations/acme_corp/daily-report]]');
    expect(globalNote).toContain('Status: `succeeded`');
    expect(globalNote).not.toContain('lead@example.com');
    expect(globalNote).not.toContain('qualifiedCount');
    expect(privateNote).toContain('Status: `succeeded`');
    expect(privateNote).not.toContain('lead@example.com');
    expect(await readFile(join(clientDirectory, 'memory', 'notes', 'index.md'), 'utf8')).toContain(
      '[[runs/run-001]]'
    );
    expect(index.edges).toEqual(
      expect.arrayContaining([
        { from: 'runs/run-001', to: 'clients/acme_corp' },
        { from: 'runs/run-001', to: 'automations/acme_corp/daily-report' },
        { from: 'automations/acme_corp/daily-report', to: 'clients/acme_corp' }
      ])
    );
  });

  it('records failed status without leaking the error or payload', async () => {
    const run = completedRun({
      id: 'run-002',
      status: 'failed',
      output: null,
      errorMessage: 'Sensitive failure for lead@example.com'
    });

    await graph.recordRun({ run, clientDirectory });

    const globalNote = await readFile(join(graphRoot, 'runs', 'run-002.md'), 'utf8');
    const privateNote = await readFile(
      join(clientDirectory, 'memory', 'notes', 'runs', 'run-002.md'),
      'utf8'
    );
    expect(globalNote).toContain('Status: `failed`');
    expect(globalNote).not.toContain('Sensitive failure');
    expect(privateNote).toContain('Status: `failed`');
    expect(privateNote).not.toContain('lead@example.com');
  });

  it('rejects a path-unsafe run id before writing a run note', async () => {
    await expect(
      graph.recordRun({ run: completedRun({ id: '../escape' }), clientDirectory })
    ).rejects.toBeDefined();

    await expect(stat(join(graphRoot, 'escape.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a run/private-directory tenant mismatch before writing any run note', async () => {
    const otherDirectory = join(temporaryRoot, 'clients', 'other_client');
    await graph.createClientNode({
      id: 'other_client',
      name: 'Other Client',
      profile: 'data_processing',
      createdAt: now,
      clientDirectory: otherDirectory
    });

    await expect(
      graph.recordRun({ run: completedRun(), clientDirectory: otherDirectory })
    ).rejects.toMatchObject({ code: 'TENANT_MEMORY_MISMATCH', statusCode: 400 });

    await expect(
      stat(join(otherDirectory, 'memory', 'notes', 'runs', 'run-001.md'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(join(graphRoot, 'runs', 'run-001.md'))).rejects.toMatchObject({
      code: 'ENOENT'
    });
  });

  it('updates a repeated run without duplicating index links', async () => {
    const run = completedRun();
    await graph.recordRun({ run, clientDirectory });
    await graph.recordRun({ run, clientDirectory });

    const runIndex = await readFile(join(graphRoot, 'runs', 'index.md'), 'utf8');
    const privateIndex = await readFile(
      join(clientDirectory, 'memory', 'notes', 'index.md'),
      'utf8'
    );
    expect(runIndex.match(/\[\[runs\/run-001\]\]/g)).toHaveLength(1);
    expect(privateIndex.match(/\[\[runs\/run-001\]\]/g)).toHaveLength(1);
  });
});
