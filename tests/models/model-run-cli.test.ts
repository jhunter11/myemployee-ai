import { describe, expect, it } from 'vitest';

import {
  runModelRunCli,
  type ModelRunCliDeps,
  type ModelRunTurnParams
} from '../../src/models/model-run-cli';

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: { stdout: (m: string) => out.push(m), stderr: (m: string) => err.push(m) }
  };
}

function recordingDeps(outcome: unknown): { deps: ModelRunCliDeps; calls: ModelRunTurnParams[] } {
  const calls: ModelRunTurnParams[] = [];
  return {
    calls,
    deps: {
      runTurn(params) {
        calls.push(params);
        return Promise.resolve(outcome);
      }
    }
  };
}

const executedOutcome = {
  status: 'executed',
  tier: 1,
  route: 'local',
  enablementVersion: 2,
  reasons: ['LOW_RISK_CONSTRAINED_WORK', 'MODEL_EXECUTION_ENABLED'],
  execution: {
    status: 'succeeded',
    provider: 'ollama',
    usageEventId: 'model-usage:abc',
    result: { provider: 'ollama', model: 'qwen2.5-coder:7b', text: 'PONG' },
    attempts: [{ provider: 'ollama', status: 'succeeded', detail: 'ok' }]
  }
};

describe('model run CLI', () => {
  it('prints the summary and the model reply and exits 0 when a turn executes', async () => {
    const { deps, calls } = recordingDeps(executedOutcome);
    const { out, io } = capture();
    const code = await runModelRunCli(
      ['--message', 'Reply with PONG', '--route', 'local', '--db', '/tmp/x.sqlite'],
      io,
      deps
    );
    expect(code).toBe(0);
    const summary = JSON.parse(out[0] ?? '{}') as {
      status: string;
      route: string;
      execution: { provider: string; model: string };
    };
    expect(summary.status).toBe('executed');
    expect(summary.execution.provider).toBe('ollama');
    expect(summary.execution.model).toBe('qwen2.5-coder:7b');
    expect(out.at(-1)).toBe('PONG');

    // local preset resolves to a tier-1 route (summarization), never synthesis.
    expect(calls[0]?.route.workType).toBe('summarization');
    expect(calls[0]?.surface).toBe('automation');
    expect(calls[0]?.clientId).toBeNull();
  });

  it('maps the economy preset to synthesis work (tier 2)', async () => {
    const { deps, calls } = recordingDeps(executedOutcome);
    await runModelRunCli(['--message', 'hi', '--route', 'economy'], capture().io, deps);
    expect(calls[0]?.route.workType).toBe('synthesis');
    expect(calls[0]?.route.risk).toBe('low');
  });

  it('maps the frontier preset to high-risk work (tier 3)', async () => {
    const { deps, calls } = recordingDeps(executedOutcome);
    await runModelRunCli(['--message', 'hi', '--route', 'frontier'], capture().io, deps);
    expect(calls[0]?.route.workType).toBe('synthesis');
    expect(calls[0]?.route.risk).toBe('high');
  });

  it('emits a single JSON object including the reply under --json', async () => {
    const { deps } = recordingDeps(executedOutcome);
    const { out, io } = capture();
    await runModelRunCli(['--message', 'hi', '--json'], io, deps);
    expect(out).toHaveLength(1);
    const payload = JSON.parse(out[0] ?? '{}') as { reply: string; status: string };
    expect(payload.reply).toBe('PONG');
    expect(payload.status).toBe('executed');
  });

  it('exits 2 (not 0, not error) when the gate denies the turn', async () => {
    const denied = {
      status: 'denied',
      tier: 1,
      route: 'local',
      enablementVersion: 1,
      reasons: ['MODEL_EXECUTION_DISABLED']
    };
    const { deps } = recordingDeps(denied);
    const { out, io } = capture();
    const code = await runModelRunCli(['--message', 'hi'], io, deps);
    expect(code).toBe(2);
    const summary = JSON.parse(out[0] ?? '{}') as { status: string };
    expect(summary.status).toBe('denied');
    expect(out).toHaveLength(1); // no reply line
  });

  it('surfaces provider fall-through in the attempts list', async () => {
    const fellThrough = {
      status: 'executed',
      tier: 2,
      route: 'economy',
      enablementVersion: 3,
      reasons: ['AMBIGUOUS_OR_CODE_WORK', 'MODEL_EXECUTION_ENABLED'],
      execution: {
        status: 'succeeded',
        provider: 'ollama',
        usageEventId: 'model-usage:def',
        result: { provider: 'ollama', model: 'qwen3:8b', text: 'PONG' },
        attempts: [
          { provider: 'claude', status: 'failed', detail: 'auth: provider attempt failed' },
          { provider: 'ollama', status: 'succeeded', detail: 'ok' }
        ]
      }
    };
    const { deps } = recordingDeps(fellThrough);
    const { out, io } = capture();
    await runModelRunCli(['--message', 'hi', '--route', 'economy', '--json'], io, deps);
    const payload = JSON.parse(out[0] ?? '{}') as {
      execution: { attempts: { provider: string; status: string }[] };
    };
    expect(payload.execution.attempts.map((a) => `${a.provider}:${a.status}`)).toEqual([
      'claude:failed',
      'ollama:succeeded'
    ]);
  });

  it('fails closed with a structured error when --message is missing', async () => {
    const { deps } = recordingDeps(executedOutcome);
    const { err, io } = capture();
    const code = await runModelRunCli(['--route', 'local'], io, deps);
    expect(code).toBe(1);
    expect((JSON.parse(err[0] ?? '{}') as { error: { code: string } }).error.code).toBe(
      'MISSING_MESSAGE'
    );
  });

  it('rejects an invalid route preset and an over-limit output-token count', async () => {
    const { deps } = recordingDeps(executedOutcome);
    const badRoute = capture();
    expect(await runModelRunCli(['--message', 'hi', '--route', 'ultra'], badRoute.io, deps)).toBe(
      1
    );
    expect((JSON.parse(badRoute.err[0] ?? '{}') as { error: { code: string } }).error.code).toBe(
      'INVALID_ROUTE'
    );

    const badTokens = capture();
    expect(
      await runModelRunCli(['--message', 'hi', '--max-output-tokens', '999999'], badTokens.io, deps)
    ).toBe(1);
    expect((JSON.parse(badTokens.err[0] ?? '{}') as { error: { code: string } }).error.code).toBe(
      'INVALID_MAX_OUTPUT_TOKENS'
    );
  });
});
