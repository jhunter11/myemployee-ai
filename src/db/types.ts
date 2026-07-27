import type { ColumnType, Generated } from 'kysely';

type CreatedAt = ColumnType<string, string | undefined, never>;
type UpdatedAt = ColumnType<string, string | undefined, string>;

export interface ClientRegistryTable {
  id: string;
  name: string;
  profile_type: string;
  created_at: CreatedAt;
  status: ColumnType<string, string | undefined, string>;
}

export interface AgencyMetricsTable {
  id: Generated<number>;
  recorded_at: CreatedAt;
  total_active_clients: number | null;
  total_monthly_recurring_revenue: number | null;
  total_token_spend: number | null;
}

export interface AuditLogsTable {
  id: Generated<number>;
  timestamp: CreatedAt;
  severity: string;
  event_description: string;
  client_id: string | null;
  resolved: ColumnType<number, number | boolean | undefined, number | boolean>;
}

export interface TaskFrequencyLogTable {
  id: Generated<number>;
  task_signature: string;
  execution_count: ColumnType<number, number | undefined, number>;
  avg_duration_seconds: number | null;
  last_executed_at: UpdatedAt;
  manual_intervention_count: ColumnType<number, number | undefined, number>;
}

export type AgentRunStatus = 'pending' | 'running' | 'succeeded' | 'failed';

export interface AgentRunsTable {
  id: string;
  client_id: string;
  automation: string;
  status: AgentRunStatus;
  input_json: string | null;
  output_json: string | null;
  error_message: string | null;
  parent_run_id: string | null;
  worker_id: string | null;
  started_at: CreatedAt;
  completed_at: string | null;
}

export interface RunRecoveryQueueTable {
  run_id: string;
  queued_at: CreatedAt;
  audit_id: number | null;
}

export interface ModelUsageEventsTable {
  id: string;
  recorded_at: string;
  client_id: string | null;
  operation: string;
  provider: string;
  model: string;
  route: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  latency_ms: number;
  status: string;
  cost_basis: string;
  cost_microusd: number | null;
  pricing_version: string | null;
}

export interface KnowledgeScopesTable {
  scope_id: string;
  scope_kind: string;
  subject_id: string;
  parent_scope_id: string | null;
  client_id: string | null;
  root_key: string;
  graph_partition: string;
  created_at: string;
}

export interface WorkQueueTasksTable {
  id: string;
  tenant_id: string;
  lane: string;
  source_kind: string;
  source_id: string;
  source_occurred_at: string;
  payload_kind: string;
  payload_json: string;
  policy_band: string;
  impact: number;
  urgency: number;
  effort: number;
  base_score: number;
  state: string;
  version: ColumnType<number, number, number>;
  dependency_count: number;
  created_at: string;
  available_at: string;
  updated_at: string;
  lease_owner: string | null;
  lease_token: string | null;
  lease_expires_at: string | null;
  attempt_count: ColumnType<number, number | undefined, number>;
  terminal_reason_code: string | null;
}

export interface WorkQueueDependenciesTable {
  tenant_id: string;
  task_id: string;
  dependency_task_id: string;
}

export interface WorkQueueLanesTable {
  tenant_id: string;
  lane: string;
  last_claim_sequence: ColumnType<number, number | undefined, number>;
  claim_count: ColumnType<number, number | undefined, number>;
}

export interface WorkQueueTenantCursorsTable {
  tenant_id: string;
  last_claim_sequence: ColumnType<number, number | undefined, number>;
}

export interface WorkQueueEventsTable {
  sequence: Generated<number>;
  task_id: string;
  tenant_id: string;
  event_at: string;
  event_type: string;
  decision_code: string;
  actor_id: string;
  from_state: string | null;
  to_state: string;
  task_version: number;
  detail_json: string;
}

export interface RevenueProspectsTable {
  id: string;
  lane: string;
  public_label: string;
  contact_channel: string;
  contact_reference: string | null;
  source: string;
  need: string;
  status: string;
  version: ColumnType<number, number, number>;
  created_at: string;
  updated_at: string;
}

export interface RevenueOffersTable {
  id: string;
  prospect_id: string;
  lane: string;
  title: string;
  deliverable: string;
  proposed_amount_microusd: number;
  currency: string;
  turnaround_hours: number;
  revision_limit: number;
  status: string;
  version: ColumnType<number, number, number>;
  created_at: string;
  updated_at: string;
}

export interface RevenueOutreachDraftsTable {
  id: string;
  prospect_id: string;
  offer_id: string;
  lane: string;
  channel: string;
  subject: string;
  body: string;
  content_sha256: string;
  status: string;
  version: ColumnType<number, number, number>;
  created_at: string;
  updated_at: string;
}

export interface TaskMarketActivationTable {
  id: string;
  product_id: string;
  a2a_version: string;
  a2a_skill_id: string;
  input_contract: string;
  output_contract: string;
  contract_sha256: string;
  x402_scheme: string;
  quoted_amount_microusd: number;
  currency: string;
  activation_state: string;
  network_mode: string;
  payment_mode: string;
  wallet_mode: string;
  version: ColumnType<number, number, number>;
  created_at: string;
  updated_at: string;
}

export interface TaskMarketSimulationsTable {
  id: string;
  activation_id: string;
  activation_version: number;
  scenario: string;
  outcome: string;
  request_sha256: string;
  evidence_sha256: string;
  quoted_amount_microusd: number;
  currency: string;
  simulation_only: ColumnType<number, number, never>;
  recorded_at: string;
}

export interface RevenuePipelineEventsTable {
  sequence: Generated<number>;
  lane: string;
  entity_type: string;
  entity_id: string;
  event_type: string;
  from_status: string | null;
  to_status: string;
  entity_version: number;
  actor_id: string;
  detail_json: string;
  occurred_at: string;
}

export interface AgentConversationsTable {
  id: string;
  agent_id: string;
  trust_domain: string;
  title: string | null;
  version: ColumnType<number, number | undefined, number>;
  created_at: string;
  updated_at: string;
}

export interface AgentMessagesTable {
  id: string;
  conversation_id: string;
  conversation_agent_id: string;
  trust_domain: string;
  sequence: number;
  author_kind: string;
  responding_agent_id: string | null;
  response_mode: string;
  message_text: string;
  evidence_refs_json: string;
  created_at: string;
}

export interface AgentConversationTurnClaimsTable {
  conversation_id: string;
  conversation_agent_id: string;
  trust_domain: string;
  expected_version: number;
  claim_id: string;
  claimed_at: string;
  expires_at: string;
}

export interface AgentBlueprintsTable {
  blueprint_id: string;
  revision: number;
  previous_revision: number | null;
  config_json: string;
  config_sha256: string;
  implementation_id: string;
  implementation_digest: string;
  proposer_id: string;
  proposer_kind: string;
  state: string;
  state_version: ColumnType<number, number, number>;
  created_at: string;
  updated_at: string;
}

export interface AgentBlueprintEventsTable {
  sequence: Generated<number>;
  blueprint_id: string;
  revision: number;
  from_state: string | null;
  to_state: string;
  state_version: number;
  actor_id: string;
  actor_kind: string;
  decision_code: string;
  reason_code: string | null;
  evidence_digest: string;
  gate_decision_json: string | null;
  policy_gate_json: string | null;
  economics_gate_json: string | null;
  observed_at: string;
}

export interface ControlScopesTable {
  scope_id: string;
  scope_kind: string;
  subject_id: string;
  parent_scope_id: string | null;
  trust_domain: string;
  state: string;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface AccessAgentsTable {
  agent_id: string;
  home_scope_id: string;
  trust_domain: string;
  profile_revision: number;
  state: string;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface AgentProfileInstancesTable {
  instance_id: string;
  recipe_id: string;
  recipe_sha256: string;
  scope_id: string;
  scope_version: number;
  knowledge_scope_id: string;
  manifest_json: string;
  manifest_sha256: string;
  approved_by: string;
  state: string;
  version: number;
  created_at: string;
  expires_at: string;
  activated_at: string | null;
  expired_at: string | null;
  updated_at: string;
}

export interface AgentProfileInstanceMembersTable {
  agent_id: string;
  instance_id: string;
  template_profile_id: string;
  ordinal: number;
  profile_json: string;
  profile_sha256: string;
  created_at: string;
}

export interface MemorySleevesTable {
  sleeve_id: string;
  owner_scope_id: string;
  sleeve_kind: string;
  max_sensitivity: string;
  partition_key: string;
  expires_at: string | null;
  state: string;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface AgentSleeveGrantsTable {
  grant_id: string;
  agent_id: string;
  sleeve_id: string;
  authority_layer: string;
  permission: string;
  purpose: string;
  sensitivity_cap: string;
  expires_at: string;
  state: string;
  version: number;
  bound_agent_version: number;
  bound_scope_version: number;
  bound_sleeve_version: number;
  created_at: string;
  updated_at: string;
}

export interface AgentToolGrantsTable {
  grant_id: string;
  agent_id: string;
  tool_id: string;
  authority_layer: string;
  access: string;
  purpose: string;
  sensitivity_cap: string;
  expires_at: string;
  state: string;
  version: number;
  bound_agent_version: number;
  bound_scope_version: number;
  created_at: string;
  updated_at: string;
}

export interface SharedApprovedBundlesTable {
  bundle_id: string;
  source_scope_id: string;
  source_scope_version: number;
  target_sleeve_id: string;
  target_scope_version: number;
  target_sleeve_version: number;
  purpose: string;
  published_sensitivity: string;
  fragments_json: string;
  content_sha256: string;
  reviewed_by: string;
  reviewed_at: string;
  expires_at: string;
  state: string;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface WorkingMemoryTable {
  entry_id: string;
  owner_scope_id: string;
  sleeve_id: string;
  run_id: string;
  slot_key: string;
  content: string;
  content_sha256: string;
  sensitivity: string;
  recorded_at: string;
  expires_at: string;
  supersedes_entry_id: string | null;
  superseded_by_entry_id: string | null;
}

export interface MemoryConsolidationCandidatesTable {
  candidate_id: string;
  owner_scope_id: string;
  sleeve_id: string;
  target_store: string;
  proposed_kind: string;
  title: string;
  content: string;
  source_fragment_ids_json: string;
  evidence_count: number;
  temporal_state: string;
  confidence_permille: number;
  rationale: string;
  planner_version: string;
  proposed_by: string;
  sensitivity: string;
  content_sha256: string;
  recorded_at: string;
  expires_at: string;
  supersedes_candidate_id: string | null;
  superseded_by_candidate_id: string | null;
}

export interface MemoryProcedureCandidatesTable {
  candidate_id: string;
  owner_scope_id: string;
  sleeve_id: string;
  workflow_signature: string;
  title: string;
  steps_json: string;
  success_count: number;
  first_seen_at: string;
  last_seen_at: string;
  rationale: string;
  planner_version: string;
  proposed_by: string;
  sensitivity: string;
  content_sha256: string;
  recorded_at: string;
  expires_at: string;
  supersedes_candidate_id: string | null;
  superseded_by_candidate_id: string | null;
}

export type MemoryMaintenanceJobState = 'pending' | 'leased' | 'completed' | 'dead_letter';

export interface MemoryMaintenanceOutboxTable {
  job_id: string;
  run_id: string;
  job_kind: 'terminal_episode_and_consolidation';
  policy_revision: string;
  agent_id: string;
  expected_agent_version: number;
  owner_scope_id: string;
  expected_owner_scope_version: number;
  sleeve_id: string;
  expected_sleeve_version: number;
  purpose: string;
  sensitivity: string;
  grant_versions_json: string;
  state: MemoryMaintenanceJobState;
  version: number;
  attempt_count: number;
  available_at: string;
  lease_owner: string | null;
  lease_token: string | null;
  lease_expires_at: string | null;
  last_error_code: string | null;
  queued_at: string;
  completed_at: string | null;
}

export interface MemoryMaintenanceOutboxEventsTable {
  sequence: Generated<number>;
  job_id: string;
  event_type: string;
  from_state: string | null;
  to_state: string;
  job_version: number;
  attempt_count: number;
  actor_id: string;
  decision_code: string;
  occurred_at: string;
  detail_json: string;
}

export interface AccessLifecycleEventsTable {
  event_sequence: Generated<number>;
  event_id: string;
  resource_kind: string;
  resource_id: string;
  action: string;
  replacement_resource_id: string | null;
  prior_version: number;
  resulting_version: number;
  actor_id: string;
  reason: string;
  evidence_sha256: string;
  occurred_at: string;
}

export interface AgencyExecutionPostureTable {
  singleton_id: 'agency';
  posture: 'active' | 'paused';
  version: ColumnType<number, number, number>;
  updated_at: string;
  updated_by: string;
  reason: string;
  source_proposal_id: string | null;
  source_proposal_version: number | null;
  source_confirmation_fingerprint: string | null;
  source_decision_id: string | null;
}

export interface AgencyExecutionPostureEventsTable {
  sequence: Generated<number>;
  event_id: string;
  from_posture: 'active' | 'paused' | null;
  to_posture: 'active' | 'paused';
  resulting_version: number;
  actor_id: string;
  reason: string;
  source_proposal_id: string | null;
  source_proposal_version: number | null;
  source_confirmation_fingerprint: string | null;
  source_decision_id: string | null;
  occurred_at: string;
}

export type ArtifactScopeClaimState =
  'executing' | 'verification_pending' | 'finalization_pending' | 'released' | 'abandoned';

export interface ArtifactScopeClaimsTable {
  claim_id: string;
  artifact_scope_key: string;
  tenant_id: string;
  automation_id: string;
  task_id: string;
  run_id: string;
  version: ColumnType<number, number, number>;
  state: ArtifactScopeClaimState;
  captured_queue_version: number;
  acquired_at: string;
  updated_at: string;
  terminal_at: string | null;
  terminal_evidence_kind: string | null;
  terminal_evidence_id: string | null;
  terminal_evidence_sha256: string | null;
}

export interface SourceSnapshotClaimsTable {
  source_claim_id: string;
  artifact_claim_id: string;
  task_id: string;
  run_id: string;
  tenant_id: string;
  automation_id: string;
  source_registration_id: string;
  snapshot_relative_path: string;
  size: number;
  source_sha256: string;
  created_at: string;
}

export interface RunCompletionCandidatesTable {
  candidate_id: string;
  occurrence_id: string | null;
  execution_request_id: string;
  task_id: string;
  run_id: string;
  tenant_id: string;
  automation_id: string;
  worker_id: string;
  artifact_claim_id: string;
  artifact_scope_key: string;
  source_claim_id: string;
  source_sha256: string;
  result_schema_version: number;
  canonical_result_json: string;
  result_sha256: string;
  artifact_sha256: string;
  journal_claim_id: string;
  journal_claim_sha256: string;
  criteria_sha256: string;
  captured_posture_version: number;
  committed_at: string;
}

export interface WorkQueueVerificationHoldsTable {
  hold_id: string;
  candidate_id: string;
  task_id: string;
  run_id: string;
  tenant_id: string;
  automation_id: string;
  execution_request_id: string;
  occurrence_id: string | null;
  artifact_claim_id: string;
  artifact_scope_key: string;
  source_claim_id: string;
  leased_version: number;
  queue_attempt: number;
  lease_owner: string;
  captured_posture_version: number;
  artifact_claim_version: number;
  verifier_id: string;
  verifier_revision: string;
  criteria_sha256: string;
  created_at: string;
  resolved_at: string | null;
}

export interface JarvisDatabase {
  client_registry: ClientRegistryTable;
  agency_metrics: AgencyMetricsTable;
  audit_logs: AuditLogsTable;
  task_frequency_log: TaskFrequencyLogTable;
  agent_runs: AgentRunsTable;
  run_recovery_queue: RunRecoveryQueueTable;
  model_usage_events: ModelUsageEventsTable;
  knowledge_scopes: KnowledgeScopesTable;
  work_queue_tasks: WorkQueueTasksTable;
  work_queue_dependencies: WorkQueueDependenciesTable;
  work_queue_lanes: WorkQueueLanesTable;
  work_queue_tenant_cursors: WorkQueueTenantCursorsTable;
  work_queue_events: WorkQueueEventsTable;
  revenue_prospects: RevenueProspectsTable;
  revenue_offers: RevenueOffersTable;
  revenue_outreach_drafts: RevenueOutreachDraftsTable;
  task_market_activation: TaskMarketActivationTable;
  task_market_simulations: TaskMarketSimulationsTable;
  revenue_pipeline_events: RevenuePipelineEventsTable;
  agent_conversations: AgentConversationsTable;
  agent_messages: AgentMessagesTable;
  agent_conversation_turn_claims: AgentConversationTurnClaimsTable;
  agent_blueprints: AgentBlueprintsTable;
  agent_blueprint_events: AgentBlueprintEventsTable;
  control_scopes: ControlScopesTable;
  access_agents: AccessAgentsTable;
  agent_profile_instances: AgentProfileInstancesTable;
  agent_profile_instance_members: AgentProfileInstanceMembersTable;
  memory_sleeves: MemorySleevesTable;
  agent_sleeve_grants: AgentSleeveGrantsTable;
  agent_tool_grants: AgentToolGrantsTable;
  shared_approved_bundles: SharedApprovedBundlesTable;
  working_memory: WorkingMemoryTable;
  memory_consolidation_candidates: MemoryConsolidationCandidatesTable;
  memory_procedure_candidates: MemoryProcedureCandidatesTable;
  memory_maintenance_outbox: MemoryMaintenanceOutboxTable;
  memory_maintenance_outbox_events: MemoryMaintenanceOutboxEventsTable;
  access_lifecycle_events: AccessLifecycleEventsTable;
  agency_execution_posture: AgencyExecutionPostureTable;
  agency_execution_posture_events: AgencyExecutionPostureEventsTable;
  artifact_scope_claims: ArtifactScopeClaimsTable;
  source_snapshot_claims: SourceSnapshotClaimsTable;
  run_completion_candidates: RunCompletionCandidatesTable;
  work_queue_verification_holds: WorkQueueVerificationHoldsTable;
}

export interface TaskHistoryTable {
  id: Generated<number>;
  workflow_name: string;
  started_at: CreatedAt;
  completed_at: string | null;
  status: string;
  tokens_used: ColumnType<number, number | undefined, number>;
  result_summary: string | null;
}

export interface CrmLeadsTable {
  id: string;
  email: string;
  name: string | null;
  company: string | null;
  status: ColumnType<string, string | undefined, string>;
  last_contacted_at: string | null;
  ai_analysis_notes: string | null;
}

export interface AgentScratchpadTable {
  id: Generated<number>;
  key: string;
  value_json: string;
  updated_at: UpdatedAt;
}

export interface ClientDatabase {
  task_history: TaskHistoryTable;
  crm_leads: CrmLeadsTable;
  agent_scratchpad: AgentScratchpadTable;
}
