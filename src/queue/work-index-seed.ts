import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { z } from 'zod';

import { createDatabase } from '../db/database';
import { PriorityQueueRepository } from '../db/priority-queue-repository';
import { PriorityQueueService } from './priority-queue-service';
import { QueueTaskInputSchema, type QueueTaskInput } from './contracts';

const ManifestIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/);
const ManifestLaneSchema = z.string().regex(/^[a-z][a-z0-9_-]{2,62}$/);

const ManifestPolicySchema = z.strictObject({
  band: z.enum(['P0', 'P1', 'P2', 'P3']),
  impact: z.number().int().min(0).max(10),
  urgency: z.number().int().min(0).max(10),
  effort: z.number().int().min(1).max(10)
});

/**
 * Prose fields (title, summary, evidence, acceptance, constraint) stay in the manifest and are
 * never written to the queue. Queue rows carry bounded metadata only and reference the manifest
 * through an opaque `work-index:<id>` artifact reference.
 */
const ManifestTaskSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('project_task'),
    id: ManifestIdSchema,
    lane: ManifestLaneSchema,
    taskType: z.enum(['build', 'research', 'review', 'verify']),
    title: z.string().min(1).max(200),
    summary: z.string().min(1).max(2_000),
    evidence: z.string().max(500).optional(),
    acceptance: z.string().max(500).optional(),
    constraint: z.string().max(500).optional(),
    policy: ManifestPolicySchema,
    dependencies: z.array(ManifestIdSchema).max(32)
  }),
  z.strictObject({
    kind: z.literal('operator_gate'),
    id: ManifestIdSchema,
    lane: ManifestLaneSchema,
    gateType: z.enum(['approval', 'budget', 'release', 'security']),
    title: z.string().min(1).max(200),
    summary: z.string().min(1).max(2_000),
    evidence: z.string().max(500).optional(),
    acceptance: z.string().max(500).optional(),
    constraint: z.string().max(500).optional(),
    policy: ManifestPolicySchema,
    dependencies: z.array(ManifestIdSchema).max(32)
  })
]);

export const WorkIndexManifestSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    description: z.string().max(1_000),
    generatedAt: z.iso.datetime(),
    tenantId: z.string().regex(/^[a-z][a-z0-9_]{2,62}$/),
    conventions: z.record(z.string(), z.string()),
    tasks: z.array(ManifestTaskSchema).min(1).max(500)
  })
  .superRefine((manifest, context) => {
    const ids = new Set<string>();
    for (const task of manifest.tasks) {
      if (ids.has(task.id)) {
        context.addIssue({ code: 'custom', message: `duplicate task id ${task.id}` });
      }
      ids.add(task.id);
    }
    for (const task of manifest.tasks) {
      for (const dependency of task.dependencies) {
        if (!ids.has(dependency)) {
          context.addIssue({
            code: 'custom',
            message: `task ${task.id} depends on unknown id ${dependency}`
          });
        }
      }
    }
  });

export type WorkIndexManifest = z.infer<typeof WorkIndexManifestSchema>;
export type WorkIndexTask = z.infer<typeof ManifestTaskSchema>;

export interface WorkIndexSeedOptions {
  projectRoot: string;
  manifestPath: string;
  databaseFile: string;
  apply: boolean;
}

export interface WorkIndexSeedResult {
  schemaVersion: 1;
  status: 'planned' | 'applied';
  tenantId: string;
  taskCount: number;
  submittedCount: number;
  skippedExistingCount: number;
  lanes: Array<{ lane: string; projectTasks: number; operatorGates: number }>;
  bands: Record<string, number>;
}

export function toQueueTaskInput(task: WorkIndexTask, manifest: WorkIndexManifest): QueueTaskInput {
  const artifactRef = `work-index:${task.id}`;
  const payload =
    task.kind === 'project_task'
      ? {
          kind: 'project_task' as const,
          projectId: task.lane,
          taskType: task.taskType,
          artifactRef
        }
      : {
          kind: 'operator_gate' as const,
          gateType: task.gateType,
          subjectRef: artifactRef
        };

  return QueueTaskInputSchema.parse({
    id: task.id,
    tenantId: manifest.tenantId,
    lane: task.lane,
    source: {
      kind: 'project',
      id: task.id,
      occurredAt: manifest.generatedAt
    },
    payload,
    policy: task.policy,
    dependencies: task.dependencies
  });
}

/**
 * Dependencies must be enqueued before the tasks that reference them, so callers receive a
 * deterministic topological ordering. Throws on a cycle rather than silently dropping work.
 */
export function orderByDependencies(tasks: readonly WorkIndexTask[]): WorkIndexTask[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const ordered: WorkIndexTask[] = [];
  const settled = new Set<string>();
  const visiting = new Set<string>();

  const visit = (task: WorkIndexTask): void => {
    if (settled.has(task.id)) return;
    if (visiting.has(task.id)) {
      throw new Error(`Work index contains a dependency cycle at ${task.id}`);
    }
    visiting.add(task.id);
    for (const dependencyId of task.dependencies) {
      const dependency = byId.get(dependencyId);
      if (dependency !== undefined) visit(dependency);
    }
    visiting.delete(task.id);
    settled.add(task.id);
    ordered.push(task);
  };

  for (const task of tasks) visit(task);
  return ordered;
}

function summarize(
  manifest: WorkIndexManifest,
  submittedCount: number,
  skippedExistingCount: number,
  apply: boolean
): WorkIndexSeedResult {
  const lanes = new Map<string, { projectTasks: number; operatorGates: number }>();
  const bands: Record<string, number> = {};

  for (const task of manifest.tasks) {
    const lane = lanes.get(task.lane) ?? { projectTasks: 0, operatorGates: 0 };
    if (task.kind === 'project_task') lane.projectTasks += 1;
    else lane.operatorGates += 1;
    lanes.set(task.lane, lane);
    bands[task.policy.band] = (bands[task.policy.band] ?? 0) + 1;
  }

  return {
    schemaVersion: 1,
    status: apply ? 'applied' : 'planned',
    tenantId: manifest.tenantId,
    taskCount: manifest.tasks.length,
    submittedCount,
    skippedExistingCount,
    lanes: [...lanes.entries()]
      .map(([lane, counts]) => ({ lane, ...counts }))
      .sort((left, right) => left.lane.localeCompare(right.lane)),
    bands
  };
}

export async function seedWorkIndex(options: WorkIndexSeedOptions): Promise<WorkIndexSeedResult> {
  const manifestPath = resolve(options.projectRoot, options.manifestPath);
  const manifest = WorkIndexManifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')));

  const ordered = orderByDependencies(manifest.tasks);
  // Validate every mapping before touching the database so a malformed manifest cannot
  // leave the queue half seeded.
  const inputs = ordered.map((task) => toQueueTaskInput(task, manifest));

  if (!options.apply) {
    return summarize(manifest, 0, 0, false);
  }

  const context = await createDatabase({
    projectRoot: options.projectRoot,
    filename: options.databaseFile
  });

  try {
    const service = new PriorityQueueService(new PriorityQueueRepository(context.db));
    let submitted = 0;
    let skipped = 0;

    for (const input of inputs) {
      // Re-seeding is idempotent: (tenant_id, source_kind, source_id) is UNIQUE and the queue
      // resolves the conflict by returning the existing row, so the receipt — not an exception —
      // is what distinguishes newly indexed work from work that was already there. A source whose
      // content changed still throws, and must surface rather than be counted as skipped.
      const receipt = await service.submit(input);
      if (receipt.inserted) submitted += 1;
      else skipped += 1;
    }

    return summarize(manifest, submitted, skipped, true);
  } finally {
    await context.destroy();
  }
}
