import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import SQLite from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DelegationControlService,
  authorizeDelegationContext,
  type DelegationControlPolicy
} from '../../src/delegation/delegation-control-service';
import { SqliteDelegationRepository } from '../../src/delegation/delegation-repository';
import { DelegationEventStream } from '../../src/delegation/delegation-sse';

const projectRoot = join(__dirname, '..', '..');
const now = '2026-07-21T20:00:00.000Z';
const digestA = `sha256:${'a'.repeat(64)}`;
const digestB = `sha256:${'b'.repeat(64)}`;
const digestC = `sha256:${'c'.repeat(64)}`;

const operator = {
  version: 1 as const,
  id: 'principal:operator',
  kind: 'operator' as const,
  channel: 'local' as const,
  authority: ['read', 'execute_internal'] as const
};
const personal = {
  scopeId: 'personal:jarvis',
  trustDomain: 'personal' as const,
  tenantId: null,
  policyVersion: 3
};
const agency = {
  scopeId: 'agency:control',
  trustDomain: 'agency' as const,
  tenantId: 'acme_corp',
  policyVersion: 7
};

function rootRequest(suffix = 'root000000000001') {
  return {
    idempotencyKey: `local:${suffix}`,
    assignedAgentId: 'jarvis',
    operationCode: 'coordinate_work',
    inputDigest: digestA
  };
}

describe('durable delegation control plane', () => {
  let sqlite: SQLite.Database;
  let repository: SqliteDelegationRepository;

  beforeEach(async () => {
    sqlite = new SQLite(':memory:');
    sqlite.pragma('foreign_keys = ON');
    sqlite.exec(
      await readFile(
        join(projectRoot, 'src', 'db', 'migrations', '015_delegation_traces.sql'),
        'utf8'
      )
    );
    repository = new SqliteDelegationRepository(sqlite);
  });

  afterEach(() => {
    sqlite.close();
  });

  function service(policy: Partial<DelegationControlPolicy> = {}): DelegationControlService {
    return new DelegationControlService({
      repository,
      now: () => now,
      policy: { maxDepth: 4, maxFanOut: 4, maxAttempts: 3, ...policy }
    });
  }

  it('creates a payload-free DAG, returns exact retries once, and exposes a bounded safe projection', async () => {
    const control = service();
    const first = await control.createRoot({
      principal: operator,
      binding: personal,
      request: rootRequest()
    });
    const replay = await control.createRoot({
      principal: operator,
      binding: personal,
      request: rootRequest()
    });
    const child = await control.delegate({
      principal: operator,
      binding: personal,
      request: {
        parentRunId: first.run.id,
        idempotencyKey: 'local:child00000000001',
        assignedAgentId: 'agency',
        operationCode: 'prepare_brief',
        inputDigest: digestB
      }
    });

    expect(first.replayed).toBe(false);
    expect(replay).toEqual({ ...first, replayed: true });
    expect(child.run).toMatchObject({
      rootRunId: first.run.id,
      parentRunId: first.run.id,
      depth: 1,
      attempt: 1,
      status: 'queued'
    });

    const snapshot = await control.snapshot({
      principal: operator,
      binding: personal,
      rootRunId: first.run.id,
      limit: 20
    });
    expect(snapshot).toMatchObject({
      rootRunId: first.run.id,
      truncated: false,
      statusCounts: { queued: 2 },
      nodes: [
        { id: first.run.id, parentRunId: null, childCount: 1 },
        { id: child.run.id, parentRunId: first.run.id, childCount: 0 }
      ]
    });
    expect(JSON.stringify(snapshot)).not.toContain(digestA);
    expect(JSON.stringify(snapshot)).not.toContain('idempotencyKey');
    expect(JSON.stringify(snapshot)).not.toContain('tenantId');

    await expect(
      control.createRoot({
        principal: operator,
        binding: personal,
        request: { ...rootRequest(), inputDigest: digestC }
      })
    ).rejects.toThrow(/idempotency key.*different/iu);
  });

  it('fails closed on cycles, configured depth, and configured fan-out', async () => {
    const control = service({ maxDepth: 1, maxFanOut: 1 });
    const root = await control.createRoot({
      principal: operator,
      binding: personal,
      request: rootRequest('topology00000001')
    });
    const child = await control.delegate({
      principal: operator,
      binding: personal,
      request: {
        parentRunId: root.run.id,
        idempotencyKey: 'local:topologychild001',
        assignedAgentId: 'agency',
        operationCode: 'review_plan',
        inputDigest: digestB
      }
    });

    await expect(
      control.delegate({
        principal: operator,
        binding: personal,
        request: {
          parentRunId: child.run.id,
          ...rootRequest('topology00000001')
        }
      })
    ).rejects.toThrow(/cycle/iu);

    await expect(
      control.delegate({
        principal: operator,
        binding: personal,
        request: {
          parentRunId: child.run.id,
          idempotencyKey: 'local:too_deep00000001',
          assignedAgentId: 'agency-reviewer',
          operationCode: 'red_team',
          inputDigest: digestC
        }
      })
    ).rejects.toThrow(/depth/iu);

    await expect(
      control.delegate({
        principal: operator,
        binding: personal,
        request: {
          parentRunId: root.run.id,
          idempotencyKey: 'local:fanout0000000001',
          assignedAgentId: 'agency-reviewer',
          operationCode: 'second_child',
          inputDigest: digestC
        }
      })
    ).rejects.toThrow(/fan-out/iu);
  });

  it('applies versioned transitions and deterministic bounded retries', async () => {
    const control = service({ maxAttempts: 2 });
    const root = await control.createRoot({
      principal: operator,
      binding: personal,
      request: rootRequest('retryroot00000001')
    });
    const running = await control.startRun({
      principal: operator,
      binding: personal,
      request: { runId: root.run.id, expectedVersion: 1 }
    });
    const failed = await control.finishRun({
      principal: operator,
      binding: personal,
      request: {
        runId: running.id,
        expectedVersion: 2,
        outcome: 'failed',
        resultCode: 'dependency_unavailable',
        evidenceDigest: digestB
      }
    });
    const retried = await control.retryRun({
      principal: operator,
      binding: personal,
      request: {
        runId: failed.id,
        expectedVersion: 3,
        idempotencyKey: 'local:retryattempt00001'
      }
    });
    const replay = await control.retryRun({
      principal: operator,
      binding: personal,
      request: {
        runId: failed.id,
        expectedVersion: 3,
        idempotencyKey: 'local:retryattempt00001'
      }
    });

    expect(retried.run).toMatchObject({
      parentRunId: failed.id,
      retryOfRunId: failed.id,
      attempt: 2,
      status: 'queued'
    });
    expect(replay).toEqual({ ...retried, replayed: true });

    const secondRunning = await control.startRun({
      principal: operator,
      binding: personal,
      request: { runId: retried.run.id, expectedVersion: 1 }
    });
    const secondFailure = await control.finishRun({
      principal: operator,
      binding: personal,
      request: {
        runId: secondRunning.id,
        expectedVersion: 2,
        outcome: 'failed',
        resultCode: 'still_unavailable',
        evidenceDigest: digestC
      }
    });

    await expect(
      control.retryRun({
        principal: operator,
        binding: personal,
        request: {
          runId: secondFailure.id,
          expectedVersion: 3,
          idempotencyKey: 'local:retryattempt00002'
        }
      })
    ).rejects.toThrow(/attempt limit/iu);
    await expect(
      control.startRun({
        principal: operator,
        binding: personal,
        request: { runId: root.run.id, expectedVersion: 1 }
      })
    ).rejects.toThrow(/version|state/iu);
  });

  it('propagates cancellation through non-terminal descendants and never rewrites terminal work', async () => {
    const control = service();
    const root = await control.createRoot({
      principal: operator,
      binding: personal,
      request: rootRequest('cancelroot0000001')
    });
    await control.startRun({
      principal: operator,
      binding: personal,
      request: { runId: root.run.id, expectedVersion: 1 }
    });
    const child = await control.delegate({
      principal: operator,
      binding: personal,
      request: {
        parentRunId: root.run.id,
        idempotencyKey: 'local:cancelchild000001',
        assignedAgentId: 'agency',
        operationCode: 'draft_work',
        inputDigest: digestB
      }
    });
    await control.startRun({
      principal: operator,
      binding: personal,
      request: { runId: child.run.id, expectedVersion: 1 }
    });
    const terminal = await control.delegate({
      principal: operator,
      binding: personal,
      request: {
        parentRunId: root.run.id,
        idempotencyKey: 'local:terminalchild0001',
        assignedAgentId: 'agency-reviewer',
        operationCode: 'safe_review',
        inputDigest: digestC
      }
    });
    await control.startRun({
      principal: operator,
      binding: personal,
      request: { runId: terminal.run.id, expectedVersion: 1 }
    });
    await control.finishRun({
      principal: operator,
      binding: personal,
      request: {
        runId: terminal.run.id,
        expectedVersion: 2,
        outcome: 'succeeded',
        resultCode: 'review_complete',
        evidenceDigest: digestA
      }
    });
    const grandchild = await control.delegate({
      principal: operator,
      binding: personal,
      request: {
        parentRunId: child.run.id,
        idempotencyKey: 'local:cancelgrand000001',
        assignedAgentId: 'agency-writer',
        operationCode: 'prepare_notes',
        inputDigest: digestA
      }
    });

    const cancelled = await control.requestCancellation({
      principal: operator,
      binding: personal,
      request: {
        runId: root.run.id,
        expectedVersion: 2,
        reasonCode: 'operator_stop'
      }
    });
    expect(cancelled.changedRunIds).toEqual([root.run.id, child.run.id, grandchild.run.id]);
    expect(cancelled.states).toEqual({ cancel_requested: 2, cancelled: 1 });

    const snapshot = await control.snapshot({
      principal: operator,
      binding: personal,
      rootRunId: root.run.id,
      limit: 20
    });
    expect(snapshot.statusCounts).toMatchObject({
      cancel_requested: 2,
      cancelled: 1,
      succeeded: 1
    });

    const acknowledged = await control.acknowledgeCancellation({
      principal: operator,
      binding: personal,
      request: { runId: child.run.id, expectedVersion: 3 }
    });
    expect(acknowledged.status).toBe('cancelled');

    const second = await control.requestCancellation({
      principal: operator,
      binding: personal,
      request: {
        runId: root.run.id,
        expectedVersion: 3,
        reasonCode: 'operator_stop'
      }
    });
    expect(second.changedRunIds).toEqual([]);
  });

  it('records immutable completed spans idempotently and protects append-only evidence in SQLite', async () => {
    const control = service();
    const root = await control.createRoot({
      principal: operator,
      binding: personal,
      request: rootRequest('spanroot000000001')
    });
    const input = {
      principal: operator,
      binding: personal,
      request: {
        runId: root.run.id,
        idempotencyKey: 'local:spanrecord0000001',
        parentSpanId: null,
        kind: 'agent' as const,
        nameCode: 'profile_reasoning',
        outcome: 'succeeded' as const,
        startedAt: '2026-07-21T19:59:58.000Z',
        endedAt: '2026-07-21T19:59:59.250Z',
        evidenceDigest: digestB
      }
    };
    const first = await control.recordSpan(input);
    const replay = await control.recordSpan(input);

    expect(first).toMatchObject({ durationMs: 1_250, replayed: false });
    expect(replay).toEqual({ ...first, replayed: true });
    await expect(
      control.recordSpan({
        ...input,
        request: { ...input.request, outcome: 'failed' }
      })
    ).rejects.toThrow(/idempotency key.*different/iu);

    expect(() =>
      sqlite.prepare('UPDATE delegation_run_events SET event_code = ?').run('tampered')
    ).toThrow(/append-only/iu);
    expect(() => sqlite.prepare('DELETE FROM delegation_run_spans').run()).toThrow(/append-only/iu);
  });

  it('denies malformed authority, scope, policy, channels, and repository policy broadening', async () => {
    expect(() => service({ maxDepth: 0 })).toThrow(/maxDepth/iu);
    expect(() => service({ maxFanOut: 65 })).toThrow(/maxFanOut/iu);
    expect(() => service({ maxAttempts: Number.NaN })).toThrow(/maxAttempts/iu);
    expect(() =>
      authorizeDelegationContext({
        principal: { ...operator, kind: 'channel_adapter' },
        binding: personal,
        authority: 'execute_internal'
      })
    ).toThrow(/channel adapters/iu);
    expect(() =>
      authorizeDelegationContext({
        principal: operator,
        binding: { ...personal, scopeId: 'agency:wrong' },
        authority: 'read'
      })
    ).toThrow(/trust domain/iu);
    expect(() =>
      authorizeDelegationContext({
        principal: operator,
        binding: { ...personal, tenantId: 'acme_corp' },
        authority: 'read'
      })
    ).toThrow(/cannot bind a tenant/iu);
    expect(() =>
      authorizeDelegationContext({
        principal: operator,
        binding: {
          scopeId: 'mcp:task_market',
          trustDomain: 'mcp_x402',
          tenantId: null,
          policyVersion: 1
        },
        authority: 'read'
      })
    ).not.toThrow();
    expect(() =>
      authorizeDelegationContext({
        principal: operator,
        binding: {
          scopeId: 'harness:jarvis',
          trustDomain: 'system',
          tenantId: null,
          policyVersion: 1
        },
        authority: 'read'
      })
    ).not.toThrow();

    await expect(
      service().createRoot({
        principal: operator,
        binding: personal,
        request: { ...rootRequest('channelguard000001'), idempotencyKey: 'web:channelguard000001' }
      })
    ).rejects.toThrow(/channel/iu);

    const control = service();
    const root = await control.createRoot({
      principal: operator,
      binding: personal,
      request: rootRequest('policyroot0000001')
    });
    expect(() =>
      repository.createChild({
        run: {
          ...root.run,
          id: `run:${'e'.repeat(64)}`,
          parentRunId: root.run.id,
          depth: 1,
          idempotencyKey: 'local:policychild000001',
          requestDigest: digestC,
          maxFanOut: root.run.maxFanOut + 1
        },
        parentRunId: root.run.id,
        edgeKind: 'delegation',
        actorPrincipalId: operator.id,
        eventType: 'run_queued',
        eventCode: 'policy_probe'
      })
    ).toThrow(/cannot alter.*policy/iu);
  });

  it('rejects terminal-parent delegation, stale cancellation, invalid span ancestry, and oversized spans', async () => {
    const control = service();
    const root = await control.createRoot({
      principal: operator,
      binding: personal,
      request: rootRequest('edgeguards0000001')
    });
    await control.startRun({
      principal: operator,
      binding: personal,
      request: { runId: root.run.id, expectedVersion: 1 }
    });
    await control.finishRun({
      principal: operator,
      binding: personal,
      request: {
        runId: root.run.id,
        expectedVersion: 2,
        outcome: 'succeeded',
        resultCode: 'work_complete',
        evidenceDigest: null
      }
    });
    await expect(
      control.delegate({
        principal: operator,
        binding: personal,
        request: {
          parentRunId: root.run.id,
          idempotencyKey: 'local:terminalguard0001',
          assignedAgentId: 'agency',
          operationCode: 'late_work',
          inputDigest: digestB
        }
      })
    ).rejects.toThrow(/parent state/iu);
    await expect(
      control.requestCancellation({
        principal: operator,
        binding: personal,
        request: { runId: root.run.id, expectedVersion: 2, reasonCode: 'stale_stop' }
      })
    ).rejects.toThrow(/version/iu);
    await expect(
      control.recordSpan({
        principal: operator,
        binding: personal,
        request: {
          runId: root.run.id,
          idempotencyKey: 'local:badparentspan0001',
          parentSpanId: `span:${'f'.repeat(64)}`,
          kind: 'review',
          nameCode: 'late_review',
          outcome: 'failed',
          startedAt: '2026-07-21T19:59:58.000Z',
          endedAt: '2026-07-21T19:59:59.000Z',
          evidenceDigest: null
        }
      })
    ).rejects.toThrow(/parent span/iu);
    await expect(
      control.recordSpan({
        principal: operator,
        binding: personal,
        request: {
          runId: root.run.id,
          idempotencyKey: 'local:oversizespan00001',
          parentSpanId: null,
          kind: 'system',
          nameCode: 'oversize_span',
          outcome: 'failed',
          startedAt: '2026-07-20T00:00:00.000Z',
          endedAt: '2026-07-22T00:00:00.000Z',
          evidenceDigest: null
        }
      })
    ).rejects.toThrow(/duration/iu);
  });

  it('isolates projections and per-scope stream cursors by the authenticated server binding', async () => {
    const control = service();
    const personalRun = await control.createRoot({
      principal: operator,
      binding: personal,
      request: rootRequest('personalstream001')
    });
    const agencyRun = await control.createRoot({
      principal: operator,
      binding: agency,
      request: rootRequest('agencystream0001')
    });
    const stream = new DelegationEventStream({ repository });

    const personalBatch = await stream.read({
      principal: operator,
      binding: personal,
      lastEventId: null,
      limit: 10
    });
    const agencyBatch = await stream.read({
      principal: operator,
      binding: agency,
      lastEventId: null,
      limit: 10
    });
    expect(personalBatch.events).toMatchObject([{ id: '1', runId: personalRun.run.id }]);
    expect(agencyBatch.events).toMatchObject([{ id: '1', runId: agencyRun.run.id }]);
    expect(JSON.stringify(personalBatch)).not.toContain(agencyRun.run.id);

    await expect(
      control.snapshot({
        principal: operator,
        binding: agency,
        rootRunId: personalRun.run.id,
        limit: 20
      })
    ).rejects.toThrow(/not found/iu);
    await expect(
      stream.read({
        principal: { ...operator, authority: ['execute_internal'] },
        binding: personal,
        lastEventId: null,
        limit: 10
      })
    ).rejects.toThrow(/read authority/iu);
  });
});
