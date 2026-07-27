import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const ioMocks = vi.hoisted(() => ({ open: vi.fn() }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, open: ioMocks.open };
});

import { bootstrapFirstClientRevenue } from '../../src/revenue/first-client-bootstrap';

const projectRoot = join(__dirname, '..', '..');
const packPath = join(projectRoot, 'docs', 'revenue', 'first-client-pack.json');

describe('first-client bootstrap pack I/O boundary', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects a direct pack whose identity changes between validation and parsing', async () => {
    const content = await readFile(packPath, 'utf8');
    const close = vi.fn().mockResolvedValue(undefined);
    const before = {
      isFile: () => true,
      nlink: 1,
      size: Buffer.byteLength(content),
      dev: 101,
      ino: 202,
      mtimeMs: 303
    };
    const stat = vi
      .fn()
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce({ ...before, mtimeMs: before.mtimeMs + 1 });
    ioMocks.open.mockResolvedValueOnce({
      stat,
      readFile: vi.fn().mockResolvedValue(content),
      close
    });

    await expect(bootstrapFirstClientRevenue({ projectRoot, packPath })).rejects.toThrow(
      /changed while being read/i
    );
    expect(stat).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledOnce();
  });
});
