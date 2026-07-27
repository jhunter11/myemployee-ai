import type SQLite from 'better-sqlite3';

import {
  ActionDecisionSchema,
  ActionProposalSchema,
  type ActionDecision,
  type ActionProposal
} from './action-proposal-contracts';

interface ProposalRow {
  id: string;
  source_id: string;
  principal_id: string;
  channel: string;
  scope_id: string;
  tenant_id: string | null;
  policy_version: number;
  kind: string;
  payload_digest: string;
  reversible: number;
  external_effect: number;
  risk: string;
  state: string;
  version: number;
  confirmation_fingerprint: string;
  created_at: string;
  expires_at: string;
  updated_at: string;
}

function proposalFromRow(row: ProposalRow): ActionProposal {
  return ActionProposalSchema.parse({
    id: row.id,
    version: row.version,
    expectedVersion: row.version,
    sourceId: row.source_id,
    principalId: row.principal_id,
    channel: row.channel,
    scopeId: row.scope_id,
    tenantId: row.tenant_id,
    policyVersion: row.policy_version,
    kind: row.kind,
    payloadDigest: row.payload_digest,
    reversible: Boolean(row.reversible),
    externalEffect: Boolean(row.external_effect),
    risk: row.risk,
    state: row.state,
    confirmationFingerprint: row.confirmation_fingerprint,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    updatedAt: row.updated_at
  });
}

function sameProposal(left: ActionProposal, right: ActionProposal): boolean {
  return (
    left.id === right.id &&
    left.scopeId === right.scopeId &&
    left.tenantId === right.tenantId &&
    left.policyVersion === right.policyVersion &&
    left.kind === right.kind &&
    left.payloadDigest === right.payloadDigest &&
    left.reversible === right.reversible &&
    left.externalEffect === right.externalEffect &&
    left.risk === right.risk
  );
}

export class SqliteActionProposalRepository {
  constructor(private readonly sqlite: SQLite.Database) {}

  createOrGet(input: ActionProposal): Promise<ActionProposal> {
    const proposal = ActionProposalSchema.parse(input);
    const result = this.sqlite.transaction(() => {
      const existing = this.sqlite
        .prepare(
          `SELECT * FROM action_proposals
           WHERE principal_id = ? AND channel = ? AND source_id = ?`
        )
        .get(proposal.principalId, proposal.channel, proposal.sourceId) as ProposalRow | undefined;
      if (existing) {
        const stored = proposalFromRow(existing);
        if (!sameProposal(stored, proposal)) {
          throw new Error('source is already bound to a different proposal');
        }
        return stored;
      }
      this.sqlite
        .prepare(
          `INSERT INTO action_proposals (
             id, source_id, principal_id, channel, scope_id, tenant_id, policy_version,
             kind, payload_digest, reversible, external_effect, risk, state, version,
             confirmation_fingerprint, created_at, expires_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          proposal.id,
          proposal.sourceId,
          proposal.principalId,
          proposal.channel,
          proposal.scopeId,
          proposal.tenantId,
          proposal.policyVersion,
          proposal.kind,
          proposal.payloadDigest,
          Number(proposal.reversible),
          Number(proposal.externalEffect),
          proposal.risk,
          proposal.state,
          proposal.version,
          proposal.confirmationFingerprint,
          proposal.createdAt,
          proposal.expiresAt,
          proposal.updatedAt
        );
      return proposal;
    })();
    return Promise.resolve(result);
  }

  findById(id: string): Promise<ActionProposal | null> {
    const row = this.sqlite.prepare('SELECT * FROM action_proposals WHERE id = ?').get(id) as
      ProposalRow | undefined;
    return Promise.resolve(row ? proposalFromRow(row) : null);
  }

  listPending(input: {
    scopeId: string;
    tenantId: string | null;
    at: string;
  }): Promise<ActionProposal[]> {
    const rows = this.sqlite
      .prepare(
        `SELECT * FROM action_proposals
         WHERE scope_id = ?
           AND ((tenant_id IS NULL AND ? IS NULL) OR tenant_id = ?)
           AND state = 'pending'
           AND expires_at > ?
         ORDER BY created_at ASC, id ASC`
      )
      .all(input.scopeId, input.tenantId, input.tenantId, input.at) as ProposalRow[];
    return Promise.resolve(rows.map(proposalFromRow));
  }

  expire(input: { id: string; expectedVersion: number; at: string }): Promise<ActionProposal> {
    const result = this.sqlite
      .prepare(
        `UPDATE action_proposals
         SET state = 'expired', version = version + 1, updated_at = ?
         WHERE id = ? AND state = 'pending' AND version = ?`
      )
      .run(input.at, input.id, input.expectedVersion);
    if (result.changes !== 1) throw new Error('proposal expiry version conflict');
    return this.findById(input.id).then((proposal) => {
      if (!proposal) throw new Error('expired proposal disappeared');
      return proposal;
    });
  }

  decide(input: {
    proposalId: string;
    expectedVersion: number;
    verdict: 'approved' | 'rejected';
    decision: ActionDecision;
    afterDecision?: (decision: ActionDecision) => void;
  }): Promise<ActionDecision> {
    const decision = ActionDecisionSchema.parse(input.decision);
    const result = this.sqlite.transaction(() => {
      const update = this.sqlite
        .prepare(
          `UPDATE action_proposals
           SET state = ?, version = version + 1, updated_at = ?
           WHERE id = ? AND state = 'pending' AND version = ?`
        )
        .run(input.verdict, decision.decidedAt, input.proposalId, input.expectedVersion);
      if (update.changes !== 1) throw new Error('proposal decision version conflict');
      this.sqlite
        .prepare(
          `INSERT INTO action_proposal_decisions (
             id, proposal_id, principal_id, verdict, proposal_version, decided_at
           ) VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          decision.id,
          decision.proposalId,
          decision.principalId,
          decision.verdict,
          decision.proposalVersion,
          decision.decidedAt
        );
      input.afterDecision?.(decision);
      return decision;
    })();
    return Promise.resolve(result);
  }
}
