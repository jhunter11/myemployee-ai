import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TaskmarketSubmissionInspection } from '../../src/task-market/taskmarket-inspector';
import {
  TASKMARKET_INSPECTOR_CLI_ERROR_CODE,
  runTaskmarketInspectorCli
} from '../../src/task-market/taskmarket-inspector-cli';

const TASK_ID = `0x${'1'.repeat(64)}`;

function inspection(
  overrides: Partial<TaskmarketSubmissionInspection> = {}
): TaskmarketSubmissionInspection {
  return {
    schemaVersion: 1,
    taskId: TASK_ID,
    taskDigest: '2'.repeat(64),
    status: 'open',
    submissionWindowOpen: true,
    expiresAt: '2026-07-22T16:00:00.000Z',
    pendingActions: [],
    ...overrides
  };
}

function fixedErrorLine(): string {
  return JSON.stringify({
    schemaVersion: 1,
    status: 'operational_error',
    errorCode: TASKMARKET_INSPECTOR_CLI_ERROR_CODE
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Taskmarket inspector CLI', () => {
  it('accepts one task ID and emits exactly one bounded JSON line', async () => {
    const lines: string[] = [];
    const inspect = vi.fn().mockResolvedValue(inspection());

    const exitCode = await runTaskmarketInspectorCli([TASK_ID], {
      inspector: { inspect },
      writeLine: (line) => lines.push(line)
    });

    expect(exitCode).toBe(0);
    expect(inspect).toHaveBeenCalledOnce();
    expect(inspect).toHaveBeenCalledWith(TASK_ID);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '{}')).toEqual(inspection());
    expect(Buffer.byteLength(lines[0] ?? '', 'utf8')).toBeLessThanOrEqual(32 * 1_024);
    expect(lines[0]).not.toContain('\n');
  });

  it('uses global fetch for the production dependency', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: TASK_ID,
          description: 'Bounded task.',
          reward: '1000000',
          expiryTime: '2026-07-22T16:00:00.000Z',
          status: 'open',
          submissionWindowOpen: true,
          pendingActions: []
        }),
        { headers: { 'content-type': 'application/json' } }
      )
    );
    vi.stubGlobal('fetch', fetchMock);
    const writes: string[] = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });

    const exitCode = await runTaskmarketInspectorCli([TASK_ID]);

    expect(exitCode).toBe(0);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(stdout).toHaveBeenCalledOnce();
    expect(writes).toHaveLength(1);
    expect(writes[0]?.endsWith('\n')).toBe(true);
    expect(writes[0]?.trim()).not.toContain('Bounded task.');
  });

  it.each([
    ['missing argument', []],
    ['extra argument', [TASK_ID, TASK_ID]],
    ['unknown flag', ['--help']],
    ['credential flag', [TASK_ID, '--api-token=SECRET_TOKEN']],
    ['action flag', [TASK_ID, '--submit']],
    ['path traversal', ['../task']],
    ['query injection', [`${TASK_ID}?admin=true`]]
  ])('rejects %s with one fixed generic record', async (_label, argv) => {
    const lines: string[] = [];
    const inspect = vi.fn();

    const exitCode = await runTaskmarketInspectorCli(argv, {
      inspector: { inspect },
      writeLine: (line) => lines.push(line)
    });

    expect(exitCode).not.toBe(0);
    expect(inspect).not.toHaveBeenCalled();
    expect(lines).toEqual([fixedErrorLine()]);
    expect(lines[0]).not.toMatch(/SECRET_TOKEN|--help|--submit|admin|\.\.\/task/);
  });

  it('redacts upstream and operational errors into the same fixed record', async () => {
    const lines: string[] = [];
    const inspect = vi
      .fn()
      .mockRejectedValue(new Error('upstream exposed SECRET_TOKEN for https://evil.test/private'));

    const exitCode = await runTaskmarketInspectorCli([TASK_ID], {
      inspector: { inspect },
      writeLine: (line) => lines.push(line)
    });

    expect(exitCode).not.toBe(0);
    expect(lines).toEqual([fixedErrorLine()]);
    expect(lines[0]).not.toMatch(/SECRET_TOKEN|evil\.test|upstream exposed/);
  });

  it('fails closed before emitting an oversized result', async () => {
    const lines: string[] = [];
    const oversized = {
      ...inspection(),
      unknownExternalText: 'SENSITIVE'.repeat(5_000)
    } as unknown as TaskmarketSubmissionInspection;

    const exitCode = await runTaskmarketInspectorCli([TASK_ID], {
      inspector: { inspect: vi.fn().mockResolvedValue(oversized) },
      writeLine: (line) => lines.push(line)
    });

    expect(exitCode).not.toBe(0);
    expect(lines).toEqual([fixedErrorLine()]);
    expect(lines[0]).not.toContain('SENSITIVE');
  });

  it('normalizes valid hexadecimal task IDs before inspection', async () => {
    const uppercaseTaskId = `0x${'A'.repeat(64)}`;
    const lines: string[] = [];
    const inspect = vi.fn().mockResolvedValue(
      inspection({
        taskId: uppercaseTaskId.toLowerCase()
      })
    );

    const exitCode = await runTaskmarketInspectorCli([uppercaseTaskId], {
      inspector: { inspect },
      writeLine: (line) => lines.push(line)
    });

    expect(exitCode).toBe(0);
    expect(inspect).toHaveBeenCalledWith(uppercaseTaskId.toLowerCase());
    expect(lines).toHaveLength(1);
  });
});
