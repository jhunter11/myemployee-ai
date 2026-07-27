import { describe, expect, it } from 'vitest';

import {
  AgentProfileCatalogSchema,
  AgentSleeveIdSchema,
  findAgentProfile,
  listAgentProfiles,
  projectAgentHierarchy,
  validateAgentProfiles,
  type AgentProfile
} from '../../src/agents/profile-catalog';
import {
  KnowledgeGraphPartitionSchema,
  KnowledgeScopeIdSchema
} from '../../src/knowledge/contracts';

function mutableCatalog(): AgentProfile[] {
  return structuredClone(listAgentProfiles()) as AgentProfile[];
}

function profile(catalog: AgentProfile[], id: string): AgentProfile {
  const result = catalog.find((candidate) => candidate.id === id);
  if (result === undefined) throw new Error(`Missing fixture profile ${id}`);
  return result;
}

describe('server-owned agent profile catalog', () => {
  it('installs the complete approved Jarvis, Agency, and MCP/x402 tree', () => {
    const profiles = listAgentProfiles();

    expect(profiles).toHaveLength(45);
    expect(profiles.map(({ id }) => id)).toEqual([
      'jarvis',
      'agency',
      'agency-chief-of-staff',
      'agency-developer',
      'agency-developer-architect',
      'agency-developer-code-blue',
      'agency-developer-code-red',
      'agency-developer-release-verifier',
      'agency-idea-generator',
      'agency-idea-blue',
      'agency-idea-red',
      'agency-opportunity-judge',
      'agency-growth',
      'agency-prospect-scout',
      'agency-offer-writer',
      'agency-outreach-reviewer',
      'agency-growth-verifier',
      'agency-delivery',
      'agency-workflow-mapper',
      'agency-automation-worker-template',
      'agency-delivery-reviewer',
      'agency-delivery-verifier',
      'agency-knowledge-improvement',
      'agency-memory-curator',
      'agency-toolsmith',
      'agency-knowledge-reviewer',
      'agency-evaluation-runner',
      'agency-finance',
      'agency-finance-analyst',
      'agency-finance-reviewer',
      'agency-finance-verifier',
      'agency-marketing',
      'agency-content-planner',
      'agency-marketing-reviewer',
      'agency-marketing-verifier',
      'mcp-x402',
      'mcp-x402-publisher',
      'mcp-x402-contract-red-team',
      'mcp-x402-seller-operator',
      'mcp-x402-deployment-security-gate',
      'mcp-x402-task-market-scout',
      'mcp-x402-candidate-analyst',
      'mcp-x402-submission-verifier',
      'mcp-x402-settlement-auditor',
      'mcp-x402-chain-reconciler'
    ]);

    expect(findAgentProfile('agency-developer-code-red')).toMatchObject({
      parentId: 'agency-developer',
      trustDomain: 'agency',
      lifecycle: 'template',
      runtimeMode: 'profile_only'
    });
    expect(findAgentProfile('mcp-x402')).toMatchObject({
      parentId: 'jarvis',
      trustDomain: 'task_market',
      lifecycle: 'durable'
    });
    expect(findAgentProfile('unknown-agent')).toBeUndefined();
  });

  it('keeps only the approved coordinators durable and lower roles as bounded templates', () => {
    const durable = listAgentProfiles()
      .filter(({ lifecycle }) => lifecycle === 'durable')
      .map(({ id }) => id);

    expect(durable).toEqual([
      'jarvis',
      'agency',
      'agency-developer',
      'agency-idea-generator',
      'agency-growth',
      'agency-delivery',
      'agency-knowledge-improvement',
      'agency-finance',
      'agency-marketing',
      'mcp-x402'
    ]);
    expect(
      listAgentProfiles()
        .filter(({ runtimeMode }) => runtimeMode === 'deterministic')
        .map(({ id }) => id)
    ).toEqual(['jarvis']);
  });

  it('gives every profile a complete continuation, scope, tool, output, and budget manifest', () => {
    for (const agent of listAgentProfiles()) {
      expect(agent.revision).toBeGreaterThan(0);
      expect(agent.purpose.trim()).not.toBe('');
      expect(agent.toolGrants.length).toBeGreaterThan(0);
      expect(agent.memory.scratchSleeveId).toBe(`agent:${agent.id}:scratch`);
      expect(agent.memory.readableSleeveIds.length).toBeGreaterThan(0);
      expect(KnowledgeScopeIdSchema.safeParse(agent.knowledge.scopeId).success).toBe(true);
      expect(KnowledgeGraphPartitionSchema.safeParse(agent.knowledge.partitionId).success).toBe(
        true
      );
      expect(agent.knowledge.partitionId).toBe(
        agent.knowledge.scopeId.replace(/^(harness|project|client):/u, 'graphify/$1/')
      );
      expect(agent.continuation.stages.length).toBeGreaterThan(1);
      expect(agent.continuation.checkpoint.requiredFields).toContain('profile_revision');
      expect(agent.continuation.checkpoint.excludedFields).toContain('hidden_reasoning');
      expect(agent.continuation.resume.onUncertainty).toBe('stop_and_escalate');
      expect(agent.continuation.output.requiredFields.length).toBeGreaterThan(0);
      expect(agent.continuation.completionCriteria.length).toBeGreaterThan(0);
      expect(agent.continuation.escalation.conditions.length).toBeGreaterThan(0);
      expect(agent.continuation.budgets.maxDurationSeconds).toBeGreaterThan(0);
    }
  });

  it('binds profile knowledge to registered knowledge-contract namespaces', () => {
    expect(findAgentProfile('jarvis')?.knowledge.scopeId).toBe('harness:jarvis');

    for (const agent of listAgentProfiles()) {
      if (agent.trustDomain === 'agency') {
        expect(agent.knowledge.scopeId).toMatch(/^project:agency_/u);
      }
      if (agent.trustDomain === 'task_market') {
        expect(agent.knowledge.scopeId).toMatch(/^project:task_market_/u);
      }
    }
  });

  it('installs only Jarvis personal memory plus its reviewed shared handoff sleeve', () => {
    expect(findAgentProfile('jarvis')?.memory).toMatchObject({
      readableSleeveIds: ['personal:jarvis', 'shared:jarvis_handoffs'],
      proposeWritableSleeveIds: ['personal:jarvis']
    });
  });

  it('recognizes future company, project, and exact client sleeve grant identifiers', () => {
    expect(AgentSleeveIdSchema.parse('company:acme_corp')).toBe('company:acme_corp');
    expect(AgentSleeveIdSchema.parse('project:client_portal')).toBe('project:client_portal');
    expect(AgentSleeveIdSchema.parse('client:acme_corp')).toBe('client:acme_corp');
    expect(() => AgentSleeveIdSchema.parse('client:../escape')).toThrow();
    expect(() => AgentSleeveIdSchema.parse('client:ab')).toThrow();
    expect(() => AgentSleeveIdSchema.parse('client:acme-corp')).toThrow();

    const staticClientGrant = mutableCatalog();
    profile(staticClientGrant, 'agency-delivery').memory.readableSleeveIds.push('client:acme_corp');
    expect(() => validateAgentProfiles(staticClientGrant)).toThrow(/temporary grant/iu);
  });

  it('deep-freezes startup-validated catalog records', () => {
    const profiles = listAgentProfiles();
    const developer = findAgentProfile('agency-developer');

    expect(Object.isFrozen(profiles)).toBe(true);
    expect(Object.isFrozen(developer)).toBe(true);
    expect(Object.isFrozen(developer?.toolGrants)).toBe(true);
    expect(Object.isFrozen(developer?.continuation)).toBe(true);
    expect(Object.isFrozen(developer?.continuation.checkpoint.requiredFields)).toBe(true);
  });

  it('returns a deterministic bounded recursive hierarchy projection', () => {
    const complete = projectAgentHierarchy();
    expect(complete).toMatchObject({ returnedCount: 45, totalCount: 45, truncated: false });
    expect(complete.roots).toHaveLength(1);
    expect(complete.roots[0]).toMatchObject({ id: 'jarvis', depth: 0 });
    expect(complete.roots[0]?.children.map(({ id }) => id)).toEqual(['agency', 'mcp-x402']);

    const agency = projectAgentHierarchy({ rootId: 'agency', maxDepth: 1, maxNodes: 4 });
    expect(agency.returnedCount).toBe(4);
    expect(agency.totalCount).toBe(34);
    expect(agency.truncated).toBe(true);
    expect(agency.roots[0]).toMatchObject({ id: 'agency', depth: 0 });

    expect(() => projectAgentHierarchy({ rootId: 'missing', maxDepth: 2, maxNodes: 10 })).toThrow(
      /root profile was not found/iu
    );
    expect(() => projectAgentHierarchy({ maxDepth: 99, maxNodes: 10 })).toThrow();
    expect(() => projectAgentHierarchy({ maxDepth: 2, maxNodes: 101 })).toThrow();
  });

  it('rejects duplicate IDs, missing parents, and cycles', () => {
    const duplicate = mutableCatalog();
    duplicate.push(structuredClone(duplicate[0] as AgentProfile));
    expect(() => validateAgentProfiles(duplicate)).toThrow(/duplicate/iu);

    const missingParent = mutableCatalog();
    profile(missingParent, 'agency-developer').parentId = 'missing-parent';
    expect(() => validateAgentProfiles(missingParent)).toThrow(/parent/iu);

    const cycle = mutableCatalog();
    profile(cycle, 'agency').parentId = 'agency-developer';
    expect(() => validateAgentProfiles(cycle)).toThrow(/cycle/iu);
  });

  it('rejects empty fields, unknown fields, malformed scratch sleeves, and domain-crossing sleeves', () => {
    const emptyPurpose = mutableCatalog();
    profile(emptyPurpose, 'agency-growth').purpose = '   ';
    expect(() => validateAgentProfiles(emptyPurpose)).toThrow();

    const unknownField = mutableCatalog() as Array<AgentProfile & { prompt?: string }>;
    const agencyWithUnknownField = unknownField.find(({ id }) => id === 'agency');
    if (agencyWithUnknownField === undefined) throw new Error('Missing Agency fixture profile');
    agencyWithUnknownField.prompt = 'browser-owned authority';
    expect(() => AgentProfileCatalogSchema.parse(unknownField)).toThrow();

    const wrongScratch = mutableCatalog();
    profile(wrongScratch, 'agency-growth').memory.scratchSleeveId =
      'agent:agency-developer:scratch';
    expect(() => validateAgentProfiles(wrongScratch)).toThrow(/scratch/iu);

    const crossDomain = mutableCatalog();
    profile(crossDomain, 'agency-growth').memory.readableSleeveIds.push('task_market:signals');
    expect(() => validateAgentProfiles(crossDomain)).toThrow(/trust domain/iu);

    const crossDomainKnowledge = mutableCatalog();
    profile(crossDomainKnowledge, 'agency-growth').knowledge.scopeId = 'project:task_market_growth';
    profile(crossDomainKnowledge, 'agency-growth').knowledge.partitionId =
      'graphify/project/task_market_growth';
    expect(() => validateAgentProfiles(crossDomainKnowledge)).toThrow(/trust domain/iu);

    const mismatchedKnowledgePartition = mutableCatalog();
    profile(mismatchedKnowledgePartition, 'agency-growth').knowledge.partitionId =
      'graphify/project/agency_delivery';
    expect(() => validateAgentProfiles(mismatchedKnowledgePartition)).toThrow(
      /registered scope binding/iu
    );

    const crossDomainEdge = mutableCatalog();
    profile(crossDomainEdge, 'agency-growth').parentId = 'mcp-x402';
    expect(() => validateAgentProfiles(crossDomainEdge)).toThrow(/trust domain/iu);

    const duplicateCheckpointSafety = mutableCatalog();
    profile(duplicateCheckpointSafety, 'agency-growth').continuation.checkpoint.excludedFields = [
      'whole_transcripts',
      'whole_transcripts',
      'whole_transcripts',
      'whole_transcripts'
    ];
    expect(() => validateAgentProfiles(duplicateCheckpointSafety)).toThrow(/exact safety set/iu);

    const crossDomainEscalation = mutableCatalog();
    profile(crossDomainEscalation, 'agency-growth').continuation.escalation.target = 'mcp-x402';
    expect(() => validateAgentProfiles(crossDomainEscalation)).toThrow(/reviewed-handoff/iu);
  });

  it('keeps every MCP/x402 grant simulation-safe and rejects wallet or signing authority', () => {
    const taskMarketProfiles = listAgentProfiles().filter(
      ({ trustDomain }) => trustDomain === 'task_market'
    );
    expect(taskMarketProfiles).not.toHaveLength(0);
    for (const agent of taskMarketProfiles) {
      expect(agent.toolGrants.map(({ id }) => id).join(' ')).not.toMatch(
        /(?:^|[. :_-])(?:wallet|sign|signing|withdraw|private[_-]?key|seed|mainnet|payment[_-]?policy)(?:[. :_-]|$)/iu
      );
      expect(agent.memory.readableSleeveIds.every((id) => id.startsWith('task_market:'))).toBe(
        true
      );
    }

    const walletGrant = mutableCatalog();
    profile(walletGrant, 'mcp-x402-seller-operator').toolGrants.push({
      id: 'wallet.sign_transaction',
      access: 'execute',
      purpose: 'Sign a settlement transaction'
    });
    expect(() => validateAgentProfiles(walletGrant)).toThrow(/wallet or signing/iu);

    const executableGrant = mutableCatalog();
    profile(executableGrant, 'mcp-x402-chain-reconciler').toolGrants.push({
      id: 'chain.broadcast_transaction',
      access: 'execute',
      purpose: 'Broadcast a transaction'
    });
    expect(() => validateAgentProfiles(executableGrant)).toThrow(/simulation-only/iu);

    const crossDomainGrant = mutableCatalog();
    profile(crossDomainGrant, 'agency').toolGrants.push({
      id: 'personal.read_snapshot',
      access: 'read',
      purpose: 'Read the operator snapshot'
    });
    expect(() => validateAgentProfiles(crossDomainGrant)).toThrow(/trust domain/iu);
  });

  it('keeps Finance evidence-only and Marketing external effects operator-blocked', () => {
    const finance = listAgentProfiles().filter(({ id }) => id.startsWith('agency-finance'));
    const marketing = listAgentProfiles().filter(
      ({ id }) => id === 'agency-content-planner' || id.startsWith('agency-marketing')
    );

    expect(finance).toHaveLength(4);
    expect(finance.flatMap(({ toolGrants }) => toolGrants)).not.toContainEqual(
      expect.objectContaining({ access: 'execute' })
    );
    expect(finance.map(({ purpose }) => purpose).join(' ')).toMatch(
      /never issuing invoices, moving money, or inventing revenue/iu
    );

    expect(marketing).toHaveLength(4);
    expect(marketing.map(({ purpose }) => purpose).join(' ')).toMatch(
      /without publishing, paid spend, account access, or revenue claims/iu
    );
    expect(
      marketing
        .flatMap(({ toolGrants }) => toolGrants)
        .filter(({ access }) => access === 'execute')
        .map(({ id }) => id)
    ).toEqual(['agency.execute_marketing_pilot_gate']);
  });
});
