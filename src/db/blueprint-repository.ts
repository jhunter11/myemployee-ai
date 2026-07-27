import { createHash } from 'node:crypto';

import type { Kysely, Selectable, Transaction } from 'kysely';
import { z } from 'zod';

import {
  BLUEPRINT_RUNTIME_CAPABILITIES,
  BlueprintActorSchema,
  BlueprintConfigSchema,
  BlueprintGateObservationSchema,
  BlueprintProposerSchema,
  BlueprintReasonCodeSchema,
  BlueprintStateSchema,
  CreateBlueprintProposalInputSchema,
  type BlueprintActor,
  type BlueprintDecisionCode,
  type BlueprintEvent,
  type BlueprintGateDecision,
  type BlueprintGateObservation,
  type BlueprintProposer,
  type BlueprintReasonCode,
  type BlueprintRecord,
  type BlueprintState,
  type CreateBlueprintProposalInput
} from '../blueprints/contracts';
import { AppError } from '../utils/errors';
import type { AgentBlueprintEventsTable, AgentBlueprintsTable, JarvisDatabase } from './types';

const GateDecisionSchema = z.strictObject({
  passed: z.boolean(),
  reasons: z.array(z.string().min(1).max(128)).max(32)
});

const DecisionCodeSchema = z.enum([
  'proposal_recorded',
  'stage_evidence_recorded',
  'gate_passed',
  'operator_approved',
  'operator_rejected',
  'operator_rollback',
  'operator_retired',
  'automatic_gate_rollback'
]);

interface TransitionRecordInput {
  blueprintId: string;
  revision: number;
  expectedVersion: number;
  fromState: BlueprintState;
  toState: BlueprintState;
  actor: BlueprintActor;
  decisionCode: BlueprintDecisionCode;
  reasonCode: BlueprintReasonCode | null;
  evidenceDigest: string;
  gateDecision: BlueprintGateDecision | null;
  observation: BlueprintGateObservation | null;
  observedAt: string;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalValue(nested)])
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function canonicalTimestamp(value: string): string {
  return new Date(value).toISOString();
}

function decodeJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function recordFromRow(row: Selectable<AgentBlueprintsTable>): BlueprintRecord {
  const config = BlueprintConfigSchema.parse(decodeJson(row.config_json));
  const canonicalConfig = canonicalJson(config);
  if (sha256(canonicalConfig) !== row.config_sha256) {
    throw new AppError(
      500,
      'BLUEPRINT_CONFIG_DIGEST_MISMATCH',
      `Blueprint ${row.blueprint_id}@${row.revision} failed its immutable digest check`
    );
  }
  if (config.implementationDigest !== row.implementation_digest) {
    throw new AppError(
      500,
      'BLUEPRINT_IMPLEMENTATION_DIGEST_MISMATCH',
      `Blueprint ${row.blueprint_id}@${row.revision} has inconsistent implementation evidence`
    );
  }

  return {
    blueprintId: row.blueprint_id,
    revision: row.revision,
    config,
    configDigest: row.config_sha256,
    implementationId: row.implementation_id,
    state: BlueprintStateSchema.parse(row.state),
    stateVersion: row.state_version,
    proposer: BlueprintProposerSchema.parse({ id: row.proposer_id, kind: row.proposer_kind }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    runtime: BLUEPRINT_RUNTIME_CAPABILITIES
  };
}

function eventFromRow(row: Selectable<AgentBlueprintEventsTable>): BlueprintEvent {
  const actorCandidate = { id: row.actor_id, kind: row.actor_kind };
  const actor =
    row.actor_kind === 'research_feed'
      ? BlueprintProposerSchema.parse(actorCandidate)
      : BlueprintActorSchema.parse(actorCandidate);
  const gateDecision =
    row.gate_decision_json === null
      ? null
      : GateDecisionSchema.parse(decodeJson(row.gate_decision_json));
  const observation =
    row.policy_gate_json === null && row.economics_gate_json === null
      ? null
      : BlueprintGateObservationSchema.parse({
          policy: row.policy_gate_json === null ? null : decodeJson(row.policy_gate_json),
          economics: row.economics_gate_json === null ? null : decodeJson(row.economics_gate_json)
        });

  return {
    sequence: row.sequence,
    blueprintId: row.blueprint_id,
    revision: row.revision,
    fromState: row.from_state === null ? null : BlueprintStateSchema.parse(row.from_state),
    toState: BlueprintStateSchema.parse(row.to_state),
    stateVersion: row.state_version,
    actor,
    decisionCode: DecisionCodeSchema.parse(row.decision_code),
    reasonCode: row.reason_code === null ? null : BlueprintReasonCodeSchema.parse(row.reason_code),
    evidenceDigest: row.evidence_digest,
    gateDecision,
    observation,
    observedAt: row.observed_at
  };
}

export class BlueprintRepository {
  constructor(private readonly db: Kysely<JarvisDatabase>) {}

  async createProposal(
    rawInput: CreateBlueprintProposalInput,
    implementationId: string
  ): Promise<BlueprintRecord> {
    const input = CreateBlueprintProposalInputSchema.parse(rawInput);
    const configJson = canonicalJson(input.config);
    const timestamp = canonicalTimestamp(input.proposedAt);

    return this.db.transaction().execute(async (transaction) => {
      let row: Selectable<AgentBlueprintsTable>;
      try {
        row = await transaction
          .insertInto('agent_blueprints')
          .values({
            blueprint_id: input.config.blueprintId,
            revision: input.config.revision,
            previous_revision: input.config.previousRevision,
            config_json: configJson,
            config_sha256: sha256(configJson),
            implementation_id: implementationId,
            implementation_digest: input.config.implementationDigest,
            proposer_id: input.proposer.id,
            proposer_kind: input.proposer.kind,
            state: 'proposed',
            state_version: 1,
            created_at: timestamp,
            updated_at: timestamp
          })
          .returningAll()
          .executeTakeFirstOrThrow();
      } catch (error) {
        if (error instanceof Error && /UNIQUE constraint failed/u.test(error.message)) {
          throw new AppError(
            409,
            'BLUEPRINT_REVISION_EXISTS',
            `Blueprint ${input.config.blueprintId}@${input.config.revision} already exists`
          );
        }
        throw error;
      }

      await this.appendEvent(transaction, {
        blueprintId: input.config.blueprintId,
        revision: input.config.revision,
        fromState: null,
        toState: 'proposed',
        stateVersion: 1,
        actor: input.proposer,
        decisionCode: 'proposal_recorded',
        reasonCode: null,
        evidenceDigest: input.config.provenance.evidenceDigest,
        gateDecision: null,
        observation: null,
        observedAt: timestamp
      });
      return recordFromRow(row);
    });
  }

  async transition(input: TransitionRecordInput): Promise<BlueprintRecord> {
    const observedAt = canonicalTimestamp(input.observedAt);
    const actor = BlueprintActorSchema.parse(input.actor);
    const gateDecision =
      input.gateDecision === null ? null : GateDecisionSchema.parse(input.gateDecision);
    const observation =
      input.observation === null ? null : BlueprintGateObservationSchema.parse(input.observation);
    const decisionCode = DecisionCodeSchema.parse(input.decisionCode);
    const fromState = BlueprintStateSchema.parse(input.fromState);
    const toState = BlueprintStateSchema.parse(input.toState);

    return this.db.transaction().execute(async (transaction) => {
      const existing = await transaction
        .selectFrom('agent_blueprints')
        .selectAll()
        .where('blueprint_id', '=', input.blueprintId)
        .where('revision', '=', input.revision)
        .executeTakeFirst();
      if (existing === undefined) {
        throw new AppError(
          404,
          'BLUEPRINT_NOT_FOUND',
          `Blueprint ${input.blueprintId}@${input.revision} was not found`
        );
      }
      if (existing.state_version !== input.expectedVersion || existing.state !== fromState) {
        throw new AppError(
          409,
          'BLUEPRINT_VERSION_CONFLICT',
          `Blueprint ${input.blueprintId}@${input.revision} version or state changed`
        );
      }

      await this.appendEvent(transaction, {
        blueprintId: input.blueprintId,
        revision: input.revision,
        fromState,
        toState,
        stateVersion: input.expectedVersion + 1,
        actor,
        decisionCode,
        reasonCode: input.reasonCode,
        evidenceDigest: input.evidenceDigest,
        gateDecision,
        observation,
        observedAt
      });

      const row = await transaction
        .updateTable('agent_blueprints')
        .set({
          state: toState,
          state_version: input.expectedVersion + 1,
          updated_at: observedAt
        })
        .where('blueprint_id', '=', input.blueprintId)
        .where('revision', '=', input.revision)
        .where('state', '=', fromState)
        .where('state_version', '=', input.expectedVersion)
        .returningAll()
        .executeTakeFirstOrThrow();

      return recordFromRow(row);
    });
  }

  async find(blueprintId: string, revision: number): Promise<BlueprintRecord | undefined> {
    const row = await this.db
      .selectFrom('agent_blueprints')
      .selectAll()
      .where('blueprint_id', '=', blueprintId)
      .where('revision', '=', revision)
      .executeTakeFirst();
    return row === undefined ? undefined : recordFromRow(row);
  }

  async listEvents(
    blueprintId: string,
    revision: number,
    limit: number
  ): Promise<BlueprintEvent[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError('blueprint event limit must be an integer between 1 and 100');
    }
    const rows = await this.db
      .selectFrom('agent_blueprint_events')
      .selectAll()
      .where('blueprint_id', '=', blueprintId)
      .where('revision', '=', revision)
      .orderBy('sequence', 'asc')
      .limit(limit)
      .execute();
    return rows.map(eventFromRow);
  }

  private appendEvent(
    transaction: Transaction<JarvisDatabase>,
    input: {
      blueprintId: string;
      revision: number;
      fromState: BlueprintState | null;
      toState: BlueprintState;
      stateVersion: number;
      actor: BlueprintActor | BlueprintProposer;
      decisionCode: BlueprintDecisionCode;
      reasonCode: BlueprintReasonCode | null;
      evidenceDigest: string;
      gateDecision: BlueprintGateDecision | null;
      observation: BlueprintGateObservation | null;
      observedAt: string;
    }
  ): Promise<unknown> {
    return transaction
      .insertInto('agent_blueprint_events')
      .values({
        blueprint_id: input.blueprintId,
        revision: input.revision,
        from_state: input.fromState,
        to_state: input.toState,
        state_version: input.stateVersion,
        actor_id: input.actor.id,
        actor_kind: input.actor.kind,
        decision_code: input.decisionCode,
        reason_code: input.reasonCode,
        evidence_digest: input.evidenceDigest,
        gate_decision_json: input.gateDecision === null ? null : canonicalJson(input.gateDecision),
        policy_gate_json:
          input.observation === null ? null : canonicalJson(input.observation.policy),
        economics_gate_json:
          input.observation === null ? null : canonicalJson(input.observation.economics),
        observed_at: input.observedAt
      })
      .executeTakeFirstOrThrow();
  }
}
