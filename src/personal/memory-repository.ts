import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  type PersonalMemoryRecord,
  PersonalMemoryRecordSchema,
  type PersonalMemorySummary,
  PersonalMemorySummarySchema
} from './contracts';

function validateLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new RangeError('limit must be an integer between 1 and 50');
  }
  return limit;
}

const PERSONAL_MEMORY_ROOT_ERROR = 'Personal memory root must be a direct directory';

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function directRoot(root: string): Promise<Stats> {
  try {
    await mkdir(root, { recursive: true });
    const stats = await lstat(root);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(PERSONAL_MEMORY_ROOT_ERROR);
    }
    return stats;
  } catch (error) {
    if (error instanceof Error && error.message === PERSONAL_MEMORY_ROOT_ERROR) throw error;
    throw new Error(PERSONAL_MEMORY_ROOT_ERROR);
  }
}

async function assertStableRoot(root: string, expected: Stats): Promise<void> {
  let current: Stats;
  try {
    current = await lstat(root);
  } catch {
    throw new Error(PERSONAL_MEMORY_ROOT_ERROR);
  }
  if (current.isSymbolicLink() || !current.isDirectory() || !sameFile(current, expected)) {
    throw new Error(PERSONAL_MEMORY_ROOT_ERROR);
  }
}

async function readDirectRegularFile(input: {
  root: string;
  rootStats: Stats;
  name: string;
}): Promise<string | null> {
  const path = join(input.root, input.name);
  let pathStats: Stats;
  try {
    pathStats = await lstat(path);
  } catch {
    return null;
  }
  if (pathStats.isSymbolicLink() || !pathStats.isFile()) return null;

  await assertStableRoot(input.root, input.rootStats);
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return null;
  }

  let markdown: string;
  try {
    const openedStats = await handle.stat();
    if (!openedStats.isFile() || !sameFile(openedStats, pathStats)) return null;
    markdown = await handle.readFile({ encoding: 'utf8' });
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
  await assertStableRoot(input.root, input.rootStats);
  return markdown;
}

export function serializePersonalMemory(input: unknown): string {
  const record = PersonalMemoryRecordSchema.parse(input);
  return `---\n${JSON.stringify(record)}\n---\n\n# ${record.title}\n\n${record.summary}\n`;
}

export function parsePersonalMemory(markdown: string): PersonalMemoryRecord {
  const match = markdown.match(/^---\n([^\n]+)\n---(?:\n|$)/u);
  if (!match?.[1]) throw new Error('Personal memory must contain JSON front matter');
  return PersonalMemoryRecordSchema.parse(JSON.parse(match[1]));
}

export interface PersonalMemoryReader {
  reviewDue(input: { now: string; limit: number }): Promise<PersonalMemorySummary[]>;
}

export class MarkdownPersonalMemoryRepository implements PersonalMemoryReader {
  constructor(private readonly root: string) {}

  async save(input: unknown): Promise<PersonalMemoryRecord> {
    const record = PersonalMemoryRecordSchema.parse(input);
    const rootStats = await directRoot(this.root);
    const target = join(this.root, `${record.id}.md`);
    const temporary = join(this.root, `.${record.id}.${process.pid}.tmp`);
    await assertStableRoot(this.root, rootStats);
    await writeFile(temporary, serializePersonalMemory(record), { encoding: 'utf8', mode: 0o600 });
    await assertStableRoot(this.root, rootStats);
    await rename(temporary, target);
    await assertStableRoot(this.root, rootStats);
    return record;
  }

  async list(input: { limit: number }): Promise<PersonalMemoryRecord[]> {
    const limit = validateLimit(input.limit);
    const rootStats = await directRoot(this.root);
    const files = (await readdir(this.root, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && /^[a-z][a-z0-9-]{2,63}\.md$/u.test(entry.name))
      .map((entry) => entry.name)
      .sort()
      .slice(0, limit);
    await assertStableRoot(this.root, rootStats);
    const records = await Promise.all(
      files.map(async (name) => {
        const markdown = await readDirectRegularFile({ root: this.root, rootStats, name });
        return markdown === null ? null : parsePersonalMemory(markdown);
      })
    );
    return records.filter((record): record is PersonalMemoryRecord => record !== null);
  }

  async reviewDue(input: { now: string; limit: number }): Promise<PersonalMemorySummary[]> {
    const now = Date.parse(input.now);
    if (!Number.isFinite(now)) throw new RangeError('now must be an ISO timestamp');
    const records = await this.list({ limit: 50 });
    return records
      .filter((record) => record.reviewAt !== null && Date.parse(record.reviewAt) <= now)
      .filter((record) => record.expiresAt === null || Date.parse(record.expiresAt) > now)
      .sort((left, right) => String(left.reviewAt).localeCompare(String(right.reviewAt)))
      .slice(0, validateLimit(input.limit))
      .map((record) =>
        PersonalMemorySummarySchema.parse({
          id: record.id,
          branch: record.branch,
          title: record.title,
          summary: record.summary,
          confidence: record.confidence,
          sensitivity: record.sensitivity,
          reviewAt: record.reviewAt,
          source: `personal-memory:${record.id}`
        })
      );
  }
}
