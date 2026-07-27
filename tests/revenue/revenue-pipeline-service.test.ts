import { describe, expect, it, vi } from 'vitest';

import type { RevenuePipelineRepository } from '../../src/db/revenue-pipeline-repository';
import { MICRO_USD_PER_USD, REVENUE_PIPELINE_SAFETY } from '../../src/revenue/contracts';
import { RevenuePipelineService } from '../../src/revenue/revenue-pipeline-service';

describe('RevenuePipelineService', () => {
  it('owns timestamps and exposes only local review and simulation operations', async () => {
    const repository = {
      createProspect: vi.fn().mockResolvedValue({ id: 'prospect_alpha' }),
      transitionProspect: vi.fn().mockResolvedValue({ id: 'prospect_alpha', version: 2 }),
      createOffer: vi.fn().mockResolvedValue({ id: 'offer_alpha' }),
      transitionOffer: vi.fn().mockResolvedValue({ id: 'offer_alpha', version: 2 }),
      createOutreachDraft: vi.fn().mockResolvedValue({ id: 'draft_alpha' }),
      transitionOutreachDraft: vi.fn().mockResolvedValue({ id: 'draft_alpha', version: 2 }),
      initializeTaskMarketContract: vi.fn().mockResolvedValue({ state: 'contract_only' }),
      enableTaskMarketSimulation: vi.fn().mockResolvedValue({ state: 'simulation' }),
      recordTaskMarketSimulation: vi.fn().mockResolvedValue({ id: 'simulation_alpha' }),
      readLaneSnapshot: vi.fn().mockResolvedValue({ lane: 'agency' }),
      readEvents: vi.fn().mockResolvedValue([])
    };
    const service = new RevenuePipelineService(
      repository as unknown as RevenuePipelineRepository,
      () => new Date('2026-07-18T21:00:00.000Z')
    );

    await service.identifyProspect({
      id: 'prospect_alpha',
      lane: 'agency',
      publicLabel: 'Alpha',
      contactChannel: 'email',
      contactReference: null,
      source: 'referral',
      need: 'agency_automation_audit',
      actorId: 'operator:jarvis'
    });
    await service.setProspectStatus({
      id: 'prospect_alpha',
      expectedVersion: 1,
      status: 'qualified',
      actorId: 'operator:jarvis'
    });
    await service.draftOffer({
      id: 'offer_alpha',
      prospectId: 'prospect_alpha',
      lane: 'agency',
      title: 'Audit',
      deliverable: 'automation_audit',
      proposedAmountMicrousd: 500 * MICRO_USD_PER_USD,
      turnaroundHours: 24,
      revisionLimit: 0,
      actorId: 'operator:jarvis'
    });
    await service.setOfferStatus({
      id: 'offer_alpha',
      expectedVersion: 1,
      status: 'review_ready',
      actorId: 'operator:jarvis'
    });
    await service.prepareOutreachDraft({
      id: 'draft_alpha',
      prospectId: 'prospect_alpha',
      offerId: 'offer_alpha',
      lane: 'agency',
      channel: 'email',
      subject: 'Hello',
      body: 'A reviewed draft.',
      actorId: 'operator:jarvis'
    });
    await service.setOutreachDraftStatus({
      id: 'draft_alpha',
      expectedVersion: 1,
      status: 'review_ready',
      actorId: 'operator:jarvis'
    });
    await service.establishTaskMarketContract({
      productId: 'edge-validation-v1',
      a2aVersion: '0.3.0',
      skillId: 'edge_validation',
      inputContract: 'bounded_numeric_series',
      outputContract: 'validation_verdict',
      x402Scheme: 'exact',
      quotedAmountMicrousd: MICRO_USD_PER_USD / 2,
      actorId: 'operator:jarvis'
    });
    await service.enableTaskMarketSimulation({
      expectedVersion: 1,
      actorId: 'operator:jarvis'
    });
    await service.recordTaskMarketSimulation({
      id: 'simulation_alpha',
      activationVersion: 2,
      scenario: 'authorization_rejected',
      outcome: 'pass',
      requestDigest: 'a'.repeat(64),
      evidenceDigest: 'b'.repeat(64),
      actorId: 'operator:jarvis'
    });
    await service.readLane({ lane: 'agency', limit: 10 });
    await service.readAudit({ lane: 'agency', limit: 10 });

    const at = '2026-07-18T21:00:00.000Z';
    expect(repository.createProspect).toHaveBeenCalledWith(
      expect.objectContaining({ createdAt: at })
    );
    expect(repository.transitionProspect).toHaveBeenCalledWith(
      expect.objectContaining({ changedAt: at })
    );
    expect(repository.createOffer).toHaveBeenCalledWith(expect.objectContaining({ createdAt: at }));
    expect(repository.transitionOffer).toHaveBeenCalledWith(
      expect.objectContaining({ changedAt: at })
    );
    expect(repository.createOutreachDraft).toHaveBeenCalledWith(
      expect.objectContaining({ createdAt: at })
    );
    expect(repository.transitionOutreachDraft).toHaveBeenCalledWith(
      expect.objectContaining({ changedAt: at })
    );
    expect(repository.initializeTaskMarketContract).toHaveBeenCalledWith(
      expect.objectContaining({ createdAt: at })
    );
    expect(repository.enableTaskMarketSimulation).toHaveBeenCalledWith(
      expect.objectContaining({ changedAt: at })
    );
    expect(repository.recordTaskMarketSimulation).toHaveBeenCalledWith(
      expect.objectContaining({ recordedAt: at })
    );
    expect(service.safety).toEqual(REVENUE_PIPELINE_SAFETY);
    expect('sendOutreach' in service).toBe(false);
    expect('chargePayment' in service).toBe(false);
    expect('enableMainnet' in service).toBe(false);

    const defaultClockService = new RevenuePipelineService(
      repository as unknown as RevenuePipelineRepository
    );
    await defaultClockService.identifyProspect({
      id: 'prospect_default_clock',
      lane: 'agency',
      publicLabel: 'Default clock',
      contactChannel: 'referral',
      contactReference: null,
      source: 'referral',
      need: 'agency_automation_audit',
      actorId: 'operator:jarvis'
    });
    const lastCall = repository.createProspect.mock.lastCall as unknown as
      [{ createdAt: string }] | undefined;
    expect(lastCall?.[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
