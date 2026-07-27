import { createHash } from 'node:crypto';

import type SQLite from 'better-sqlite3';
import { z } from 'zod';

import type { ActionDecision, ActionProposal } from '../commands/action-proposal-contracts';

const AgencyPostureSchema = z.enum(['active', 'paused']);
const AgencyExecutionPostureSchema = z.strictObject({
  posture: AgencyPostureSchema,
  version: z.number().int().min(1),
  updatedAt: z.iso.datetime(),
  updatedBy: z.string().trim().min(3).max(160),
  reason: z.string().trim().min(3).max(160),
  sourceProposalId: z
    .string()
    .regex(/^proposal:[a-f0-9]{64}$/)
    .nullable(),
  sourceProposalVersion: z.number().int().min(2).nullable(),
  sourceConfirmationFingerprint: z
    .string()
    .regex(/^sha256:[a-f0-9]{64}$/)
    .nullable(),
  sourceDecisionId: z
    .string()
    .regex(/^decision:[a-f0-9]{64}$/)
    .nullable()
});

export type AgencyPosture = z.infer<typeof AgencyPostureSchema>;
export type AgencyExecutionPosture = z.infer<typeof AgencyExecutionPostureSchema>;

export function parseAgencyInitialPosture(value: string): AgencyPosture {
  return AgencyPostureSchema.parse(value);
}

interface PostureRow {
  posture: string;
  version: number;
  updated_at: string;
  updated_by: string;
  reason: string;
  source_proposal_id: string | null;
  source_proposal_version: number | null;
  source_confirmation_fingerprint: string | null;
  source_decision_id: string | null;
}

function fromRow(row: PostureRow): AgencyExecutionPosture {
  return AgencyExecutionPostureSchema.parse({
    posture: row.posture,
    version: row.version,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
    reason: row.reason,
    sourceProposalId: row.source_proposal_id,
    sourceProposalVersion: row.source_proposal_version,
    sourceConfirmationFingerprint: row.source_confirmation_fingerprint,
    sourceDecisionId: row.source_decision_id
  });
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function pauseRuntimePayloadDigest(): string {
  return `sha256:${hash(JSON.stringify({ kind: 'pause_runtime' }))}`;
}

export class SqliteAgencyExecutionPostureRepository {
  constructor(private readonly sqlite: SQLite.Database) {}

  initialize(input: { posture: AgencyPosture; occurredAt: string }): AgencyExecutionPosture {
    const posture = AgencyPostureSchema.parse(input.posture);
    const occurredAt = z.iso.datetime().parse(input.occurredAt);
    return this.sqlite.transaction(() => {
      const inserted = this.sqlite
        .prepare(
          `INSERT OR IGNORE INTO agency_execution_posture (
             singleton_id, posture, version, updated_at, updated_by, reason,
             source_proposal_id, source_proposal_version,
             source_confirmation_fingerprint, source_decision_id
           ) VALUES ('agency', ?, 1, ?, 'system:bootstrap', 'runtime_state_initialized',
                     NULL, NULL, NULL, NULL)`
        )
        .run(posture, occurredAt);
      if (inserted.changes === 1) {
        this.sqlite
          .prepare(
            `INSERT INTO agency_execution_posture_events (
               event_id, from_posture, to_posture, resulting_version, actor_id, reason,
               source_proposal_id, source_proposal_version,
               source_confirmation_fingerprint, source_decision_id, occurred_at
             ) VALUES (?, NULL, ?, 1, 'system:bootstrap', 'runtime_state_initialized',
                       NULL, NULL, NULL, NULL, ?)`
          )
          .run(
            `posture-event:${hash(JSON.stringify(['bootstrap', posture, occurredAt]))}`,
            posture,
            occurredAt
          );
      }
      return this.readCurrent();
    })();
  }

  current(): Promise<AgencyExecutionPosture> {
    return Promise.resolve(this.readCurrent());
  }

  pauseForApprovedProposal(input: {
    proposal: ActionProposal;
    decision: ActionDecision;
  }): AgencyExecutionPosture {
    return this.sqlite.transaction(() => {
      const previous = this.readCurrent();
      const nextVersion = previous.version + 1;
      const update = this.sqlite
        .prepare(
          `UPDATE agency_execution_posture
              SET posture = 'paused', version = ?, updated_at = ?, updated_by = ?,
                  reason = 'approved_pause_runtime_proposal', source_proposal_id = ?,
                  source_proposal_version = ?, source_confirmation_fingerprint = ?,
                  source_decision_id = ?
            WHERE singleton_id = 'agency' AND version = ?`
        )
        .run(
          nextVersion,
          input.decision.decidedAt,
          input.decision.principalId,
          input.proposal.id,
          input.decision.proposalVersion,
          input.proposal.confirmationFingerprint,
          input.decision.id,
          previous.version
        );
      if (update.changes !== 1) throw new Error('agency posture version conflict');
      this.sqlite
        .prepare(
          `INSERT INTO agency_execution_posture_events (
             event_id, from_posture, to_posture, resulting_version, actor_id, reason,
             source_proposal_id, source_proposal_version,
             source_confirmation_fingerprint, source_decision_id, occurred_at
           ) VALUES (?, ?, 'paused', ?, ?, 'approved_pause_runtime_proposal', ?, ?, ?, ?, ?)`
        )
        .run(
          `posture-event:${hash(
            JSON.stringify([
              input.decision.id,
              input.proposal.id,
              input.decision.proposalVersion,
              input.proposal.confirmationFingerprint
            ])
          )}`,
          previous.posture,
          nextVersion,
          input.decision.principalId,
          input.proposal.id,
          input.decision.proposalVersion,
          input.proposal.confirmationFingerprint,
          input.decision.id,
          input.decision.decidedAt
        );
      return this.readCurrent();
    })();
  }

  private readCurrent(): AgencyExecutionPosture {
    const row = this.sqlite
      .prepare("SELECT * FROM agency_execution_posture WHERE singleton_id = 'agency'")
      .get() as PostureRow | undefined;
    if (!row) throw new Error('agency execution posture is not initialized');
    return fromRow(row);
  }
}

export class AgencyExecutionPostureService {
  private readonly now: () => string;
  private readonly approvalPrincipalId: string;

  constructor(
    private readonly options: {
      repository: SqliteAgencyExecutionPostureRepository;
      now?: () => string;
      approvalPrincipalId?: string;
    }
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.approvalPrincipalId = options.approvalPrincipalId ?? 'principal:web_operator';
  }

  initialize(initialPosture: AgencyPosture): Promise<AgencyExecutionPosture> {
    return Promise.resolve(
      this.options.repository.initialize({
        posture: initialPosture,
        occurredAt: new Date(this.now()).toISOString()
      })
    );
  }

  current(): Promise<AgencyExecutionPosture> {
    return this.options.repository.current();
  }

  async executionAllowed(): Promise<boolean> {
    return (await this.current()).posture === 'active';
  }

  applyApprovedProposal(input: { proposal: ActionProposal; decision: ActionDecision }): undefined {
    if (input.proposal.kind !== 'pause_runtime') return undefined;
    if (
      input.proposal.scopeId !== 'personal:jarvis' ||
      input.proposal.tenantId !== null ||
      input.proposal.policyVersion !== 1
    ) {
      throw new Error('pause proposal is outside the personal Jarvis control scope');
    }
    if (input.decision.principalId !== this.approvalPrincipalId) {
      throw new Error('pause proposal was not approved by the bound desktop operator');
    }
    if (
      input.proposal.payloadDigest !== pauseRuntimePayloadDigest() ||
      !input.proposal.reversible ||
      input.proposal.externalEffect
    ) {
      throw new Error('pause proposal payload is not canonical');
    }
    if (
      input.proposal.state !== 'pending' ||
      input.decision.verdict !== 'approved' ||
      input.decision.proposalId !== input.proposal.id ||
      input.decision.proposalVersion !== input.proposal.version + 1
    ) {
      throw new Error('pause proposal decision is not current and exact');
    }
    this.options.repository.pauseForApprovedProposal(input);
    return undefined;
  }
}
