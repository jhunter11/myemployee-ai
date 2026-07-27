import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDatabase, type GlobalDatabaseContext } from '../../src/db/database';
import { PriorityQueueRepository } from '../../src/db/priority-queue-repository';
import { RevenuePipelineRepository } from '../../src/db/revenue-pipeline-repository';
import { bootstrapFirstClientRevenue } from '../../src/revenue/first-client-bootstrap';
import { CreateOutreachDraftInputSchema } from '../../src/revenue/contracts';

const projectRoot = join(__dirname, '..', '..');
const packPath = join(projectRoot, 'docs', 'revenue', 'first-client-pack.json');
const selectedProspectId = 'charlotte_rgs_home_pros';

describe('first-client revenue bootstrap', () => {
  let temporaryRoot: string;

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'jarvis-first-client-bootstrap-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  it('defaults to a redacted dry-run and does not create or open a ledger', async () => {
    const databaseFile = join(temporaryRoot, 'dry-run.sqlite');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const result = await bootstrapFirstClientRevenue({
      projectRoot,
      packPath,
      databaseFile
    });

    expect(result).toMatchObject({
      schema: 'jarvis.first-client-bootstrap-result.v1',
      mode: 'dry_run',
      pack: {
        asOf: '2026-07-18',
        prospectCount: 10,
        deterministicSelection: {
          prospectId: selectedProspectId,
          score: 5,
          tieBreak: 'score_desc_id_asc'
        }
      },
      ledger: {
        mutation: 'none',
        agency: {
          prospectsPlanned: 10,
          prospectsSeededOrVerified: 0,
          identifiedProspectsVerified: 0,
          offersPersistedByBootstrap: 0,
          outreachDraftsPersistedByBootstrap: 0,
          proposedAmountMicrousdPersistedByBootstrap: 0
        },
        taskMarket: {
          contractState: 'planned_simulation',
          quotedAmountMicrousd: 500_000,
          scenariosPlanned: 3,
          scenariosSeededOrVerified: 0,
          passEvidenceSeededOrVerified: 0
        },
        operatorQueue: {
          tenantId: 'jarvis',
          tasksPlanned: 2,
          tasksSeededOrVerified: 0,
          queuedTasksVerified: 0,
          payloadKinds: ['operator_gate', 'project_task'],
          automationPayloadsPersistedByBootstrap: 0,
          automationCycleEligibleTasks: 0
        }
      },
      safety: {
        outboundNetwork: 'none',
        externalMessaging: 'blocked',
        externalPayment: 'blocked',
        walletMaterial: 'forbidden',
        revenueRecognition: 'none'
      }
    });
    expect(result.reviewGatePlans.offer).toEqual({
      state: 'blocked_by_review_gate',
      prospectId: selectedProspectId,
      offerId: 'offer_charlotte_rgs_home_pros_pilot',
      proposedAmountMicrousd: 750_000_000,
      ledgerRowCreated: false,
      blockingRequirement: 'prospect_must_be_human_qualified'
    });
    expect(result.reviewGatePlans.outreachDraft).toMatchObject({
      state: 'blocked_by_review_gate',
      prospectId: selectedProspectId,
      ledgerRowCreated: false,
      blockingRequirement: 'offer_must_be_human_reviewed'
    });
    expect(result.reviewGatePlans.outreachDraft.contentDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(await fileExists(databaseFile)).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toMatch(/https?:|\.com|contact:|daily lead export/i);
  });

  it('applies ten identified prospects and simulation-only evidence with exact rerun idempotence', async () => {
    const databaseFile = join(temporaryRoot, 'jarvis.sqlite');
    const options = { projectRoot, packPath, databaseFile, apply: true } as const;

    const first = await bootstrapFirstClientRevenue(options);
    const firstLedger = await inspectLedger(databaseFile);
    const second = await bootstrapFirstClientRevenue(options);
    const secondLedger = await inspectLedger(databaseFile);

    expect(second).toEqual(first);
    expect(first).toMatchObject({
      mode: 'applied',
      ledger: {
        mutation: 'local_sqlite_only',
        agency: {
          prospectsPlanned: 10,
          prospectsSeededOrVerified: 10,
          identifiedProspectsVerified: 10,
          offersPersistedByBootstrap: 0,
          outreachDraftsPersistedByBootstrap: 0,
          proposedAmountMicrousdPersistedByBootstrap: 0
        },
        taskMarket: {
          contractState: 'simulation',
          quotedAmountMicrousd: 500_000,
          scenariosPlanned: 3,
          scenariosSeededOrVerified: 3,
          passEvidenceSeededOrVerified: 3
        },
        operatorQueue: {
          tenantId: 'jarvis',
          tasksPlanned: 2,
          tasksSeededOrVerified: 2,
          queuedTasksVerified: 2,
          payloadKinds: ['operator_gate', 'project_task'],
          automationPayloadsPersistedByBootstrap: 0,
          automationCycleEligibleTasks: 0
        }
      }
    });
    expect(firstLedger).toEqual(secondLedger);
    expect(firstLedger).toMatchObject({
      events: 15,
      prospects: 10,
      identifiedProspects: 10,
      offers: 0,
      outreachDrafts: 0,
      activationState: 'simulation',
      activationVersion: 2,
      quotedAmountMicrousd: 500_000,
      simulations: 3,
      passingSimulations: 3,
      queueTasks: 2,
      queueEvents: 2,
      queuePayloadKinds: ['operator_gate', 'project_task'],
      queueStates: ['queued', 'queued'],
      queueTenantIds: ['jarvis', 'jarvis']
    });
    expect(firstLedger.contactReferences).toHaveLength(10);
    expect(firstLedger.contactReferences.every((value) => /^contact:[a-z0-9_]+$/.test(value))).toBe(
      true
    );
    expect(JSON.stringify(firstLedger.contactReferences)).not.toMatch(/https?:|@|\.com/);
    expect(firstLedger.simulationScenarios).toEqual([
      'authorization_accepted',
      'authorization_rejected',
      'duplicate_replay'
    ]);
    expect(firstLedger.queuePayloadJson.join('\n')).not.toMatch(
      /https?:|@|contact|email|charlotte|roof|home|secret/i
    );
    expect(await claimAutomationOnly(databaseFile)).toBeNull();
  });

  it('rejects unknown fields, unsafe gates, price drift, duplicate prospects, and indirect paths', async () => {
    const original = JSON.parse(await readFile(packPath, 'utf8')) as Record<string, unknown>;
    const invalidPacks: unknown[] = [
      { ...original, outboundUrl: 'https://forbidden.example' },
      nestedCopy(original, (copy) => {
        const offer = copy.offer as { foundingPilot: { firstMonthMicrousd: number } };
        offer.foundingPilot.firstMonthMicrousd += 1;
      }),
      nestedCopy(original, (copy) => {
        const gate = copy.sendGate as { automationMaySend: boolean };
        gate.automationMaySend = true;
      }),
      nestedCopy(original, (copy) => {
        const prospects = copy.prospects as unknown[];
        prospects[9] = prospects[0];
      })
    ];

    for (const [index, invalid] of invalidPacks.entries()) {
      const invalidPath = join(temporaryRoot, `invalid-${index}.json`);
      await writeFile(invalidPath, JSON.stringify(invalid));
      await expect(
        bootstrapFirstClientRevenue({ projectRoot, packPath: invalidPath })
      ).rejects.toThrow(/strict validation/i);
    }

    await expect(
      bootstrapFirstClientRevenue({ projectRoot, packPath: 'docs/revenue/first-client-pack.json' })
    ).rejects.toThrow(/absolute direct path/i);

    const linkedPack = join(temporaryRoot, 'linked-pack.json');
    await symlink(packPath, linkedPack);
    await expect(
      bootstrapFirstClientRevenue({ projectRoot, packPath: linkedPack })
    ).rejects.toThrow(/regular direct file/i);
  });

  it('rejects each reviewed pack-set invariant instead of accepting plausible-looking drift', async () => {
    const original = JSON.parse(await readFile(packPath, 'utf8')) as Record<string, unknown>;
    const invalidPacks: unknown[] = [
      nestedCopy(original, (copy) => {
        const prospects = copy.prospects as Array<{
          qualification: { publicSignals: string[] };
        }>;
        prospects[0]!.qualification.publicSignals[1] =
          prospects[0]!.qualification.publicSignals[0]!;
      }),
      nestedCopy(original, (copy) => {
        const prospects = copy.prospects as Array<{
          qualification: { discoveryUnknowns: string[] };
        }>;
        prospects[0]!.qualification.discoveryUnknowns = [
          'lead_volume',
          'current_system',
          'budget',
          'budget'
        ];
      }),
      nestedCopy(original, (copy) => {
        const prospects = copy.prospects as Array<{
          contactPageUrl: string;
          provenanceUrls: string[];
        }>;
        prospects[0]!.provenanceUrls = ['https://example.org/direct-public-page'];
      }),
      nestedCopy(original, (copy) => {
        const gate = copy.sendGate as { requiredApprovals: string[] };
        gate.requiredApprovals[4] = gate.requiredApprovals[0]!;
      }),
      nestedCopy(original, (copy) => {
        const gate = copy.sendGate as { requiredApprovals: string[] };
        gate.requiredApprovals = gate.requiredApprovals.slice(0, 4);
      }),
      nestedCopy(original, (copy) => {
        const prospects = copy.prospects as Array<{ contactPageUrl: string }>;
        prospects[0]!.contactPageUrl = 'http://example.org/not-https';
      }),
      nestedCopy(original, (copy) => {
        const segment = copy.segment as { label: string };
        segment.label = 'unsafe\u0000label';
      })
    ];

    for (const [index, invalid] of invalidPacks.entries()) {
      const invalidPath = join(temporaryRoot, `reviewed-invariant-${index}.json`);
      await writeFile(invalidPath, JSON.stringify(invalid));
      await expect(
        bootstrapFirstClientRevenue({ projectRoot, packPath: invalidPath })
      ).rejects.toThrow(/strict validation/i);
    }
  });

  it('rejects empty, oversized, directory, and multiply-linked acquisition packs', async () => {
    const emptyPack = join(temporaryRoot, 'empty.json');
    await writeFile(emptyPack, '');
    await expect(bootstrapFirstClientRevenue({ projectRoot, packPath: emptyPack })).rejects.toThrow(
      /bounded regular direct file/i
    );

    const oversizedPack = join(temporaryRoot, 'oversized.json');
    await writeFile(oversizedPack, 'x'.repeat(256 * 1_024 + 1));
    await expect(
      bootstrapFirstClientRevenue({ projectRoot, packPath: oversizedPack })
    ).rejects.toThrow(/bounded regular direct file/i);

    const directoryPack = join(temporaryRoot, 'pack-directory');
    await mkdir(directoryPack);
    await expect(
      bootstrapFirstClientRevenue({ projectRoot, packPath: directoryPack })
    ).rejects.toThrow(/bounded regular direct file/i);

    const directPack = join(temporaryRoot, 'direct-pack.json');
    const hardLinkedPack = join(temporaryRoot, 'hard-linked-pack.json');
    await writeFile(directPack, await readFile(packPath));
    await link(directPack, hardLinkedPack);
    await expect(
      bootstrapFirstClientRevenue({ projectRoot, packPath: hardLinkedPack })
    ).rejects.toThrow(/bounded regular direct file/i);
  });

  it('requires a direct local database only after explicit apply', async () => {
    await expect(
      bootstrapFirstClientRevenue({ projectRoot, packPath, apply: true })
    ).rejects.toThrow(/databaseFile is required/i);

    await expect(
      bootstrapFirstClientRevenue({
        projectRoot,
        packPath,
        databaseFile: 'relative.sqlite',
        apply: true
      })
    ).rejects.toThrow(/absolute direct path/i);

    const databaseDirectory = join(temporaryRoot, 'database-directory');
    await mkdir(databaseDirectory);
    await expect(
      bootstrapFirstClientRevenue({
        projectRoot,
        packPath,
        databaseFile: databaseDirectory,
        apply: true
      })
    ).rejects.toThrow(/regular direct local file/i);

    const directDatabase = join(temporaryRoot, 'direct.sqlite');
    const linkedDatabase = join(temporaryRoot, 'linked.sqlite');
    await writeFile(directDatabase, 'not a database');
    await symlink(directDatabase, linkedDatabase);
    await expect(
      bootstrapFirstClientRevenue({
        projectRoot,
        packPath,
        databaseFile: linkedDatabase,
        apply: true
      })
    ).rejects.toThrow(/regular direct local file/i);

    await expect(
      bootstrapFirstClientRevenue({
        projectRoot,
        packPath,
        databaseFile: directDatabase,
        apply: true
      })
    ).rejects.toThrow(/file is not a database|database disk image is malformed/i);
  });

  it('fails closed when an existing ledger row differs or has advanced beyond identified', async () => {
    const databaseFile = join(temporaryRoot, 'conflict.sqlite');
    await bootstrapFirstClientRevenue({ projectRoot, packPath, databaseFile, apply: true });
    const context = await createDatabase({ projectRoot, filename: databaseFile });
    try {
      context.sqlite
        .prepare(
          "UPDATE revenue_prospects SET status = 'qualified', version = 2, updated_at = '2026-07-18T01:00:00.000Z' WHERE id = ?"
        )
        .run(selectedProspectId);
    } finally {
      await context.destroy();
    }

    await expect(
      bootstrapFirstClientRevenue({ projectRoot, packPath, databaseFile, apply: true })
    ).rejects.toThrow(/must remain identified/i);
  });

  it('fails closed when an idempotent operator review task is no longer queued', async () => {
    const databaseFile = join(temporaryRoot, 'advanced-queue.sqlite');
    await bootstrapFirstClientRevenue({ projectRoot, packPath, databaseFile, apply: true });
    const context = await createDatabase({ projectRoot, filename: databaseFile });
    try {
      context.sqlite
        .prepare(
          "UPDATE work_queue_tasks SET state = 'failed', version = 2, terminal_reason_code = 'cancelled' WHERE id = 'first_client_offer_review'"
        )
        .run();
    } finally {
      await context.destroy();
    }

    await expect(
      bootstrapFirstClientRevenue({ projectRoot, packPath, databaseFile, apply: true })
    ).rejects.toThrow(/must remain queued for review/i);
  });

  it('fails closed when the task-market repository returns quote or state drift', async () => {
    const databaseFile = join(temporaryRoot, 'activation-drift.sqlite');
    await bootstrapFirstClientRevenue({ projectRoot, packPath, databaseFile, apply: true });
    const context = await createDatabase({ projectRoot, filename: databaseFile });
    let activation;
    try {
      activation = (
        await new RevenuePipelineRepository(context.db).readLaneSnapshot({
          lane: 'task_market',
          limit: 10
        })
      ).activation;
    } finally {
      await context.destroy();
    }
    if (activation === null) throw new Error('Expected task-market activation fixture');

    vi.spyOn(
      RevenuePipelineRepository.prototype,
      'initializeTaskMarketContract'
    ).mockResolvedValueOnce({
      ...activation,
      x402: {
        ...activation.x402,
        quote: { ...activation.x402.quote, amountMicrousd: 500_001 }
      }
    });
    await expect(
      bootstrapFirstClientRevenue({ projectRoot, packPath, databaseFile, apply: true })
    ).rejects.toThrow(/exact simulation only/i);

    vi.spyOn(
      RevenuePipelineRepository.prototype,
      'initializeTaskMarketContract'
    ).mockResolvedValueOnce({ ...activation, state: 'contract_only' });
    vi.spyOn(
      RevenuePipelineRepository.prototype,
      'enableTaskMarketSimulation'
    ).mockResolvedValueOnce({ ...activation, state: 'contract_only' });
    await expect(
      bootstrapFirstClientRevenue({ projectRoot, packPath, databaseFile, apply: true })
    ).rejects.toThrow(/exact simulation only/i);
  });

  it('fails closed if validated internal draft data drifts to an external channel', async () => {
    const parseDraft = CreateOutreachDraftInputSchema.parse.bind(CreateOutreachDraftInputSchema);
    vi.spyOn(CreateOutreachDraftInputSchema, 'parse').mockImplementation((input) => ({
      ...parseDraft(input),
      channel: 'email'
    }));

    await expect(bootstrapFirstClientRevenue({ projectRoot, packPath })).rejects.toThrow(
      /internal draft channel must remain other/i
    );
  });
});

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function nestedCopy(
  value: Record<string, unknown>,
  mutate: (copy: Record<string, unknown>) => void
): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  mutate(copy);
  return copy;
}

interface LedgerInspection {
  events: number;
  prospects: number;
  identifiedProspects: number;
  offers: number;
  outreachDrafts: number;
  activationState: string;
  activationVersion: number;
  quotedAmountMicrousd: number;
  simulations: number;
  passingSimulations: number;
  contactReferences: string[];
  simulationScenarios: string[];
  queueTasks: number;
  queueEvents: number;
  queuePayloadKinds: string[];
  queueStates: string[];
  queueTenantIds: string[];
  queuePayloadJson: string[];
}

async function inspectLedger(databaseFile: string): Promise<LedgerInspection> {
  let context: GlobalDatabaseContext | undefined;
  try {
    context = await createDatabase({ projectRoot, filename: databaseFile });
    const repository = new RevenuePipelineRepository(context.db);
    const [agency, taskMarket] = await Promise.all([
      repository.readLaneSnapshot({ lane: 'agency', limit: 50 }),
      repository.readLaneSnapshot({ lane: 'task_market', limit: 50 })
    ]);
    const activation = taskMarket.activation;
    if (activation === null) throw new Error('Expected task-market activation');
    const count = (table: string, where = ''): number =>
      (
        context?.sqlite.prepare(`SELECT count(*) AS count FROM ${table} ${where}`).get() as {
          count: number;
        }
      ).count;
    const contactReferences = context.sqlite
      .prepare('SELECT contact_reference FROM revenue_prospects ORDER BY id')
      .all()
      .map((row) => (row as { contact_reference: string }).contact_reference);
    const queueRows = context.sqlite
      .prepare(
        'SELECT tenant_id, payload_kind, payload_json, state FROM work_queue_tasks ORDER BY id'
      )
      .all() as Array<{
      tenant_id: string;
      payload_kind: string;
      payload_json: string;
      state: string;
    }>;
    return {
      events: count('revenue_pipeline_events'),
      prospects: agency.counts.prospects,
      identifiedProspects: count('revenue_prospects', "WHERE status = 'identified'"),
      offers: agency.counts.offers,
      outreachDrafts: agency.counts.outreachDrafts,
      activationState: activation.state,
      activationVersion: activation.version,
      quotedAmountMicrousd: activation.x402.quote.amountMicrousd,
      simulations: taskMarket.counts.simulations,
      passingSimulations: taskMarket.simulations.filter(({ outcome }) => outcome === 'pass').length,
      contactReferences,
      simulationScenarios: taskMarket.simulations.map(({ scenario }) => scenario).sort(),
      queueTasks: count('work_queue_tasks'),
      queueEvents: count('work_queue_events'),
      queuePayloadKinds: queueRows.map(({ payload_kind: value }) => value).sort(),
      queueStates: queueRows.map(({ state }) => state).sort(),
      queueTenantIds: queueRows.map(({ tenant_id: value }) => value).sort(),
      queuePayloadJson: queueRows.map(({ payload_json: value }) => value)
    };
  } finally {
    await context?.destroy();
  }
}

async function claimAutomationOnly(databaseFile: string): Promise<unknown> {
  const context = await createDatabase({ projectRoot, filename: databaseFile });
  try {
    return await new PriorityQueueRepository(context.db).claimNext({
      tenantId: 'jarvis',
      workerId: 'bootstrap-test-worker',
      leaseToken: 'bootstrap-test-lease',
      now: '2026-07-18T01:00:00.000Z',
      leaseDurationMs: 60_000,
      payloadKinds: ['automation']
    });
  } finally {
    await context.destroy();
  }
}
