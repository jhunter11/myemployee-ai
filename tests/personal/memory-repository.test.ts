import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import {
  MarkdownPersonalMemoryRepository,
  serializePersonalMemory
} from '../../src/personal/memory-repository';

const memory = {
  version: 1 as const,
  id: 'preferred-focus',
  branch: 'preferences' as const,
  title: 'Preferred focus window',
  summary: 'Reserve mornings for uninterrupted build work.',
  provenance: 'operator_statement' as const,
  confidence: 1,
  sensitivity: 'private' as const,
  scope: 'personal' as const,
  createdAt: '2026-07-20T12:00:00.000Z',
  updatedAt: '2026-07-20T12:00:00.000Z',
  reviewAt: '2026-07-21T12:00:00.000Z',
  expiresAt: null,
  corrections: []
};

describe('MarkdownPersonalMemoryRepository', () => {
  it('loads the committed personal seed memories used by the live dashboard', async () => {
    const root = join(__dirname, '..', '..', 'memory', 'personal');
    const records = await new MarkdownPersonalMemoryRepository(root).list({ limit: 10 });
    expect(records.map(({ id }) => id)).toEqual(['agency-autonomy-goal', 'jarvis-vision']);
  });

  it('round-trips strict personal records and returns bounded review-due summaries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jarvis-personal-'));
    const repository = new MarkdownPersonalMemoryRepository(root);
    await repository.save(memory);

    await expect(repository.list({ limit: 5 })).resolves.toEqual([memory]);
    await expect(
      repository.reviewDue({ now: '2026-07-21T12:00:00.000Z', limit: 1 })
    ).resolves.toEqual([
      {
        id: memory.id,
        branch: memory.branch,
        title: memory.title,
        summary: memory.summary,
        confidence: 1,
        sensitivity: 'private',
        reviewAt: memory.reviewAt,
        source: `personal-memory:${memory.id}`
      }
    ]);
  });

  it('rejects invalid front matter instead of silently accepting untrusted memory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jarvis-personal-'));
    await writeFile(
      join(root, 'invalid.md'),
      '---\n{"version":1,"id":"invalid","branch":"secrets"}\n---\n# Invalid\n',
      'utf8'
    );
    const repository = new MarkdownPersonalMemoryRepository(root);
    await expect(repository.list({ limit: 5 })).rejects.toThrow();
  });

  it('reads only direct regular files and skips matching Markdown symlinks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jarvis-personal-'));
    const outside = await mkdtemp(join(tmpdir(), 'jarvis-personal-outside-'));
    const outsideMemory = {
      ...memory,
      id: 'outside-memory',
      title: 'Outside memory',
      summary: 'This content must not cross the personal-memory root boundary.'
    };
    const outsidePath = join(outside, 'outside-memory.md');
    await writeFile(outsidePath, serializePersonalMemory(outsideMemory), 'utf8');
    await symlink(outsidePath, join(root, 'outside-memory.md'));
    await symlink(join(outside, 'missing-memory.md'), join(root, 'dangling-memory.md'));
    await mkdir(join(root, 'directory-memory.md'));

    const repository = new MarkdownPersonalMemoryRepository(root);
    await repository.save(memory);

    await expect(repository.list({ limit: 10 })).resolves.toEqual([memory]);
    await expect(
      repository.reviewDue({ now: '2026-07-21T12:00:00.000Z', limit: 10 })
    ).resolves.toEqual([
      expect.objectContaining({
        id: memory.id,
        source: `personal-memory:${memory.id}`
      })
    ]);
  });

  it('rejects a symlinked personal-memory root without disclosing its target', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'jarvis-personal-outside-'));
    const container = await mkdtemp(join(tmpdir(), 'jarvis-personal-container-'));
    const linkedRoot = join(container, 'personal-memory');
    await symlink(outside, linkedRoot);

    const repository = new MarkdownPersonalMemoryRepository(linkedRoot);
    const error = await repository.list({ limit: 5 }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Personal memory root must be a direct directory');
    expect((error as Error).message).not.toContain(outside);
    await expect(new MarkdownPersonalMemoryRepository(linkedRoot).save(memory)).rejects.toThrow(
      'Personal memory root must be a direct directory'
    );
  });

  it('validates limits and refuses record identifiers that could escape the root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jarvis-personal-'));
    const repository = new MarkdownPersonalMemoryRepository(root);
    await expect(repository.list({ limit: 0 })).rejects.toThrow('limit');
    expect(() => serializePersonalMemory({ ...memory, id: '../escape' })).toThrow();
  });
});
