import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WorkerRegistry } from '../../src/agents/worker-registry';
import { startServer, type StartedServer } from '../../src/gateway/server';

const projectRoot = join(__dirname, '..', '..');

describe('gateway Telegram lifecycle', () => {
  let temporaryRoot: string;
  let started: StartedServer | undefined;

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'jarvis-telegram-gateway-'));
  });

  afterEach(async () => {
    await started?.stop();
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  it('starts and drains the opt-in channel with its server-bound configuration', async () => {
    const runtime = {
      start: vi.fn(),
      stop: vi.fn(),
      settled: vi.fn().mockResolvedValue(undefined),
      pollOnce: vi.fn().mockResolvedValue({ received: 0, processed: 0 })
    };
    const telegramRuntimeFactory = vi.fn().mockResolvedValue(runtime);

    started = await startServer({
      projectRoot,
      databaseFile: join(temporaryRoot, 'jarvis.sqlite'),
      clientRoot: join(temporaryRoot, 'clients'),
      workspaceRoot: join(temporaryRoot, 'workspaces'),
      graphRoot: join(temporaryRoot, 'memory', 'graph'),
      workerRegistry: new WorkerRegistry(),
      host: '127.0.0.1',
      port: 0,
      monitoring: false,
      automationCycling: false,
      requestLog: () => undefined,
      telegram: {
        allowlist: { userId: 42, chatId: 84 },
        keychain: {
          service: 'com.aiagency.jarvis.telegram',
          account: 'bot-token'
        }
      },
      telegramRuntimeFactory
    });

    expect(telegramRuntimeFactory).toHaveBeenCalledOnce();
    const factoryInput: unknown = telegramRuntimeFactory.mock.calls[0]?.[0];
    expect(factoryInput).toMatchObject({
      allowlist: { userId: 42, chatId: 84 },
      keychain: {
        service: 'com.aiagency.jarvis.telegram',
        account: 'bot-token'
      }
    });
    expect(runtime.start).toHaveBeenCalledOnce();

    const active = started;
    started = undefined;
    await active.stop();

    expect(runtime.stop).toHaveBeenCalledOnce();
    expect(runtime.settled).toHaveBeenCalledOnce();
  });
});
