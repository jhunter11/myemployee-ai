import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import SQLite from 'better-sqlite3';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CommandPrincipal, ServerScopeBinding } from '../../src/commands/contracts';
import { DelegationControlService } from '../../src/delegation/delegation-control-service';
import { SqliteDelegationRepository } from '../../src/delegation/delegation-repository';
import {
  DelegationEventStream,
  createDelegationSseHandler
} from '../../src/delegation/delegation-sse';

const projectRoot = join(__dirname, '..', '..');
const digest = `sha256:${'d'.repeat(64)}`;
const principal: CommandPrincipal = {
  version: 1 as const,
  id: 'principal:operator',
  kind: 'operator' as const,
  channel: 'local' as const,
  authority: ['read', 'execute_internal']
};
const personal: ServerScopeBinding = {
  scopeId: 'personal:jarvis',
  trustDomain: 'personal' as const,
  tenantId: null,
  policyVersion: 1
};

describe('bounded delegation SSE endpoint adapter', () => {
  let sqlite: SQLite.Database;
  let repository: SqliteDelegationRepository;
  let control: DelegationControlService;

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
    control = new DelegationControlService({
      repository,
      now: () => '2026-07-21T20:00:00.000Z',
      policy: { maxDepth: 4, maxFanOut: 4, maxAttempts: 3 }
    });
  });

  afterEach(() => {
    sqlite.close();
  });

  function app(lastBinding: ServerScopeBinding = personal) {
    const application = express();
    application.get(
      '/events',
      createDelegationSseHandler({
        stream: new DelegationEventStream({ repository }),
        authorize: () => Promise.resolve({ principal, binding: lastBinding }),
        maxEvents: 1
      })
    );
    application.use(
      (
        error: { statusCode?: number; message?: string },
        _request: express.Request,
        response: express.Response,
        next: express.NextFunction
      ) => {
        void next;
        response.status(error.statusCode ?? 500).json({ error: error.message ?? 'failed' });
      }
    );
    return application;
  }

  it('emits one bounded payload-free batch and resumes after Last-Event-ID', async () => {
    const root = await control.createRoot({
      principal,
      binding: personal,
      request: {
        idempotencyKey: 'local:ssestreamroot001',
        assignedAgentId: 'jarvis',
        operationCode: 'coordinate_work',
        inputDigest: digest
      }
    });
    await control.startRun({
      principal,
      binding: personal,
      request: { runId: root.run.id, expectedVersion: 1 }
    });

    const first = await request(app()).get('/events').expect(200);
    expect(first.headers['content-type']).toMatch(/^text\/event-stream/iu);
    expect(first.headers['cache-control']).toBe('no-store');
    expect(first.text).toContain('retry: 5000');
    expect(first.text).toContain('id: 1');
    expect(first.text).toContain('event: delegation.run_queued');
    expect(first.text).not.toContain(digest);
    expect(first.text).not.toContain('tenant');

    const directBatch = await new DelegationEventStream({ repository }).read({
      principal,
      binding: personal,
      lastEventId: null,
      limit: 1
    });
    expect(directBatch).toMatchObject({ hasMore: true, nextEventId: '1' });

    const resumed = await request(app()).get('/events').set('Last-Event-ID', '1').expect(200);
    expect(resumed.text).not.toContain('id: 1\n');
    expect(resumed.text).toContain('id: 2');
    expect(resumed.text).toContain('event: delegation.run_started');
  });

  it('rejects caller-selected stream fields and malformed reconnect cursors', async () => {
    await request(app()).get('/events?scopeId=agency:evil').expect(400);
    await request(app()).get('/events').set('Last-Event-ID', '-1').expect(400);
    await request(app()).get('/events').set('Last-Event-ID', '1e3').expect(400);
    await request(app()).get('/events').set('Last-Event-ID', '9999999999999999999').expect(400);
    expect(() =>
      createDelegationSseHandler({
        stream: new DelegationEventStream({ repository }),
        authorize: () => Promise.resolve({ principal, binding: personal }),
        maxEvents: 0
      })
    ).toThrow();
  });

  it('uses only the injected authorization binding and returns no events across scopes', async () => {
    await control.createRoot({
      principal,
      binding: personal,
      request: {
        idempotencyKey: 'local:ssescope00000001',
        assignedAgentId: 'jarvis',
        operationCode: 'coordinate_work',
        inputDigest: digest
      }
    });
    const response = await request(
      app({
        scopeId: 'agency:control',
        trustDomain: 'agency',
        tenantId: 'acme_corp',
        policyVersion: 1
      })
    )
      .get('/events')
      .expect(200);

    expect(response.text).toBe('retry: 5000\n\n');
  });
});
