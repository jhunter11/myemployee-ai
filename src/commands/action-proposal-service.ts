import { createHash } from 'node:crypto';

import {
  ActionDecisionRequestSchema,
  ActionDecisionSchema,
  ActionProposalRequestSchema,
  ActionProposalSchema,
  type ActionDecision,
  type ActionProposal
} from './action-proposal-contracts';
import type { SqliteActionProposalRepository } from './action-proposal-repository';
import { CommandPrincipalSchema, ServerScopeBindingSchema } from './contracts';

function hash(prefix: 'proposal' | 'decision' | 'sha256', value: string): string {
  return `${prefix}:${createHash('sha256').update(value).digest('hex')}`;
}

function risk(kind: string, externalEffect: boolean): 'low' | 'medium' | 'high' | 'critical' {
  if (externalEffect) return 'high';
  if (kind === 'create_queue_work') return 'low';
  return 'medium';
}

export class ActionProposalService {
  private readonly now: () => string;

  constructor(
    private readonly options: {
      repository: SqliteActionProposalRepository;
      now?: () => string;
      onApproved?: (input: { proposal: ActionProposal; decision: ActionDecision }) => undefined;
    }
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async propose(input: {
    principal: unknown;
    binding: unknown;
    request: unknown;
  }): Promise<ActionProposal> {
    const principal = CommandPrincipalSchema.parse(input.principal);
    const binding = ServerScopeBindingSchema.parse(input.binding);
    const request = ActionProposalRequestSchema.parse(input.request);
    if (!principal.authority.includes('propose'))
      throw new Error('principal lacks proposal authority');
    const createdAt = new Date(this.now()).toISOString();
    const expiresAt = new Date(
      Date.parse(createdAt) + request.expiresInSeconds * 1_000
    ).toISOString();
    const core = {
      principalId: principal.id,
      channel: principal.channel,
      scopeId: binding.scopeId,
      tenantId: binding.tenantId,
      policyVersion: binding.policyVersion,
      sourceId: request.sourceId,
      kind: request.kind,
      payloadDigest: request.payloadDigest,
      reversible: request.reversible,
      externalEffect: request.externalEffect,
      risk: risk(request.kind, request.externalEffect)
    };
    const id = hash('proposal', JSON.stringify(core));
    const confirmationFingerprint = hash(
      'sha256',
      JSON.stringify({ ...core, id, createdAt, expiresAt })
    );
    return this.options.repository.createOrGet(
      ActionProposalSchema.parse({
        ...core,
        id,
        version: 1,
        expectedVersion: 1,
        state: 'pending',
        confirmationFingerprint,
        createdAt,
        expiresAt,
        updatedAt: createdAt
      })
    );
  }

  async listPending(input: { principal: unknown; binding: unknown }): Promise<ActionProposal[]> {
    const principal = CommandPrincipalSchema.parse(input.principal);
    const binding = ServerScopeBindingSchema.parse(input.binding);
    if (!principal.authority.includes('read')) throw new Error('principal lacks read authority');
    return this.options.repository.listPending({
      scopeId: binding.scopeId,
      tenantId: binding.tenantId,
      at: new Date(this.now()).toISOString()
    });
  }

  async decide(input: {
    principal: unknown;
    binding: unknown;
    request: unknown;
  }): Promise<ActionDecision> {
    const principal = CommandPrincipalSchema.parse(input.principal);
    const binding = ServerScopeBindingSchema.parse(input.binding);
    const request = ActionDecisionRequestSchema.parse(input.request);
    if (!principal.authority.includes('approve'))
      throw new Error('principal lacks approval authority');
    if (principal.kind === 'agent') throw new Error('agents cannot approve action proposals');
    const proposal = await this.options.repository.findById(request.proposalId);
    if (!proposal) throw new Error('proposal not found');
    if (
      proposal.scopeId !== binding.scopeId ||
      proposal.tenantId !== binding.tenantId ||
      proposal.policyVersion !== binding.policyVersion
    ) {
      throw new Error('approval binding does not match proposal scope');
    }
    const decidedAt = new Date(this.now()).toISOString();
    if (Date.parse(decidedAt) >= Date.parse(proposal.expiresAt)) {
      if (proposal.state === 'pending') {
        await this.options.repository.expire({
          id: proposal.id,
          expectedVersion: proposal.version,
          at: decidedAt
        });
      }
      throw new Error('proposal has expired');
    }
    if (proposal.state !== 'pending') throw new Error('proposal is no longer pending');
    if (proposal.version !== request.expectedVersion) throw new Error('proposal version conflict');
    if (proposal.confirmationFingerprint !== request.confirmationFingerprint) {
      throw new Error('confirmation fingerprint does not match');
    }
    const proposalVersion = proposal.version + 1;
    const decision = ActionDecisionSchema.parse({
      id: hash(
        'decision',
        JSON.stringify({
          proposalId: proposal.id,
          principalId: principal.id,
          verdict: request.verdict,
          proposalVersion,
          decidedAt
        })
      ),
      proposalId: proposal.id,
      principalId: principal.id,
      verdict: request.verdict,
      proposalVersion,
      decidedAt
    });
    return this.options.repository.decide({
      proposalId: proposal.id,
      expectedVersion: proposal.version,
      verdict: request.verdict,
      decision,
      ...(request.verdict === 'approved' && this.options.onApproved !== undefined
        ? {
            afterDecision: (approvedDecision: ActionDecision) =>
              this.options.onApproved?.({ proposal, decision: approvedDecision })
          }
        : {})
    });
  }
}
