import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as bootstrapModule from '../../src/revenue/first-client-bootstrap';
import { runFirstClientBootstrapCli } from '../../src/revenue/first-client-bootstrap-cli';

const projectRoot = join(__dirname, '..', '..');
const packPath = join(projectRoot, 'docs', 'revenue', 'first-client-pack.json');

describe('first-client bootstrap CLI', () => {
  let temporaryRoot: string;

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'jarvis-first-client-cli-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  it('defaults to dry-run and emits one bounded redacted JSON record', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const databaseFile = join(temporaryRoot, 'jarvis.sqlite');

    const code = await runFirstClientBootstrapCli(
      ['--project-root', projectRoot, '--pack', packPath, '--database', databaseFile],
      {
        stdout: (message) => stdout.push(message),
        stderr: (message) => stderr.push(message)
      }
    );

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toHaveLength(1);
    expect(stdout[0]?.length).toBeLessThan(4_096);
    expect(JSON.parse(stdout[0] ?? '{}')).toMatchObject({
      mode: 'dry_run',
      ledger: { mutation: 'none' }
    });
    expect(stdout[0]).not.toContain(projectRoot);
    expect(stdout[0]).not.toMatch(/https?:|\.com|contact:/);
  });

  it('requires explicit apply and absolute direct paths while redacting failures', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runFirstClientBootstrapCli(
      ['--apply', '--project-root', '.', '--pack', packPath, '--database', 'jarvis.sqlite'],
      {
        stdout: (message) => stdout.push(message),
        stderr: (message) => stderr.push(message)
      }
    );

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toHaveLength(1);
    expect(stderr[0]?.length).toBeLessThan(512);
    expect(JSON.parse(stderr[0] ?? '{}')).toEqual({
      error: {
        code: 'FIRST_CLIENT_BOOTSTRAP_FAILED',
        message: 'Local first-client bootstrap failed validation or application'
      }
    });
    expect(stderr[0]).not.toContain(packPath);
    expect(stderr[0]).not.toContain('jarvis.sqlite');
  });

  it('rejects unknown flags instead of broadening local capabilities', async () => {
    const stderr: string[] = [];
    const code = await runFirstClientBootstrapCli(['--send', '--wallet', 'secret'], {
      stdout: () => undefined,
      stderr: (message) => stderr.push(message)
    });

    expect(code).toBe(1);
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).not.toContain('secret');
  });

  it('resolves the reviewed pack and ledger defaults from the current project root', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runFirstClientBootstrapCli([], {
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message)
    });

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(JSON.parse(stdout[0] ?? '{}')).toMatchObject({ mode: 'dry_run' });
  });

  it.each([
    ['duplicate apply', ['--apply', '--apply']],
    ['duplicate project root', ['--project-root', projectRoot, '--project-root', projectRoot]],
    ['missing final value', ['--pack']],
    ['flag in place of a value', ['--database', '--apply']]
  ])('rejects %s with the same bounded error contract', async (_label, argv) => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runFirstClientBootstrapCli(argv, {
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message)
    });

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([
      JSON.stringify({
        error: {
          code: 'FIRST_CLIENT_BOOTSTRAP_FAILED',
          message: 'Local first-client bootstrap failed validation or application'
        }
      })
    ]);
  });

  it('fails closed before writing an oversized result to stdout', async () => {
    vi.spyOn(bootstrapModule, 'bootstrapFirstClientRevenue').mockResolvedValue({
      oversized: 'x'.repeat(4_096)
    } as unknown as bootstrapModule.FirstClientBootstrapResult);
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runFirstClientBootstrapCli(
      ['--project-root', projectRoot, '--pack', packPath],
      {
        stdout: (message) => stdout.push(message),
        stderr: (message) => stderr.push(message)
      }
    );

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).not.toContain('x'.repeat(32));
  });
});
