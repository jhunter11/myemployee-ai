import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import SQLite from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ActionProposalService } from '../../src/commands/action-proposal-service';
import { SqliteActionProposalRepository } from '../../src/commands/action-proposal-repository';

const projectRoot = join(__dirname, '..', '..');
const operator = {
  version: 1 as const,
  id: 'principal:operator',
  kind: 'operator' as const,
  channel: 'web' as const,
  authority: ['read', 'propose', 'approve'] as const
};
const telegram = {
  ...operator,
  id: 'principal:telegram_operator',
  channel: 'telegram' as const,
  authority: ['read', 'propose'] as const
};
const binding = {
  scopeId: 'personal:jarvis',
  trustDomain: 'personal' as const,
  tenantId: null,
  policyVersion: 1
};

describe('action proposal service', () => {
  let sqlite: SQLite.Database;
  let repository: SqliteActionProposalRepository;
  let service: ActionProposalService;

  beforeEach(async () => {
    sqlite = new SQLite(':memory:');
    sqlite.exec(
      await readFile(join(projectRoot, 'src/db/migrations/013_command_proposals.sql'), 'utf8')
    );
    repository = new SqliteActionProposalRepository(sqlite);
    service = new ActionProposalService({
      repository,
      now: () => '2026-07-21T18:00:00.000Z'
    });
  });

  afterEach(() => sqlite.close());

  it('creates one payload-free, fingerprinted proposal bound to server principal and scope', async () => {
    const proposal = await service.propose({
      principal: telegram,
      binding,
      request: {
        sourceId: 'telegram:update:103',
        kind: 'pause_runtime',
        payloadDigest: `sha256:${'a'.repeat(64)}`,
        reversible: true,
        externalEffect: false,
        expiresInSeconds: 300
      }
    });

    expect(proposal).toMatchObject({
      version: 1,
      principalId: 'principal:telegram_operator',
      channel: 'telegram',
      scopeId: 'personal:jarvis',
      tenantId: null,
      kind: 'pause_runtime',
      state: 'pending',
      expectedVersion: 1,
      risk: 'medium',
      expiresAt: '2026-07-21T18:05:00.000Z'
    });
    expect(proposal.id).toMatch(/^proposal:[a-f0-9]{64}$/);
    expect(proposal.confirmationFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    const columns = sqlite
      .prepare('PRAGMA table_info(action_proposals)')
      .all()
      .map((row) => (row as { name: string }).name);
    expect(columns).not.toEqual(expect.arrayContaining(['payload', 'message', 'raw_text']));
  });

  it('is idempotent for the same source and fails closed on changed content', async () => {
    const input = {
      principal: telegram,
      binding,
      request: {
        sourceId: 'telegram:update:104',
        kind: 'pause_runtime' as const,
        payloadDigest: `sha256:${'b'.repeat(64)}`,
        reversible: true,
        externalEffect: false,
        expiresInSeconds: 300
      }
    };

    const first = await service.propose(input);
    await expect(service.propose(input)).resolves.toEqual(first);
    await expect(
      service.propose({
        ...input,
        request: { ...input.request, payloadDigest: `sha256:${'c'.repeat(64)}` }
      })
    ).rejects.toThrow('source is already bound to a different proposal');
  });

  it('requires an exact unexpired fingerprint, version, scope, and approval authority', async () => {
    const proposal = await service.propose({
      principal: telegram,
      binding,
      request: {
        sourceId: 'telegram:update:105',
        kind: 'pause_runtime',
        payloadDigest: `sha256:${'d'.repeat(64)}`,
        reversible: true,
        externalEffect: false,
        expiresInSeconds: 300
      }
    });

    await expect(
      service.decide({
        principal: telegram,
        binding,
        request: {
          proposalId: proposal.id,
          verdict: 'approved',
          expectedVersion: 1,
          confirmationFingerprint: proposal.confirmationFingerprint
        }
      })
    ).rejects.toThrow('principal lacks approval authority');

    await expect(
      service.decide({
        principal: operator,
        binding,
        request: {
          proposalId: proposal.id,
          verdict: 'approved',
          expectedVersion: 1,
          confirmationFingerprint: `sha256:${'e'.repeat(64)}`
        }
      })
    ).rejects.toThrow('confirmation fingerprint does not match');

    const decision = await service.decide({
      principal: operator,
      binding,
      request: {
        proposalId: proposal.id,
        verdict: 'approved',
        expectedVersion: 1,
        confirmationFingerprint: proposal.confirmationFingerprint
      }
    });

    expect(decision).toMatchObject({
      proposalId: proposal.id,
      principalId: 'principal:operator',
      verdict: 'approved',
      proposalVersion: 2
    });
    expect((await repository.findById(proposal.id))?.state).toBe('approved');
  });

  it('cannot approve an expired proposal or decide the same version twice', async () => {
    const expiringService = new ActionProposalService({
      repository,
      now: (() => {
        const times = [
          '2026-07-21T18:00:00.000Z',
          '2026-07-21T18:02:00.000Z',
          '2026-07-21T18:02:00.000Z'
        ];
        return () => times.shift() ?? '2026-07-21T18:02:00.000Z';
      })()
    });
    const proposal = await expiringService.propose({
      principal: telegram,
      binding,
      request: {
        sourceId: 'telegram:update:106',
        kind: 'pause_runtime',
        payloadDigest: `sha256:${'f'.repeat(64)}`,
        reversible: true,
        externalEffect: false,
        expiresInSeconds: 60
      }
    });

    await expect(
      expiringService.decide({
        principal: operator,
        binding,
        request: {
          proposalId: proposal.id,
          verdict: 'approved',
          expectedVersion: 1,
          confirmationFingerprint: proposal.confirmationFingerprint
        }
      })
    ).rejects.toThrow('proposal has expired');
    expect((await repository.findById(proposal.id))?.state).toBe('expired');
  });

  it('lists only unexpired pending proposals within the server-bound scope', async () => {
    const first = await service.propose({
      principal: telegram,
      binding,
      request: {
        sourceId: 'telegram:update:107',
        kind: 'pause_runtime',
        payloadDigest: `sha256:${'1'.repeat(64)}`,
        reversible: true,
        externalEffect: false,
        expiresInSeconds: 300
      }
    });
    const second = await service.propose({
      principal: telegram,
      binding,
      request: {
        sourceId: 'telegram:update:108',
        kind: 'memory_change',
        payloadDigest: `sha256:${'2'.repeat(64)}`,
        reversible: true,
        externalEffect: false,
        expiresInSeconds: 300
      }
    });
    await service.decide({
      principal: operator,
      binding,
      request: {
        proposalId: first.id,
        verdict: 'rejected',
        expectedVersion: first.version,
        confirmationFingerprint: first.confirmationFingerprint
      }
    });

    await expect(service.listPending({ principal: operator, binding })).resolves.toEqual([second]);
    await expect(
      service.listPending({
        principal: { ...operator, authority: ['approve'] },
        binding
      })
    ).rejects.toThrow('principal lacks read authority');
  });
});
