import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MermaidLogger } from '../../src/utils/mermaid-logger';

describe('MermaidLogger', () => {
  let temporaryRoot: string;
  let diagramsRoot: string;

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'jarvis-mermaid-logger-'));
    diagramsRoot = join(temporaryRoot, 'logs', 'diagrams');
  });

  afterEach(async () => {
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  it('writes ordered handoffs to the exact per-run sequence diagram path', async () => {
    const logger = new MermaidLogger({ projectRoot: temporaryRoot });
    logger.start('run-42');
    logger.log('Gateway', 'Supervisor', 'Dispatch daily report');
    logger.log('Supervisor', 'acme_corp_worker', 'Execute automation');
    logger.log('acme_corp_worker', 'Supervisor', 'Return result');

    const diagramPath = await logger.save();

    expect(diagramPath).toBe(join(diagramsRoot, 'flow_run-42.md'));
    expect(await readFile(diagramPath, 'utf8')).toBe(
      [
        '# Flow run-42',
        '',
        '```mermaid',
        'sequenceDiagram',
        '    Gateway->>Supervisor: Dispatch daily report',
        '    Supervisor->>acme_corp_worker: Execute automation',
        '    acme_corp_worker->>Supervisor: Return result',
        '```',
        ''
      ].join('\n')
    );
  });

  it('sanitizes task ids, participants, and messages against traversal and Mermaid injection', async () => {
    const logger = new MermaidLogger({ diagramsRoot });
    logger.start('../escape\nparticipant Intruder');
    logger.log(
      'Gateway\nparticipant Evil',
      'Worker; destroy',
      'hello;\nparticipant Hacker\n<script>alert(1)</script> %%{init}%% ```'
    );

    const diagramPath = await logger.save();
    const content = await readFile(diagramPath, 'utf8');
    const diagramLines = content.split('\n').filter((line) => line.includes('->>'));
    const handoff = diagramLines[0] ?? '';
    const sanitizedMessage = handoff.split(': ').slice(1).join(': ');

    expect(dirname(diagramPath)).toBe(diagramsRoot);
    expect(basename(diagramPath)).toBe('flow_escape_participant_Intruder.md');
    expect(diagramLines).toHaveLength(1);
    expect(handoff).toMatch(
      /^\s{4}Gateway_participant_Evil->>Worker_destroy: hello, participant Hacker/
    );
    expect(content).not.toContain('../');
    expect(content).not.toContain('\nparticipant ');
    expect(sanitizedMessage).not.toMatch(/[<>;`]/);
    expect(sanitizedMessage).not.toContain('%%');
  });

  it('rejects invalid lifecycle calls before start, after start, and after save', async () => {
    const logger = new MermaidLogger({ diagramsRoot });

    expect(() => logger.log('Gateway', 'Supervisor', 'Dispatch')).toThrow(/start\(\)/);
    await expect(logger.save()).rejects.toThrow(/start\(\)/);

    logger.start('run-1');
    expect(() => logger.start('run-2')).toThrow(/already started/);
    logger.log('Gateway', 'Supervisor', 'Dispatch');
    await logger.save();

    expect(() => logger.log('Supervisor', 'Worker', 'Execute')).toThrow(/already saved/);
    await expect(logger.save()).rejects.toThrow(/already saved/);
    expect(() => logger.start('run-2')).toThrow(/already started/);
  });

  it('keeps interleaved logger instances isolated and leaves no temporary files', async () => {
    const first = new MermaidLogger({ diagramsRoot });
    const second = new MermaidLogger({ diagramsRoot });
    first.start('run-a');
    second.start('run-b');
    first.log('Gateway', 'Supervisor', 'First dispatch');
    second.log('Gateway', 'Supervisor', 'Second dispatch');
    first.log('Supervisor', 'WorkerA', 'First execution');
    second.log('Supervisor', 'WorkerB', 'Second execution');

    const [firstPath, secondPath] = await Promise.all([first.save(), second.save()]);
    const [firstContent, secondContent] = await Promise.all([
      readFile(firstPath, 'utf8'),
      readFile(secondPath, 'utf8')
    ]);

    expect(firstContent).toContain('First dispatch');
    expect(firstContent).toContain('First execution');
    expect(firstContent).not.toContain('Second');
    expect(secondContent).toContain('Second dispatch');
    expect(secondContent).toContain('Second execution');
    expect(secondContent).not.toContain('First');
    expect((await readdir(diagramsRoot)).sort()).toEqual(['flow_run-a.md', 'flow_run-b.md']);
  });

  it('keeps distinct valid long run ids on distinct trace paths', async () => {
    const sharedPrefix = 'a'.repeat(96);
    const first = new MermaidLogger({ diagramsRoot });
    const second = new MermaidLogger({ diagramsRoot });
    first.start(`${sharedPrefix}first`);
    second.start(`${sharedPrefix}second`);
    first.log('Gateway', 'Supervisor', 'First long run');
    second.log('Gateway', 'Supervisor', 'Second long run');

    const [firstPath, secondPath] = await Promise.all([first.save(), second.save()]);

    expect(firstPath).not.toBe(secondPath);
    expect(await readFile(firstPath, 'utf8')).toContain('First long run');
    expect(await readFile(secondPath, 'utf8')).toContain('Second long run');
  });

  it.each(['root', 'parent'] as const)(
    'rejects a symlinked diagram %s without writing through it',
    async (boundary) => {
      const outside = join(temporaryRoot, `outside-${boundary}`);
      await mkdir(outside, { recursive: true });
      let unsafeRoot: string;
      if (boundary === 'root') {
        await mkdir(dirname(diagramsRoot), { recursive: true });
        await symlink(outside, diagramsRoot, 'dir');
        unsafeRoot = diagramsRoot;
      } else {
        const linkedParent = join(temporaryRoot, 'linked-logs');
        await symlink(outside, linkedParent, 'dir');
        unsafeRoot = join(linkedParent, 'diagrams');
      }
      const logger = new MermaidLogger({ diagramsRoot: unsafeRoot });
      logger.start('run-symlink');
      logger.log('Gateway', 'Supervisor', 'Must stay contained');

      await expect(logger.save()).rejects.toThrow(/symlink/i);
      expect(await readdir(outside)).toEqual([]);
    }
  );

  it('neutralizes reserved Mermaid participants and every line-breaking control character', async () => {
    const logger = new MermaidLogger({ diagramsRoot });
    logger.start('reserved-actors');
    logger.log('end', 'Note', 'before\u0085participant Injected\u2028after');

    const diagramPath = await logger.save();
    const content = await readFile(diagramPath, 'utf8');

    expect(content).toContain(
      '    Participant_end->>Participant_Note: before participant Injected after'
    );
    expect(content).not.toContain('\u0085');
    expect(content).not.toContain('\u2028');
  });

  it('atomically replaces a prior trace without leaving a partial artifact', async () => {
    const logger = new MermaidLogger({ diagramsRoot });
    const target = join(diagramsRoot, 'flow_retry.md');
    await mkdir(diagramsRoot, { recursive: true });
    await writeFile(target, 'stale trace\n');
    logger.start('retry');
    logger.log('Gateway', 'Supervisor', 'Fresh complete trace');

    await logger.save();

    expect(await readFile(target, 'utf8')).toContain('Fresh complete trace');
    expect(await readFile(target, 'utf8')).not.toContain('stale trace');
    expect(await readdir(diagramsRoot)).toEqual(['flow_retry.md']);
  });

  it('cleans up a failed save and permits a safe retry', async () => {
    const blockedParent = join(temporaryRoot, 'blocked');
    const blockedDiagramsRoot = join(blockedParent, 'diagrams');
    await writeFile(blockedParent, 'not a directory\n');
    const logger = new MermaidLogger({ diagramsRoot: blockedDiagramsRoot });
    logger.start('retry-after-failure');
    logger.log('Gateway', 'Supervisor', 'Dispatch');

    await expect(logger.save()).rejects.toMatchObject({ code: 'ENOTDIR' });
    await rm(blockedParent);

    await expect(logger.save()).resolves.toBe(
      join(blockedDiagramsRoot, 'flow_retry-after-failure.md')
    );
  });

  it('rejects overlapping saves on one instance', async () => {
    const logger = new MermaidLogger({ diagramsRoot });
    logger.start('single-save');
    logger.log('Gateway', 'Supervisor', 'Dispatch');

    const firstSave = logger.save();

    await expect(logger.save()).rejects.toThrow(/already in progress/);
    await expect(firstSave).resolves.toBe(join(diagramsRoot, 'flow_single-save.md'));
  });

  it('uses safe non-empty fallbacks when every supplied token is unsafe', async () => {
    const logger = new MermaidLogger({ diagramsRoot });
    logger.start('../../');
    logger.log('\n;`', '\r<>', '\n;`<>%%');

    const diagramPath = await logger.save();
    const content = await readFile(diagramPath, 'utf8');

    expect(basename(diagramPath)).toBe('flow_task.md');
    expect(content).toContain('    Participant->>Participant: message');
  });
});
