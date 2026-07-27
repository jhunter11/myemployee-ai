import type { RevenuePipelineRepository } from '../db/revenue-pipeline-repository';
import {
  REVENUE_PIPELINE_SAFETY,
  type CreateOfferInput,
  type CreateOutreachDraftInput,
  type CreateProspectInput,
  type EnableTaskMarketSimulationInput,
  type InitializeTaskMarketContractInput,
  type RecordTaskMarketSimulationInput,
  type TransitionOfferInput,
  type TransitionOutreachDraftInput,
  type TransitionProspectInput
} from './contracts';

type Clock = () => Date;

/**
 * Local control-plane facade. It intentionally has no network, messaging,
 * payment, wallet, settlement, or revenue-recognition collaborator.
 */
export class RevenuePipelineService {
  readonly safety = REVENUE_PIPELINE_SAFETY;

  constructor(
    private readonly repository: RevenuePipelineRepository,
    private readonly clock: Clock = () => new Date()
  ) {}

  identifyProspect(input: Omit<CreateProspectInput, 'createdAt'>) {
    return this.repository.createProspect({ ...input, createdAt: this.now() });
  }

  setProspectStatus(input: Omit<TransitionProspectInput, 'changedAt'>) {
    return this.repository.transitionProspect({ ...input, changedAt: this.now() });
  }

  draftOffer(input: Omit<CreateOfferInput, 'createdAt'>) {
    return this.repository.createOffer({ ...input, createdAt: this.now() });
  }

  setOfferStatus(input: Omit<TransitionOfferInput, 'changedAt'>) {
    return this.repository.transitionOffer({ ...input, changedAt: this.now() });
  }

  prepareOutreachDraft(input: Omit<CreateOutreachDraftInput, 'createdAt'>) {
    return this.repository.createOutreachDraft({ ...input, createdAt: this.now() });
  }

  setOutreachDraftStatus(input: Omit<TransitionOutreachDraftInput, 'changedAt'>) {
    return this.repository.transitionOutreachDraft({ ...input, changedAt: this.now() });
  }

  establishTaskMarketContract(input: Omit<InitializeTaskMarketContractInput, 'createdAt'>) {
    return this.repository.initializeTaskMarketContract({ ...input, createdAt: this.now() });
  }

  enableTaskMarketSimulation(input: Omit<EnableTaskMarketSimulationInput, 'changedAt'>) {
    return this.repository.enableTaskMarketSimulation({ ...input, changedAt: this.now() });
  }

  recordTaskMarketSimulation(input: Omit<RecordTaskMarketSimulationInput, 'recordedAt'>) {
    return this.repository.recordTaskMarketSimulation({ ...input, recordedAt: this.now() });
  }

  readLane(input: { lane: 'agency' | 'task_market'; limit: number }) {
    return this.repository.readLaneSnapshot(input);
  }

  readAudit(input: { lane: 'agency' | 'task_market'; limit: number }) {
    return this.repository.readEvents(input);
  }

  private now(): string {
    return this.clock().toISOString();
  }
}
