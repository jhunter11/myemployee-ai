import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDatabase, type GlobalDatabaseContext } from '../../src/db/database';
import { RevenuePipelineRepository } from '../../src/db/revenue-pipeline-repository';
import {
  CreateOutreachDraftInputSchema,
  CreateOfferInputSchema,
  CreateProspectInputSchema,
  InitializeTaskMarketContractInputSchema,
  MICRO_USD_PER_USD
} from '../../src/revenue/contracts';

const projectRoot = join(__dirname, '..', '..');
const t0 = '2026-07-18T20:00:00.000Z';
const t1 = '2026-07-18T20:01:00.000Z';
const t2 = '2026-07-18T20:02:00.000Z';
const t3 = '2026-07-18T20:03:00.000Z';
const t4 = '2026-07-18T20:04:00.000Z';
const t5 = '2026-07-18T20:05:00.000Z';
const t6 = '2026-07-18T20:06:00.000Z';
const t7 = '2026-07-18T20:07:00.000Z';
const digestA = 'a'.repeat(64);
const digestB = 'b'.repeat(64);
const agencyPilotPriceMicrousd = 1_500 * MICRO_USD_PER_USD;
const taskMarketSimulationQuoteMicrousd = MICRO_USD_PER_USD / 2;

describe('RevenuePipelineRepository', () => {
  let temporaryRoot: string;
  let context: GlobalDatabaseContext;
  let repository: RevenuePipelineRepository;

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'jarvis-revenue-test-'));
    context = await createDatabase({
      projectRoot,
      filename: join(temporaryRoot, 'jarvis.sqlite')
    });
    repository = new RevenuePipelineRepository(context.db);
  });

  afterEach(async () => {
    await context.destroy();
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  it('durably advances an agency prospect through internal review without exposing contact or draft content', async () => {
    const prospect = await repository.createProspect({
      id: 'prospect_alpha',
      lane: 'agency',
      publicLabel: 'Alpha Operations',
      contactChannel: 'email',
      contactReference: 'contact:alpha_ops',
      source: 'operator_research',
      need: 'agency_workflow_pilot',
      actorId: 'operator:jarvis',
      createdAt: t0
    });
    expect(prospect).toEqual({
      id: 'prospect_alpha',
      lane: 'agency',
      publicLabel: 'Alpha Operations',
      contactChannel: 'email',
      hasContactReference: true,
      source: 'operator_research',
      need: 'agency_workflow_pilot',
      status: 'identified',
      version: 1,
      createdAt: t0,
      updatedAt: t0
    });
    expect(JSON.stringify(prospect)).not.toContain('contact:alpha_ops');
    await expect(
      repository.createProspect({
        id: 'prospect_alpha',
        lane: 'agency',
        publicLabel: 'Alpha Operations',
        contactChannel: 'email',
        contactReference: 'contact:alpha_ops',
        source: 'operator_research',
        need: 'agency_workflow_pilot',
        actorId: 'operator:replay',
        createdAt: t0
      })
    ).resolves.toEqual(prospect);
    await expect(
      repository.createProspect({
        id: 'prospect_alpha',
        lane: 'agency',
        publicLabel: 'Different Operations',
        contactChannel: 'email',
        contactReference: 'contact:alpha_ops',
        source: 'operator_research',
        need: 'agency_workflow_pilot',
        actorId: 'operator:jarvis',
        createdAt: t0
      })
    ).rejects.toThrow(/different details/i);

    await repository.transitionProspect({
      id: prospect.id,
      expectedVersion: 1,
      status: 'qualified',
      actorId: 'operator:jarvis',
      changedAt: t1
    });
    const offer = await repository.createOffer({
      id: 'offer_alpha_pilot',
      prospectId: prospect.id,
      lane: 'agency',
      title: 'Workflow reliability pilot',
      deliverable: 'workflow_pilot',
      proposedAmountMicrousd: agencyPilotPriceMicrousd,
      turnaroundHours: 72,
      revisionLimit: 1,
      actorId: 'operator:jarvis',
      createdAt: t2
    });
    expect(offer).toMatchObject({
      lane: 'agency',
      status: 'draft',
      quote: {
        basis: 'proposed',
        currency: 'USD',
        amountMicrousd: agencyPilotPriceMicrousd
      },
      externalPayment: 'blocked'
    });
    await expect(
      repository.createOffer({
        id: 'offer_alpha_pilot',
        prospectId: prospect.id,
        lane: 'agency',
        title: 'Workflow reliability pilot',
        deliverable: 'workflow_pilot',
        proposedAmountMicrousd: agencyPilotPriceMicrousd,
        turnaroundHours: 72,
        revisionLimit: 1,
        actorId: 'operator:replay',
        createdAt: t2
      })
    ).resolves.toEqual(offer);
    expect(offer.quote.amountMicrousd / MICRO_USD_PER_USD).toBe(1_500);
    await expect(
      repository.createOffer({
        id: 'offer_alpha_pilot',
        prospectId: prospect.id,
        lane: 'agency',
        title: 'Different pilot',
        deliverable: 'workflow_pilot',
        proposedAmountMicrousd: agencyPilotPriceMicrousd,
        turnaroundHours: 72,
        revisionLimit: 1,
        actorId: 'operator:jarvis',
        createdAt: t2
      })
    ).rejects.toThrow(/different details/i);

    await repository.transitionOffer({
      id: offer.id,
      expectedVersion: 1,
      status: 'review_ready',
      actorId: 'operator:jarvis',
      changedAt: t3
    });
    await repository.transitionOffer({
      id: offer.id,
      expectedVersion: 2,
      status: 'reviewed',
      actorId: 'operator:jarvis',
      changedAt: t4
    });

    const subject = 'A bounded workflow reliability pilot';
    const body = 'I mapped a small, fixed pilot that can be reviewed before any external action.';
    const draft = await repository.createOutreachDraft({
      id: 'draft_alpha_intro',
      prospectId: prospect.id,
      offerId: offer.id,
      lane: 'agency',
      channel: 'email',
      subject,
      body,
      actorId: 'operator:jarvis',
      createdAt: t5
    });
    expect(draft).toMatchObject({
      id: 'draft_alpha_intro',
      prospectId: prospect.id,
      offerId: offer.id,
      lane: 'agency',
      channel: 'email',
      status: 'draft',
      subjectLength: subject.length,
      bodyLength: body.length,
      externalDelivery: 'blocked'
    });
    expect(draft.contentDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(draft)).not.toContain(subject);
    expect(JSON.stringify(draft)).not.toContain(body);
    await expect(
      repository.createOutreachDraft({
        id: 'draft_alpha_intro',
        prospectId: prospect.id,
        offerId: offer.id,
        lane: 'agency',
        channel: 'email',
        subject,
        body,
        actorId: 'operator:replay',
        createdAt: t5
      })
    ).resolves.toEqual(draft);
    await expect(
      repository.createOutreachDraft({
        id: 'draft_alpha_intro',
        prospectId: prospect.id,
        offerId: offer.id,
        lane: 'agency',
        channel: 'email',
        subject,
        body: 'Different reviewed content.',
        actorId: 'operator:jarvis',
        createdAt: t5
      })
    ).rejects.toThrow(/different content/i);
    const reviewReady = await repository.transitionOutreachDraft({
      id: draft.id,
      expectedVersion: 1,
      status: 'review_ready',
      actorId: 'operator:jarvis',
      changedAt: t6
    });
    const reviewed = await repository.transitionOutreachDraft({
      id: draft.id,
      expectedVersion: reviewReady.version,
      status: 'reviewed',
      actorId: 'operator:jarvis',
      changedAt: t7
    });
    expect(reviewed).toMatchObject({ status: 'reviewed', version: 3 });
    await expect(
      repository.transitionOutreachDraft({
        id: draft.id,
        expectedVersion: reviewed.version,
        status: 'draft',
        actorId: 'operator:jarvis',
        changedAt: t7
      })
    ).rejects.toThrow(/invalid revenue outreach draft status transition/i);

    const snapshot = await repository.readLaneSnapshot({ lane: 'agency', limit: 10 });
    expect(snapshot).toMatchObject({
      lane: 'agency',
      counts: { prospects: 1, offers: 1, outreachDrafts: 1, simulations: 0 },
      safety: {
        outboundNetwork: 'none',
        externalMessaging: 'blocked',
        externalPayment: 'blocked',
        walletMaterial: 'forbidden',
        revenueRecognition: 'none'
      }
    });
    expect(snapshot.activation).toBeNull();
    expect(snapshot.outreachDrafts).toEqual([reviewed]);

    const stored = context.sqlite
      .prepare(
        'SELECT contact_reference, subject, body FROM revenue_outreach_drafts JOIN revenue_prospects ON revenue_prospects.id = revenue_outreach_drafts.prospect_id'
      )
      .get() as { contact_reference: string; subject: string; body: string };
    expect(stored).toEqual({ contact_reference: 'contact:alpha_ops', subject, body });
  });

  it('keeps x402 and A2A in contract-only or simulation state with no wallet, network, payment, or earnings claim', async () => {
    await expect(
      repository.readLaneSnapshot({ lane: 'task_market', limit: 10 })
    ).resolves.toMatchObject({ activation: null, counts: { simulations: 0 } });
    await expect(
      repository.recordTaskMarketSimulation({
        id: 'simulation_missing_activation',
        activationVersion: 1,
        scenario: 'authorization_accepted',
        outcome: 'pass',
        requestDigest: digestA,
        evidenceDigest: digestB,
        actorId: 'operator:jarvis',
        recordedAt: t0
      })
    ).rejects.toThrow(/simulation activation/i);

    const contractInput = {
      productId: 'edge-validation-v1',
      a2aVersion: '0.3.0',
      skillId: 'edge_validation',
      inputContract: 'bounded_numeric_series',
      outputContract: 'validation_verdict',
      x402Scheme: 'exact',
      quotedAmountMicrousd: taskMarketSimulationQuoteMicrousd,
      actorId: 'operator:jarvis',
      createdAt: t0
    } as const;
    const activation = await repository.initializeTaskMarketContract(contractInput);
    expect(activation).toMatchObject({
      lane: 'task_market',
      productId: 'edge-validation-v1',
      state: 'contract_only',
      version: 1,
      a2a: {
        version: '0.3.0',
        skillId: 'edge_validation',
        inputContract: 'bounded_numeric_series',
        outputContract: 'validation_verdict'
      },
      x402: {
        scheme: 'exact',
        quote: {
          basis: 'simulation',
          currency: 'USD',
          amountMicrousd: taskMarketSimulationQuoteMicrousd
        },
        paymentMode: 'blocked'
      },
      safety: {
        outboundNetwork: 'none',
        externalPayment: 'blocked',
        walletMaterial: 'forbidden',
        revenueRecognition: 'none'
      }
    });
    expect(activation.contractDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(activation.x402.quote.amountMicrousd / MICRO_USD_PER_USD).toBe(0.5);
    await expect(
      repository.initializeTaskMarketContract({ ...contractInput, actorId: 'operator:replay' })
    ).resolves.toEqual(activation);
    await expect(
      repository.initializeTaskMarketContract({
        ...contractInput,
        quotedAmountMicrousd: taskMarketSimulationQuoteMicrousd + 1
      })
    ).rejects.toThrow(/different contract/i);
    for (const conflictingContract of [
      { ...contractInput, productId: 'edge-validation-v2' },
      { ...contractInput, a2aVersion: '0.4.0' },
      { ...contractInput, skillId: 'edge_validation_v2' },
      { ...contractInput, createdAt: t1 }
    ]) {
      await expect(repository.initializeTaskMarketContract(conflictingContract)).rejects.toThrow(
        /different contract/i
      );
    }

    await expect(
      repository.recordTaskMarketSimulation({
        id: 'simulation_early',
        activationVersion: 1,
        scenario: 'authorization_accepted',
        outcome: 'pass',
        requestDigest: digestA,
        evidenceDigest: digestB,
        actorId: 'operator:jarvis',
        recordedAt: t1
      })
    ).rejects.toThrow(/simulation activation/i);

    const simulated = await repository.enableTaskMarketSimulation({
      expectedVersion: 1,
      actorId: 'operator:jarvis',
      changedAt: t1
    });
    expect(simulated).toMatchObject({
      state: 'simulation',
      version: 2,
      x402: { paymentMode: 'simulated' },
      safety: { externalPayment: 'blocked', revenueRecognition: 'none' }
    });

    const evidence = await repository.recordTaskMarketSimulation({
      id: 'simulation_accept',
      activationVersion: 2,
      scenario: 'authorization_accepted',
      outcome: 'pass',
      requestDigest: digestA,
      evidenceDigest: digestB,
      actorId: 'operator:jarvis',
      recordedAt: t2
    });
    expect(evidence).toEqual({
      id: 'simulation_accept',
      activationVersion: 2,
      scenario: 'authorization_accepted',
      outcome: 'pass',
      requestDigest: digestA,
      evidenceDigest: digestB,
      quote: {
        basis: 'simulation',
        currency: 'USD',
        amountMicrousd: taskMarketSimulationQuoteMicrousd
      },
      externalPayment: 'blocked',
      revenueRecognition: 'none',
      recordedAt: t2
    });
    await expect(
      repository.recordTaskMarketSimulation({
        id: 'simulation_wrong_version',
        activationVersion: 1,
        scenario: 'authorization_rejected',
        outcome: 'fail',
        requestDigest: digestB,
        evidenceDigest: digestA,
        actorId: 'operator:jarvis',
        recordedAt: t3
      })
    ).rejects.toThrow(/simulation activation/i);
    await expect(
      repository.recordTaskMarketSimulation({
        id: 'simulation_rejected',
        activationVersion: 2,
        scenario: 'authorization_rejected',
        outcome: 'fail',
        requestDigest: digestB,
        evidenceDigest: digestA,
        actorId: 'operator:jarvis',
        recordedAt: t3
      })
    ).resolves.toMatchObject({ outcome: 'fail', revenueRecognition: 'none' });

    const snapshot = await repository.readLaneSnapshot({ lane: 'task_market', limit: 10 });
    expect(snapshot.counts.simulations).toBe(2);
    expect(snapshot.activation).toMatchObject({ state: 'simulation' });

    expect(() =>
      context.sqlite
        .prepare(
          "UPDATE task_market_activation SET activation_state = 'testnet' WHERE id = 'task_market'"
        )
        .run()
    ).toThrow();
    const columns = context.sqlite
      .prepare("SELECT name FROM pragma_table_info('task_market_activation')")
      .all() as Array<{ name: string }>;
    expect(columns.map(({ name }) => name).join(' ')).not.toMatch(
      /private_key|wallet_address|receive_address|url/i
    );
    expect(columns.map(({ name }) => name).join(' ')).not.toMatch(/revenue|earnings/i);
  });

  it('rejects direct external-action fields and wallet-shaped draft content at strict input boundaries', () => {
    expect(() =>
      CreateProspectInputSchema.parse({
        id: 'prospect_unsafe',
        lane: 'agency',
        publicLabel: 'Unsafe',
        contactChannel: 'email',
        contactReference: 'contact:unsafe',
        source: 'operator_research',
        need: 'agency_automation_audit',
        actorId: 'operator:jarvis',
        createdAt: t0,
        email: 'person@example.test'
      })
    ).toThrow();
    expect(() =>
      CreateProspectInputSchema.parse({
        id: 'prospect_wrong_need',
        lane: 'agency',
        publicLabel: 'Wrong need',
        contactChannel: 'email',
        contactReference: null,
        source: 'operator_research',
        need: 'task_validation_api',
        actorId: 'operator:jarvis',
        createdAt: t0
      })
    ).toThrow(/not valid for agency/i);
    expect(() =>
      CreateOfferInputSchema.parse({
        id: 'offer_wrong_deliverable',
        prospectId: 'prospect_unsafe',
        lane: 'agency',
        title: 'Wrong deliverable',
        deliverable: 'edge_validation_v1',
        proposedAmountMicrousd: 500 * MICRO_USD_PER_USD,
        turnaroundHours: 24,
        revisionLimit: 0,
        actorId: 'operator:jarvis',
        createdAt: t0
      })
    ).toThrow(/not valid for agency/i);
    expect(() =>
      InitializeTaskMarketContractInputSchema.parse({
        productId: 'edge-validation-v1',
        a2aVersion: '0.3.0',
        skillId: 'edge_validation',
        inputContract: 'bounded_numeric_series',
        outputContract: 'validation_verdict',
        x402Scheme: 'exact',
        quotedAmountMicrousd: taskMarketSimulationQuoteMicrousd,
        actorId: 'operator:jarvis',
        createdAt: t0,
        sellerWalletAddress: '0x0000000000000000000000000000000000000000'
      })
    ).toThrow();
    expect(() =>
      CreateOutreachDraftInputSchema.parse({
        id: 'draft_unsafe',
        prospectId: 'prospect_unsafe',
        offerId: 'offer_unsafe',
        lane: 'agency',
        channel: 'email',
        subject: 'Unsafe secret',
        body: `private key: 0x${'c'.repeat(64)}`,
        actorId: 'operator:jarvis',
        createdAt: t0
      })
    ).toThrow(/wallet or private-key material/i);
    expect(() =>
      CreateOutreachDraftInputSchema.parse({
        id: 'draft_raw_key',
        prospectId: 'prospect_unsafe',
        offerId: 'offer_unsafe',
        lane: 'agency',
        channel: 'email',
        subject: 'Unsafe secret',
        body: `Material 0x${'c'.repeat(64)}`,
        actorId: 'operator:jarvis',
        createdAt: t0
      })
    ).toThrow(/wallet or private-key material/i);
    expect(() =>
      CreateOutreachDraftInputSchema.parse({
        id: 'draft_private_header',
        prospectId: 'prospect_unsafe',
        offerId: 'offer_unsafe',
        lane: 'agency',
        channel: 'email',
        subject: 'Unsafe secret',
        body: '-----BEGIN PRIVATE KEY-----',
        actorId: 'operator:jarvis',
        createdAt: t0
      })
    ).toThrow(/wallet or private-key material/i);
  });

  it('enforces lane compatibility, reviewed offers, optimistic versions, and internal-only statuses', async () => {
    await expect(
      repository.transitionOffer({
        id: 'offer_missing',
        expectedVersion: 1,
        status: 'review_ready',
        actorId: 'operator:jarvis',
        changedAt: t0
      })
    ).rejects.toThrow(/does not exist/i);

    await repository.createProspect({
      id: 'prospect_market',
      lane: 'task_market',
      publicLabel: 'Validation Buyer',
      contactChannel: 'marketplace',
      contactReference: null,
      source: 'public_directory',
      need: 'task_validation_api',
      actorId: 'operator:jarvis',
      createdAt: t0
    });

    await expect(
      repository.createOffer({
        id: 'offer_too_early',
        prospectId: 'prospect_market',
        lane: 'task_market',
        title: 'Validation API',
        deliverable: 'edge_validation_v1',
        proposedAmountMicrousd: taskMarketSimulationQuoteMicrousd,
        turnaroundHours: 24,
        revisionLimit: 0,
        actorId: 'operator:jarvis',
        createdAt: t1
      })
    ).rejects.toThrow(/qualified/i);

    const qualified = await repository.transitionProspect({
      id: 'prospect_market',
      expectedVersion: 1,
      status: 'qualified',
      actorId: 'operator:jarvis',
      changedAt: t1
    });
    await expect(
      repository.transitionProspect({
        id: 'prospect_market',
        expectedVersion: 1,
        status: 'paused',
        actorId: 'operator:jarvis',
        changedAt: t2
      })
    ).rejects.toThrow(/version/i);
    expect(qualified.version).toBe(2);

    await expect(
      repository.createOffer({
        id: 'offer_wrong_lane',
        prospectId: 'prospect_market',
        lane: 'agency',
        title: 'Wrong lane',
        deliverable: 'workflow_pilot',
        proposedAmountMicrousd: 500 * MICRO_USD_PER_USD,
        turnaroundHours: 24,
        revisionLimit: 0,
        actorId: 'operator:jarvis',
        createdAt: t2
      })
    ).rejects.toThrow();

    expect(() =>
      context.sqlite
        .prepare("UPDATE revenue_prospects SET status = 'contacted' WHERE id = 'prospect_market'")
        .run()
    ).toThrow();
  });

  it('is idempotent for exact simulation evidence and keeps the audit log append-only', async () => {
    await repository.initializeTaskMarketContract({
      productId: 'edge-validation-v1',
      a2aVersion: '0.3.0',
      skillId: 'edge_validation',
      inputContract: 'bounded_numeric_series',
      outputContract: 'validation_verdict',
      x402Scheme: 'exact',
      quotedAmountMicrousd: taskMarketSimulationQuoteMicrousd,
      actorId: 'operator:jarvis',
      createdAt: t0
    });
    await repository.enableTaskMarketSimulation({
      expectedVersion: 1,
      actorId: 'operator:jarvis',
      changedAt: t1
    });
    const input = {
      id: 'simulation_replay',
      activationVersion: 2,
      scenario: 'duplicate_replay' as const,
      outcome: 'pass' as const,
      requestDigest: digestA,
      evidenceDigest: digestB,
      actorId: 'operator:jarvis',
      recordedAt: t2
    };
    const first = await repository.recordTaskMarketSimulation(input);
    await expect(repository.recordTaskMarketSimulation(input)).resolves.toEqual(first);
    await expect(
      repository.recordTaskMarketSimulation({ ...input, evidenceDigest: digestA })
    ).rejects.toThrow(/different evidence/i);
    for (const conflictingEvidence of [
      { ...input, scenario: 'authorization_accepted' as const },
      { ...input, outcome: 'fail' as const },
      { ...input, requestDigest: digestB },
      { ...input, recordedAt: t3 }
    ]) {
      await expect(repository.recordTaskMarketSimulation(conflictingEvidence)).rejects.toThrow(
        /different evidence/i
      );
    }

    const events = await repository.readEvents({ lane: 'task_market', limit: 20 });
    expect(events.map((event) => event.eventType)).toEqual([
      'simulation_recorded',
      'status_changed',
      'created'
    ]);
    expect(JSON.stringify(events)).not.toContain('operator:jarvis');
    expect(() => context.sqlite.prepare('DELETE FROM revenue_pipeline_events').run()).toThrow(
      /append-only/i
    );
  });

  it('fails closed when durable audit rows are corrupt despite database constraints being bypassed', async () => {
    context.sqlite.pragma('ignore_check_constraints = ON');
    const insert = context.sqlite.prepare(`
      INSERT INTO revenue_pipeline_events (
        lane, entity_type, entity_id, event_type, from_status, to_status,
        entity_version, actor_id, detail_json, occurred_at
      ) VALUES ('agency', ?, 'corrupt_event', ?, NULL, 'draft', 1, 'test:corruption', '{}', ?)
    `);
    insert.run('unknown_entity', 'created', t0);
    await expect(repository.readEvents({ lane: 'agency', limit: 10 })).rejects.toThrow(
      /unknown revenue entity type/i
    );

    insert.run('prospect', 'unknown_event', t1);
    await expect(repository.readEvents({ lane: 'agency', limit: 10 })).rejects.toThrow(
      /unknown revenue event type/i
    );
    context.sqlite.pragma('ignore_check_constraints = OFF');
  });
});
