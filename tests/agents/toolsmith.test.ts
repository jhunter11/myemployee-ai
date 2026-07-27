import { describe, expect, it, vi } from 'vitest';

import { ToolSmith, type FrequencyReader } from '../../src/agents/toolsmith';
import type { TaskFrequencyRecord } from '../../src/db/task-frequency-repository';

function frequencyRecord(taskSignature: string, executionCount: number): TaskFrequencyRecord {
  return {
    id: 1,
    taskSignature,
    executionCount,
    avgDurationSeconds: 2.5,
    lastExecutedAt: '2026-07-18T15:00:00.000Z',
    manualInterventionCount: 1
  };
}

describe('ToolSmith', () => {
  it('queries the default five-execution threshold and returns no proposal below it', async () => {
    const findAtOrAbove = vi.fn(() => Promise.resolve([]));
    const frequency: FrequencyReader = {
      findAtOrAbove
    };
    const toolsmith = new ToolSmith({ frequency });

    await expect(toolsmith.analyze()).resolves.toEqual([]);
    expect(findAtOrAbove).toHaveBeenCalledWith(5, 10);
  });

  it('creates deterministic proposal-only 5-d-build payloads at the threshold', async () => {
    const frequency: FrequencyReader = {
      findAtOrAbove: () =>
        Promise.resolve([
          frequencyRecord('acme_corp:daily-report', 8),
          frequencyRecord('alpha:cleanup', 5)
        ])
    };
    const toolsmith = new ToolSmith({ frequency });

    await expect(toolsmith.analyze()).resolves.toEqual([
      {
        kind: 'autonomous_pr_simulation',
        mode: 'proposal_only',
        skill: '5-d-build',
        taskSignature: 'acme_corp:daily-report',
        executionCount: 8,
        payload: {
          objective: 'Automate repeated task: acme_corp:daily-report',
          evidence: {
            executionCount: 8,
            averageDurationSeconds: 2.5,
            manualInterventionCount: 1,
            lastExecutedAt: '2026-07-18T15:00:00.000Z'
          }
        }
      },
      {
        kind: 'autonomous_pr_simulation',
        mode: 'proposal_only',
        skill: '5-d-build',
        taskSignature: 'alpha:cleanup',
        executionCount: 5,
        payload: {
          objective: 'Automate repeated task: alpha:cleanup',
          evidence: {
            executionCount: 5,
            averageDurationSeconds: 2.5,
            manualInterventionCount: 1,
            lastExecutedAt: '2026-07-18T15:00:00.000Z'
          }
        }
      }
    ]);
  });

  it.each([0, -1, 1.5, Number.POSITIVE_INFINITY])('rejects invalid threshold %s', (threshold) => {
    expect(
      () =>
        new ToolSmith({
          frequency: { findAtOrAbove: () => Promise.resolve([]) },
          threshold
        })
    ).toThrow(RangeError);
  });

  it('uses a configurable bounded proposal limit', async () => {
    const findAtOrAbove = vi.fn(() => Promise.resolve([]));
    const toolsmith = new ToolSmith({
      frequency: { findAtOrAbove },
      proposalLimit: 2
    });

    await toolsmith.analyze();

    expect(findAtOrAbove).toHaveBeenCalledWith(5, 2);
  });

  it.each([0, -1, 1.5, 101])('rejects invalid proposal limit %s', (proposalLimit) => {
    expect(
      () =>
        new ToolSmith({
          frequency: { findAtOrAbove: () => Promise.resolve([]) },
          proposalLimit
        })
    ).toThrow(RangeError);
  });
});
