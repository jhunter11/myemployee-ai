import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import SQLite from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AgencyExecutionPostureService,
  SqliteAgencyExecutionPostureRepository,
  pauseRuntimePayloadDigest
} from '../../src/agency/execution-posture';
import { SqliteActionProposalRepository } from '../../src/commands/action-proposal-repository';
import { ActionProposalService } from '../../src/commands/action-proposal-service';

const projectRoot = join(__dirname, '..', '..');
const telegram = {
  version: 1 as const,
  id: 'principal:telegram_operator',
  kind: 'operator' as const,
  channel: 'telegram' as const,
  authority: ['read', 'propose'] as const
};
const operator = {
  version: 1 as const,
  id: 'principal:web_operator',
  kind: 'operator' as const,
  channel: 'web' as const,
  authority: ['read', 'approve'] as const
};
const personalBinding = {
  scopeId: 'personal:jarvis',
  trustDomain: 'personal' as const,
  tenantId: null,
  policyVersion: 1
};

describe('durable agency execution posture', () => {
  let sqlite: SQLite.Database;
  let posture: AgencyExecutionPostureService;
  let proposals: ActionProposalService;
  let proposalRepository: SqliteActionProposalRepository;

  beforeEach(async () => {
    sqlite = new SQLite(':memory:');
    sqlite.exec(
      await readFile(join(projectRoot, 'src/db/migrations/013_command_proposals.sql'), 'utf8')
    );
    sqlite.exec(
      await readFile(
        join(projectRoot, 'src/db/migrations/017_agency_execution_posture.sql'),
        'utf8'
      )
    );
    posture = new AgencyExecutionPostureService({
      repository: new SqliteAgencyExecutionPostureRepository(sqlite),
      now: () => '2026-07-21T18:00:00.000Z'
    });
    proposalRepository = new SqliteActionProposalRepository(sqlite);
    proposals = new ActionProposalService({
      repository: proposalRepository,
      now: () => '2026-07-21T18:00:00.000Z',
      onApproved: (input) => posture.applyApprovedProposal(input)
    });
  });

  afterEach(() => sqlite.close());

  it('bootstraps once and never lets a later startup overwrite durable posture', async () => {
    await posture.initialize('paused');
    await posture.initialize('active');

    await expect(posture.current()).resolves.toMatchObject({
      posture: 'paused',
      version: 1,
      updatedBy: 'system:bootstrap',
      sourceProposalId: null
    });
    await expect(posture.executionAllowed()).resolves.toBe(false);
    expect(
      sqlite.prepare('SELECT COUNT(*) AS count FROM agency_execution_posture_events').get()
    ).toEqual({ count: 1 });
  });

  it('atomically pauses only after exact approval and records bounded audit evidence', async () => {
    await posture.initialize('active');
    const proposal = await proposals.propose({
      principal: telegram,
      binding: personalBinding,
      request: {
        sourceId: 'telegram:update:0000000000000201',
        kind: 'pause_runtime',
        payloadDigest: pauseRuntimePayloadDigest(),
        reversible: true,
        externalEffect: false,
        expiresInSeconds: 300
      }
    });

    const decision = await proposals.decide({
      principal: operator,
      binding: personalBinding,
      request: {
        proposalId: proposal.id,
        verdict: 'approved',
        expectedVersion: proposal.version,
        confirmationFingerprint: proposal.confirmationFingerprint
      }
    });

    await expect(posture.current()).resolves.toMatchObject({
      posture: 'paused',
      version: 2,
      updatedBy: operator.id,
      sourceProposalId: proposal.id,
      sourceProposalVersion: decision.proposalVersion,
      sourceConfirmationFingerprint: proposal.confirmationFingerprint
    });
    await expect(posture.executionAllowed()).resolves.toBe(false);
    expect(
      sqlite
        .prepare(
          `SELECT from_posture, to_posture, actor_id, reason, source_proposal_id,
                  source_proposal_version, source_confirmation_fingerprint, source_decision_id
             FROM agency_execution_posture_events
            ORDER BY sequence DESC LIMIT 1`
        )
        .get()
    ).toEqual({
      from_posture: 'active',
      to_posture: 'paused',
      actor_id: operator.id,
      reason: 'approved_pause_runtime_proposal',
      source_proposal_id: proposal.id,
      source_proposal_version: 2,
      source_confirmation_fingerprint: proposal.confirmationFingerprint,
      source_decision_id: decision.id
    });
  });

  it('records a rejection without changing the live posture', async () => {
    await posture.initialize('active');
    const proposal = await proposals.propose({
      principal: telegram,
      binding: personalBinding,
      request: {
        sourceId: 'telegram:update:0000000000000202',
        kind: 'pause_runtime',
        payloadDigest: pauseRuntimePayloadDigest(),
        reversible: true,
        externalEffect: false,
        expiresInSeconds: 300
      }
    });

    await proposals.decide({
      principal: operator,
      binding: personalBinding,
      request: {
        proposalId: proposal.id,
        verdict: 'rejected',
        expectedVersion: proposal.version,
        confirmationFingerprint: proposal.confirmationFingerprint
      }
    });

    await expect(posture.current()).resolves.toMatchObject({ posture: 'active', version: 1 });
    expect(
      sqlite.prepare('SELECT COUNT(*) AS count FROM agency_execution_posture_events').get()
    ).toEqual({ count: 1 });
  });

  it('rolls back the approval if a pause proposal is not the canonical bounded action', async () => {
    await posture.initialize('active');
    const proposal = await proposals.propose({
      principal: telegram,
      binding: personalBinding,
      request: {
        sourceId: 'telegram:update:0000000000000203',
        kind: 'pause_runtime',
        payloadDigest: `sha256:${'f'.repeat(64)}`,
        reversible: true,
        externalEffect: false,
        expiresInSeconds: 300
      }
    });

    await expect(
      proposals.decide({
        principal: operator,
        binding: personalBinding,
        request: {
          proposalId: proposal.id,
          verdict: 'approved',
          expectedVersion: proposal.version,
          confirmationFingerprint: proposal.confirmationFingerprint
        }
      })
    ).rejects.toThrow('pause proposal payload is not canonical');

    await expect(proposalRepository.findById(proposal.id)).resolves.toMatchObject({
      state: 'pending',
      version: 1
    });
    await expect(posture.current()).resolves.toMatchObject({ posture: 'active', version: 1 });
  });
});
