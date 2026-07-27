import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  digestSourceFileRecords,
  parseOfflineComputeProfile,
  type OfflineComputeProfile,
  type SourceFileRecord
} from '../../src/offline-compute/contracts';
import { OfflineComputeRunner } from '../../src/offline-compute/runner';

const SCRIPT_PATH = 'examples/run_fixture_backtest.py';

function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function testProfile(
  directory: string,
  files: SourceFileRecord[],
  overrides: Partial<Pick<OfflineComputeProfile, 'timeoutMs' | 'maxOutputBytes'>> = {}
): OfflineComputeProfile {
  return parseOfflineComputeProfile({
    schemaVersion: 1,
    id: 'offline_compute',
    commandId: 'pmqs-fixture-backtest-v1',
    network: 'none',
    timeoutMs: overrides.timeoutMs ?? 2_000,
    maxOutputBytes: overrides.maxOutputBytes ?? 4_096,
    source: {
      repository: 'jhunter11/pmqs',
      commit: '6fbd6d4fe0b9b17c18d5560fb1507a6cd66ac6d4',
      tree: '8cf4d1fd58e29c44fc537d19739c1135ed76987e',
      directory,
      digest: digestSourceFileRecords(files),
      files
    }
  });
}

describe.runIf(process.platform === 'darwin')('OfflineComputeRunner on macOS', () => {
  let temporaryRoot: string;
  let archiveRoot: string;
  let sourceDirectory: string;

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'jarvis-offline-compute-test-'));
    archiveRoot = join(temporaryRoot, 'archives');
    sourceDirectory = 'pmqs-test-source';
    await mkdir(join(archiveRoot, sourceDirectory, 'examples'), { recursive: true });
  });

  afterEach(async () => {
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  async function installScript(
    script: string,
    overrides: Partial<Pick<OfflineComputeProfile, 'timeoutMs' | 'maxOutputBytes'>> = {}
  ): Promise<{ profile: OfflineComputeProfile; scriptPath: string }> {
    const scriptPath = join(archiveRoot, sourceDirectory, SCRIPT_PATH);
    await writeFile(scriptPath, script, { mode: 0o600 });
    const files = [
      {
        path: SCRIPT_PATH,
        bytes: Buffer.byteLength(script),
        sha256: sha256(script)
      }
    ];
    return { profile: testProfile(sourceDirectory, files, overrides), scriptPath };
  }

  function runner(profile: OfflineComputeProfile): OfflineComputeRunner {
    return new OfflineComputeRunner({
      archiveRoot,
      profile,
      temporaryRoot
    });
  }

  it('runs only the fixed fixture backtest under a proved no-network sandbox', async () => {
    const { profile } = await installScript('print("verdict         : FAIL")\n');

    const result = await runner(profile).run();

    expect(result).toEqual({
      profile: 'offline_compute',
      commandId: 'pmqs-fixture-backtest-v1',
      source: {
        repository: 'jhunter11/pmqs',
        commit: '6fbd6d4fe0b9b17c18d5560fb1507a6cd66ac6d4',
        tree: '8cf4d1fd58e29c44fc537d19739c1135ed76987e',
        digest: profile.source.digest
      },
      status: 'succeeded',
      reason: null,
      verdict: 'FAIL',
      stdout: {
        bytes: 23,
        sha256: sha256('verdict         : FAIL\n')
      },
      stderr: { bytes: 0, sha256: sha256('') },
      exitCode: 0,
      signal: null
    });
  });

  it('copies source into a disposable root and denies reads of an archive sibling sentinel', async () => {
    const sentinelPath = join(temporaryRoot, 'sibling-secret.txt');
    const secret = 'must-not-enter-the-verdict';
    await writeFile(sentinelPath, secret);
    const script = [
      'from pathlib import Path',
      `sentinel = Path(${JSON.stringify(sentinelPath)})`,
      'try:',
      '    sentinel.read_text()',
      'except PermissionError:',
      '    print("verdict         : FAIL")',
      'else:',
      '    print("verdict         : PASS")',
      ''
    ].join('\n');
    const { profile } = await installScript(script);

    const result = await runner(profile).run();

    expect(result.status).toBe('succeeded');
    expect(result.verdict).toBe('FAIL');
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(await readFile(sentinelPath, 'utf8')).toBe(secret);
  });

  it('scrubs the inherited environment and supplies a private HOME inside the execution root', async () => {
    const previousSecret = process.env.JARVIS_HOSTILE_SECRET;
    process.env.JARVIS_HOSTILE_SECRET = 'do-not-inherit';
    const script = [
      'import os',
      'from pathlib import Path',
      'allowed = {"HOME", "LANG", "LC_ALL", "PATH", "PYTHONHASHSEED", "TMPDIR"}',
      'home = Path(os.environ["HOME"])',
      'clean = "JARVIS_HOSTILE_SECRET" not in os.environ and set(os.environ) <= allowed',
      'private_home = home.parent == Path.cwd().parent and home.name == "home"',
      'print("verdict         : FAIL" if clean and private_home else "verdict         : PASS")',
      ''
    ].join('\n');

    try {
      const { profile } = await installScript(script);
      const result = await runner(profile).run();

      expect(result.status).toBe('succeeded');
      expect(result.verdict).toBe('FAIL');
      expect(JSON.stringify(result)).not.toContain('do-not-inherit');
    } finally {
      if (previousSecret === undefined) delete process.env.JARVIS_HOSTILE_SECRET;
      else process.env.JARVIS_HOSTILE_SECRET = previousSecret;
    }
  });

  it('returns identical normalized evidence for deterministic executions', async () => {
    const { profile } = await installScript(
      'print("stable metadata")\nprint("verdict         : FAIL")\n'
    );

    const first = await runner(profile).run();
    const second = await runner(profile).run();

    expect(second).toEqual(first);
  });

  it('accepts the other fixed fixture verdict without changing the command contract', async () => {
    const { profile } = await installScript('print("verdict         : PASS")\n');

    const result = await runner(profile).run();

    expect(result).toMatchObject({
      status: 'succeeded',
      reason: null,
      verdict: 'PASS',
      exitCode: 0
    });
  });

  it('returns bounded failure metadata when the fixed fixture command exits nonzero', async () => {
    const { profile } = await installScript('raise SystemExit(7)\n');

    const result = await runner(profile).run();

    expect(result).toMatchObject({
      status: 'failed',
      reason: 'COMMAND_FAILED',
      verdict: null,
      exitCode: 7
    });
  });

  it.each([
    ['missing', 'print("bounded fixture output")\n'],
    ['ambiguous', 'print("verdict         : PASS")\nprint("verdict         : FAIL")\n']
  ])('rejects a %s verdict from an otherwise successful command', async (_case, script) => {
    const { profile } = await installScript(script);

    const result = await runner(profile).run();

    expect(result).toMatchObject({
      status: 'failed',
      reason: 'VERDICT_INVALID',
      verdict: null,
      exitCode: 0
    });
  });

  it('kills the isolated process group when the fixed command exceeds its deadline', async () => {
    const { profile } = await installScript('while True:\n    pass\n', { timeoutMs: 50 });

    const result = await runner(profile).run();

    expect(result).toMatchObject({
      status: 'timeout',
      reason: 'TIMEOUT',
      verdict: null,
      exitCode: null,
      signal: 'SIGKILL'
    });
  });

  it.each([
    ['stdout', 'import sys\nsys.stdout.write("x" * 10000)\nsys.stdout.flush()\n'],
    ['stderr', 'import sys\nsys.stderr.write("x" * 10000)\nsys.stderr.flush()\n']
  ])(
    'bounds %s and kills an oversized command without returning its contents',
    async (_stream, script) => {
      const { profile } = await installScript(script, { maxOutputBytes: 256 });

      const result = await runner(profile).run();

      expect(result.status).toBe('output_limit');
      expect(result.reason).toBe('OUTPUT_LIMIT');
      expect(result.stdout.bytes + result.stderr.bytes).toBeLessThanOrEqual(256);
      expect(JSON.stringify(result)).not.toContain('xxxxxxxx');
    }
  );

  it('rejects source content drift and leaves the source archive unchanged', async () => {
    const { profile, scriptPath } = await installScript('print("verdict         : FAIL")\n');
    const original = await readFile(scriptPath);
    await writeFile(scriptPath, 'print("verdict         : PASS")\n');

    await expect(runner(profile).run()).rejects.toMatchObject({
      code: 'OFFLINE_SOURCE_INVALID'
    });
    expect(await readFile(scriptPath)).toEqual(Buffer.from('print("verdict         : PASS")\n'));
    expect(await readFile(scriptPath)).not.toEqual(original);
  });

  it('rejects source symlinks instead of following them', async () => {
    const scriptPath = join(archiveRoot, sourceDirectory, SCRIPT_PATH);
    const outside = join(temporaryRoot, 'outside.py');
    const script = 'print("verdict         : PASS")\n';
    await writeFile(outside, script);
    await symlink(outside, scriptPath);
    const files = [{ path: SCRIPT_PATH, bytes: Buffer.byteLength(script), sha256: sha256(script) }];

    await expect(runner(testProfile(sourceDirectory, files)).run()).rejects.toMatchObject({
      code: 'OFFLINE_SOURCE_INVALID'
    });
  });

  it('rejects a source directory that resolves outside the pinned archive root', async () => {
    const outsideDirectory = join(temporaryRoot, 'outside-source');
    const script = 'print("verdict         : PASS")\n';
    await mkdir(join(outsideDirectory, 'examples'), { recursive: true });
    await writeFile(join(outsideDirectory, SCRIPT_PATH), script);
    await rm(join(archiveRoot, sourceDirectory), { recursive: true, force: true });
    await symlink(outsideDirectory, join(archiveRoot, sourceDirectory));
    const files = [{ path: SCRIPT_PATH, bytes: Buffer.byteLength(script), sha256: sha256(script) }];

    await expect(runner(testProfile(sourceDirectory, files)).run()).rejects.toMatchObject({
      code: 'OFFLINE_SOURCE_INVALID'
    });
  });
});

describe('offline compute fail-closed validation', () => {
  it.each([
    ['a traversing source directory', { source: { directory: '../outside' } }],
    ['a traversing file path', { source: { files: [{ path: '../escape.py' }] } }],
    ['an alternate command', { commandId: 'python-anything' }],
    ['network access', { network: 'allowlist' }],
    ['an executable field', { command: ['/bin/sh'] }]
  ])('rejects %s', (_description, mutation) => {
    const file = { path: SCRIPT_PATH, bytes: 1, sha256: 'a'.repeat(64) };
    const base = {
      schemaVersion: 1,
      id: 'offline_compute',
      commandId: 'pmqs-fixture-backtest-v1',
      network: 'none',
      timeoutMs: 1_000,
      maxOutputBytes: 1_024,
      source: {
        repository: 'jhunter11/pmqs',
        commit: '6fbd6d4fe0b9b17c18d5560fb1507a6cd66ac6d4',
        tree: '8cf4d1fd58e29c44fc537d19739c1135ed76987e',
        directory: 'pmqs-source',
        digest: digestSourceFileRecords([file]),
        files: [file]
      }
    };
    const merged = {
      ...base,
      ...mutation,
      source: { ...base.source, ...('source' in mutation ? mutation.source : {}) }
    };

    expect(() => parseOfflineComputeProfile(merged)).toThrowError(
      expect.objectContaining({ code: 'INVALID_OFFLINE_COMPUTE_PROFILE' })
    );
  });

  it('fails closed when the host cannot provide the macOS no-network primitive', async () => {
    const file = { path: SCRIPT_PATH, bytes: 1, sha256: 'a'.repeat(64) };
    const profile = testProfile('pmqs-source', [file]);
    const runner = new OfflineComputeRunner({
      archiveRoot: '/does/not/matter',
      profile,
      platform: 'linux'
    });

    await expect(runner.run()).rejects.toMatchObject({
      code: 'OFFLINE_NETWORK_ISOLATION_UNAVAILABLE'
    });
  });
});
