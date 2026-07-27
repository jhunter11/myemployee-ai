import { describe, expect, it, vi } from 'vitest';

import type { Worker, WorkerContext } from '../../src/agents/contracts';
import { WorkerRegistry } from '../../src/agents/worker-registry';

function createContext(): WorkerContext {
  return {
    clientId: 'acme_corp',
    automation: 'daily-report',
    runId: 'run-20260718-001',
    clientRoot: '/tmp/clients',
    clientDirectory: '/tmp/clients/acme_corp',
    memoryDirectory: '/tmp/clients/acme_corp/memory',
    input: { requestedBy: 'test' },
    toolPolicy: {
      description: 'Local data processing',
      tools_allow: ['read', 'write'],
      tools_deny: ['process'],
      requires_elevated_approval: false
    },
    networkPolicy: {
      mode: 'none',
      description: 'No network access'
    },
    logger: {
      start: vi.fn(),
      log: vi.fn(),
      save: vi.fn(() => Promise.resolve('/tmp/run.md'))
    }
  };
}

function createWorker(id = 'acme_corp:daily-report') {
  const execute = vi.fn((context: WorkerContext) =>
    Promise.resolve({
      clientId: context.clientId,
      automation: context.automation
    })
  );
  const worker: Worker = { id, execute };
  return { worker, execute };
}

describe('WorkerRegistry', () => {
  it('resolves and executes only the worker registered for the exact client/automation pair', async () => {
    const { worker, execute } = createWorker();
    const registry = new WorkerRegistry([
      { clientId: 'acme_corp', automation: 'daily-report', worker }
    ]);

    const resolved = registry.resolve('acme_corp', 'daily-report');
    const context = createContext();

    expect(resolved).toBe(worker);
    await expect(resolved.execute(context)).resolves.toEqual({
      clientId: 'acme_corp',
      automation: 'daily-report'
    });
    expect(execute).toHaveBeenCalledWith(context);
    expect(registry.has('acme_corp', 'daily-report')).toBe(true);
    expect(registry.has('acme_corp', 'missing-worker')).toBe(false);
    expect(registry.has('../acme_corp', 'daily-report')).toBe(false);
  });

  it.each([
    ['acme_corp', 'daily-reports'],
    ['another_client', 'daily-report'],
    ['../acme_corp', '../../daily-report']
  ])('returns a safe 404 for an unregistered exact pair (%s, %s)', (clientId, automation) => {
    const registry = new WorkerRegistry([
      {
        clientId: 'acme_corp',
        automation: 'daily-report',
        worker: createWorker().worker
      }
    ]);

    expect(() => registry.resolve(clientId, automation)).toThrowError(
      expect.objectContaining({
        statusCode: 404,
        code: 'AUTOMATION_NOT_FOUND',
        message: `Automation ${automation} is not registered for client ${clientId}`
      })
    );
  });

  it('rejects duplicate registrations instead of silently replacing the allowlisted worker', () => {
    const registry = new WorkerRegistry();
    const original = createWorker('original').worker;
    registry.register({ clientId: 'acme_corp', automation: 'daily-report', worker: original });

    expect(() =>
      registry.register({
        clientId: 'acme_corp',
        automation: 'daily-report',
        worker: createWorker('replacement').worker
      })
    ).toThrowError(expect.objectContaining({ statusCode: 409, code: 'WORKER_ALREADY_REGISTERED' }));
    expect(registry.resolve('acme_corp', 'daily-report')).toBe(original);
  });

  it('fails closed when static code attempts to register unsafe identifiers', () => {
    expect(
      () =>
        new WorkerRegistry([
          {
            clientId: '../acme_corp',
            automation: 'daily-report',
            worker: createWorker().worker
          }
        ])
    ).toThrowError(
      expect.objectContaining({ statusCode: 500, code: 'INVALID_WORKER_REGISTRATION' })
    );
  });

  it('rejects non-function transactional hooks on a static worker', () => {
    const invalidWorker = {
      ...createWorker().worker,
      commit: 'publish-without-a-function'
    } as unknown as Worker;

    expect(() =>
      new WorkerRegistry().register({
        clientId: 'acme_corp',
        automation: 'daily-report',
        worker: invalidWorker
      })
    ).toThrowError(
      expect.objectContaining({ statusCode: 500, code: 'INVALID_WORKER_REGISTRATION' })
    );
  });

  it('accepts only a complete execute/commit/rollback/release transaction lifecycle', () => {
    const transactionalWorker = {
      ...createWorker('transactional').worker,
      commit: vi.fn(() => Promise.resolve()),
      rollback: vi.fn(() => Promise.resolve()),
      release: vi.fn()
    } as Worker;
    const registry = new WorkerRegistry([
      {
        clientId: 'acme_corp',
        automation: 'daily-report',
        worker: transactionalWorker
      }
    ]);

    expect(registry.resolve('acme_corp', 'daily-report')).toBe(transactionalWorker);
  });

  it.each([
    ['commit only', { commit: vi.fn(() => Promise.resolve()) }],
    ['rollback only', { rollback: vi.fn(() => Promise.resolve()) }],
    ['release only', { release: vi.fn() }],
    [
      'commit and rollback without release',
      { commit: vi.fn(() => Promise.resolve()), rollback: vi.fn(() => Promise.resolve()) }
    ]
  ])('rejects a partial transactional hook set: %s', (_label, hooks) => {
    const invalidWorker = {
      ...createWorker().worker,
      ...hooks
    } as unknown as Worker;

    expect(() =>
      new WorkerRegistry().register({
        clientId: 'acme_corp',
        automation: 'daily-report',
        worker: invalidWorker
      })
    ).toThrowError(
      expect.objectContaining({ statusCode: 500, code: 'INVALID_WORKER_REGISTRATION' })
    );
  });
});
