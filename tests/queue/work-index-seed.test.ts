import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  WorkIndexManifestSchema,
  orderByDependencies,
  seedWorkIndex,
  toQueueTaskInput,
  type WorkIndexManifest,
  type WorkIndexTask
} from '../../src/queue/work-index-seed';

const PROJECT_ROOT = resolve(__dirname, '..', '..');

async function loadCheckedInManifest(): Promise<WorkIndexManifest> {
  const raw = await readFile(resolve(PROJECT_ROOT, 'docs/work-index.json'), 'utf8');
  return WorkIndexManifestSchema.parse(JSON.parse(raw));
}

function manifestWith(tasks: readonly WorkIndexTask[]): WorkIndexManifest {
  return {
    schemaVersion: 1,
    description: 'test manifest',
    generatedAt: '2026-07-21T00:00:00.000Z',
    tenantId: 'jarvis',
    conventions: {},
    tasks: [...tasks]
  };
}

function projectTask(id: string, dependencies: string[] = []): WorkIndexTask {
  return {
    kind: 'project_task',
    id,
    lane: 'task_market',
    taskType: 'build',
    title: `title ${id}`,
    summary: `summary ${id}`,
    policy: { band: 'P2', impact: 5, urgency: 5, effort: 5 },
    dependencies
  };
}

describe('work index manifest', () => {
  it('the checked-in manifest is valid and covers both commercial lanes', async () => {
    const manifest = await loadCheckedInManifest();
    const lanes = new Set(manifest.tasks.map((task) => task.lane));

    expect(manifest.tenantId).toBe('jarvis');
    expect(lanes).toEqual(new Set(['agency', 'task_market']));
    expect(manifest.tasks.length).toBeGreaterThan(0);
  });

  it('rejects a dependency that names an unknown task', () => {
    const manifest = manifestWith([projectTask('alpha', ['does-not-exist'])]);
    expect(() => WorkIndexManifestSchema.parse(manifest)).toThrow();
  });

  it('rejects duplicate task ids', () => {
    const manifest = manifestWith([projectTask('alpha'), projectTask('alpha')]);
    expect(() => WorkIndexManifestSchema.parse(manifest)).toThrow();
  });
});

describe('toQueueTaskInput', () => {
  it('routes prose into the manifest reference and never into the queue payload', async () => {
    const manifest = await loadCheckedInManifest();
    const task = manifest.tasks.find((candidate) => candidate.kind === 'project_task');
    if (task === undefined) throw new Error('expected at least one project_task');

    const input = toQueueTaskInput(task, manifest);
    const serialized = JSON.stringify(input);

    expect(input.payload.kind).toBe('project_task');
    expect(serialized).not.toContain(task.title);
    expect(serialized).not.toContain(task.summary);
    expect(serialized).toContain(`work-index:${task.id}`);
  });

  it('maps an operator gate to the operator_gate payload kind so workers cannot claim it', async () => {
    const manifest = await loadCheckedInManifest();
    const gate = manifest.tasks.find((candidate) => candidate.kind === 'operator_gate');
    if (gate === undefined) throw new Error('expected at least one operator_gate');

    const input = toQueueTaskInput(gate, manifest);

    expect(input.payload.kind).toBe('operator_gate');
  });

  it('every checked-in task maps to a valid queue input', async () => {
    const manifest = await loadCheckedInManifest();
    for (const task of manifest.tasks) {
      expect(() => toQueueTaskInput(task, manifest)).not.toThrow();
    }
  });
});

describe('orderByDependencies', () => {
  it('places a dependency before the task that requires it', () => {
    const ordered = orderByDependencies([projectTask('second', ['first']), projectTask('first')]);

    expect(ordered.map((task) => task.id)).toEqual(['first', 'second']);
  });

  it('orders the checked-in manifest so no task precedes its dependency', async () => {
    const manifest = await loadCheckedInManifest();
    const ordered = orderByDependencies(manifest.tasks);
    const seen = new Set<string>();

    for (const task of ordered) {
      for (const dependency of task.dependencies) {
        expect(seen.has(dependency)).toBe(true);
      }
      seen.add(task.id);
    }

    expect(ordered).toHaveLength(manifest.tasks.length);
  });

  it('throws on a dependency cycle rather than dropping work', () => {
    const cyclic = [projectTask('alpha', ['beta']), projectTask('beta', ['alpha'])];
    expect(() => orderByDependencies(cyclic)).toThrow(/cycle/i);
  });
});

describe('seedWorkIndex', () => {
  let temporaryRoot: string;

  function operatorGate(id: string, lane = 'agency'): WorkIndexTask {
    return {
      kind: 'operator_gate',
      id,
      lane,
      gateType: 'approval',
      title: `gate ${id}`,
      summary: `gate summary ${id}`,
      policy: { band: 'P0', impact: 9, urgency: 9, effort: 1 },
      dependencies: []
    };
  }

  async function writeManifest(manifest: WorkIndexManifest): Promise<string> {
    const manifestPath = join(temporaryRoot, 'work-index.json');
    await writeFile(manifestPath, JSON.stringify(manifest), 'utf8');
    return manifestPath;
  }

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'jarvis-work-index-seed-test-'));
  });

  afterEach(async () => {
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  it('plans without applying and reports lane and band totals', async () => {
    const manifestPath = await writeManifest(
      manifestWith([projectTask('alpha'), projectTask('beta', ['alpha']), operatorGate('gate-one')])
    );

    const result = await seedWorkIndex({
      projectRoot: PROJECT_ROOT,
      manifestPath,
      databaseFile: join(temporaryRoot, 'planned.sqlite'),
      apply: false
    });

    expect(result).toMatchObject({
      status: 'planned',
      tenantId: 'jarvis',
      taskCount: 3,
      submittedCount: 0,
      skippedExistingCount: 0,
      bands: { P2: 2, P0: 1 }
    });
    expect(result.lanes).toEqual([
      { lane: 'agency', projectTasks: 0, operatorGates: 1 },
      { lane: 'task_market', projectTasks: 2, operatorGates: 0 }
    ]);
    // Planning must not create the database file it was pointed at.
    await expect(readFile(join(temporaryRoot, 'planned.sqlite'))).rejects.toThrow();
  });

  it('applies the manifest and re-seeding skips every already-indexed task', async () => {
    const manifestPath = await writeManifest(
      manifestWith([projectTask('alpha'), projectTask('beta', ['alpha']), operatorGate('gate-one')])
    );
    const databaseFile = join(temporaryRoot, 'applied.sqlite');
    const options = { projectRoot: PROJECT_ROOT, manifestPath, databaseFile, apply: true };

    const first = await seedWorkIndex(options);
    expect(first).toMatchObject({
      status: 'applied',
      taskCount: 3,
      submittedCount: 3,
      skippedExistingCount: 0
    });

    const second = await seedWorkIndex(options);
    expect(second).toMatchObject({
      status: 'applied',
      taskCount: 3,
      submittedCount: 0,
      skippedExistingCount: 3
    });
  });

  it('fails loudly when a seeded source id now carries different work', async () => {
    const databaseFile = join(temporaryRoot, 'conflict.sqlite');
    const first = await writeManifest(manifestWith([projectTask('alpha')]));
    await seedWorkIndex({
      projectRoot: PROJECT_ROOT,
      manifestPath: first,
      databaseFile,
      apply: true
    });

    // Same id and source, different policy: silently reporting this as "skipped" would hide
    // that the queue still holds the superseded work.
    const changed = manifestWith([
      { ...projectTask('alpha'), policy: { band: 'P0', impact: 9, urgency: 9, effort: 1 } }
    ]);
    await writeFile(join(temporaryRoot, 'work-index.json'), JSON.stringify(changed), 'utf8');

    await expect(
      seedWorkIndex({
        projectRoot: PROJECT_ROOT,
        manifestPath: join(temporaryRoot, 'work-index.json'),
        databaseFile,
        apply: true
      })
    ).rejects.toThrow(/already exists with different work/i);
  });

  it('refuses a manifest whose dependencies form a cycle before touching the database', async () => {
    const manifestPath = await writeManifest(
      manifestWith([projectTask('alpha', ['beta']), projectTask('beta', ['alpha'])])
    );

    await expect(
      seedWorkIndex({
        projectRoot: PROJECT_ROOT,
        manifestPath,
        databaseFile: join(temporaryRoot, 'cyclic.sqlite'),
        apply: true
      })
    ).rejects.toThrow(/cycle/i);
    await expect(readFile(join(temporaryRoot, 'cyclic.sqlite'))).rejects.toThrow();
  });

  it('rejects a malformed manifest rather than seeding a partial queue', async () => {
    const manifestPath = join(temporaryRoot, 'work-index.json');
    await writeFile(manifestPath, JSON.stringify({ schemaVersion: 1, tasks: [] }), 'utf8');

    await expect(
      seedWorkIndex({
        projectRoot: PROJECT_ROOT,
        manifestPath,
        databaseFile: join(temporaryRoot, 'malformed.sqlite'),
        apply: true
      })
    ).rejects.toThrow();
    await expect(readFile(join(temporaryRoot, 'malformed.sqlite'))).rejects.toThrow();
  });

  it('seeds the checked-in manifest end to end', async () => {
    const result = await seedWorkIndex({
      projectRoot: PROJECT_ROOT,
      manifestPath: resolve(PROJECT_ROOT, 'docs/work-index.json'),
      databaseFile: join(temporaryRoot, 'checked-in.sqlite'),
      apply: true
    });

    const manifest = await loadCheckedInManifest();
    expect(result.status).toBe('applied');
    expect(result.taskCount).toBe(manifest.tasks.length);
    expect(result.submittedCount).toBe(manifest.tasks.length);
    expect(result.lanes.map(({ lane }) => lane)).toEqual(['agency', 'task_market']);
  });
});
