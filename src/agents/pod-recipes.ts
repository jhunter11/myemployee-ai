/**
 * The pod recipe layer.
 *
 * A recipe composes archetypes into a working unit and binds them to one sleeve
 * and knowledge scope. Everything structural — parent wiring, escalation
 * targets, sleeve names, budget classes — is derived from the archetype in
 * `expandRecipe`. What stays here is domain content that no archetype can
 * supply: purpose, tools, continuation stages, and completion criteria.
 *
 * Adding a pod for a new sleeve means adding a recipe, not editing the catalog.
 */
import type { AgentLifecycle, AgentRuntimeMode, AgentTrustDomain } from './profile-catalog';
import type { AgentRelation, BudgetKind } from './archetypes';

export type ToolSeed = readonly [
  id: string,
  access: 'read' | 'propose' | 'execute',
  purpose: string
];

export interface PodMember {
  readonly id: string;
  readonly relation: AgentRelation;
  readonly displayName: string;
  readonly role: string;
  readonly purpose: string;
  readonly lifecycle: AgentLifecycle;
  readonly runtimeMode: AgentRuntimeMode;
  /** Required when the archetype's sleeve rule is `explicit`; otherwise an override. */
  readonly sleeve?: string;
  /** Overrides the archetype's default budget class. Must be in its allowlist. */
  readonly budget?: BudgetKind;
  readonly evidenceRefs: readonly string[];
  readonly tools: readonly ToolSeed[];
  readonly stages: readonly string[];
  readonly artifactType: string;
  readonly outputFields: readonly string[];
  readonly completionCriteria: readonly string[];
  readonly escalationConditions: readonly string[];
}

export interface PodRecipe {
  readonly id: string;
  /** Whether V2 may instantiate this recipe against an authorized runtime scope. */
  readonly runtimeInstantiable: boolean;
  readonly trustDomain: AgentTrustDomain;
  /** Parent of the pod lead. `null` only for the root pod. */
  readonly parentId: string | null;
  readonly sleeve: string;
  readonly scope: string;
  readonly lead: PodMember;
  readonly members: readonly PodMember[];
}

export const POD_RECIPES: readonly PodRecipe[] = [
  {
    id: 'jarvis',
    runtimeInstantiable: false,
    trustDomain: 'personal',
    parentId: null,
    sleeve: 'jarvis',
    scope: 'jarvis',
    lead: {
      id: 'jarvis',
      relation: 'root',
      displayName: 'Jarvis',
      role: 'Personal coordinator',
      purpose:
        'Coordinate the operator interface and synthesize only reviewed handoffs without inheriting Agency or task-market authority.',
      lifecycle: 'durable',
      runtimeMode: 'deterministic',
      evidenceRefs: ['src/chat/jarvis-chat.ts', 'SPEC.md#24-agent-workbench-v1'],
      tools: [
        ['profile.read_catalog', 'read', 'Inspect server-owned agent identities and availability.'],
        ['personal.read_snapshot', 'read', 'Read bounded personal command-center projections.'],
        [
          'shared.read_reviewed_handoffs',
          'read',
          'Read reviewed cross-domain handoff artifacts only.'
        ]
      ],
      stages: ['intake', 'route', 'collect_handoffs', 'synthesize', 'present'],
      artifactType: 'jarvis.synthesis',
      outputFields: ['answer', 'evidence_refs', 'coverage', 'approval_needs'],
      completionCriteria: [
        'The response identifies evidence, missing coverage, and any operator gate.'
      ],
      escalationConditions: ['Authority, evidence, or side-effect state is unclear.']
    },
    members: []
  },
  {
    id: 'agency',
    runtimeInstantiable: false,
    trustDomain: 'agency',
    parentId: 'jarvis',
    sleeve: 'operations',
    scope: 'operations',
    lead: {
      id: 'agency',
      relation: 'coordinator',
      displayName: 'Agency',
      role: 'Agency coordinator',
      purpose:
        'Sequence reversible internal agency work, delegate to approved profiles, reconcile evidence, and surface exact operator approvals.',
      lifecycle: 'durable',
      runtimeMode: 'profile_only',
      evidenceRefs: ['src/agency/control-center.ts', 'src/queue/priority-queue-service.ts'],
      tools: [
        ['agency.read_control', 'read', 'Read the bounded agency autonomy projection.'],
        ['queue.read_redacted', 'read', 'Inspect redacted agency queue state.'],
        [
          'queue.propose_project_task',
          'propose',
          'Propose a bounded project task for deterministic priority.'
        ],
        ['agency.propose_handoff', 'propose', 'Prepare a reviewed synthesis handoff for Jarvis.']
      ],
      stages: ['intake', 'plan', 'delegate', 'await_results', 'synthesize', 'gate_or_close'],
      artifactType: 'agency.synthesis',
      outputFields: [
        'contributors',
        'evidence_refs',
        'conflicts',
        'recommendation',
        'approval_needs'
      ],
      completionCriteria: [
        'Every delegated result is reconciled or reported as missing before handoff.'
      ],
      escalationConditions: [
        'The work crosses trust domains or requires external, privileged, or irreversible action.'
      ]
    },
    members: [
      {
        id: 'agency-chief-of-staff',
        relation: 'advisor',
        displayName: 'Chief of Staff',
        role: 'Planning advisor',
        purpose:
          'Convert an Agency objective into a dependency-aware execution plan and attention brief without assigning authority.',
        lifecycle: 'template',
        runtimeMode: 'profile_only',
        budget: 'specialist',
        evidenceRefs: [
          'src/queue/contracts.ts',
          'TASKS.md#task-25-add-profile-routing-and-bounded-apis'
        ],
        tools: [
          ['queue.read_redacted', 'read', 'Inspect bounded ready and blocked work.'],
          ['run.read_redacted', 'read', 'Inspect redacted run status and freshness.'],
          ['agency.propose_plan', 'propose', 'Propose a dependency-aware internal plan.']
        ],
        stages: [
          'objective_pinned',
          'dependencies_mapped',
          'plan_drafted',
          'risks_checked',
          'handoff'
        ],
        artifactType: 'agency.execution_plan',
        outputFields: ['objective', 'ordered_tasks', 'dependencies', 'risks', 'operator_gates'],
        completionCriteria: [
          'The plan has bounded tasks, owners, dependencies, evidence, and explicit gates.'
        ],
        escalationConditions: [
          'Priority, ownership, or authority cannot be derived from deterministic policy.'
        ]
      }
    ]
  },
  {
    id: 'developer',
    runtimeInstantiable: true,
    trustDomain: 'agency',
    parentId: 'agency',
    sleeve: 'engineering',
    scope: 'engineering',
    lead: {
      id: 'agency-developer',
      relation: 'specialist',
      displayName: 'Developer',
      role: 'Engineering coordinator',
      purpose:
        'Coordinate test-first repository changes against pinned requirements and combine independent review with deterministic verification.',
      lifecycle: 'durable',
      runtimeMode: 'profile_only',
      evidenceRefs: [
        'src/queue/task-verifier.ts',
        'TASKS.md#task-25-add-profile-routing-and-bounded-apis'
      ],
      tools: [
        ['repo.read_index', 'read', 'Read bounded structural repository evidence.'],
        ['queue.propose_project_task', 'propose', 'Propose build and review tasks.'],
        ['agency.propose_handoff', 'propose', 'Prepare an engineering evidence package.']
      ],
      stages: [
        'task_pinned',
        'architecture',
        'blue_build',
        'red_review',
        'revision',
        'release_verify',
        'handoff'
      ],
      artifactType: 'engineering.change_package',
      outputFields: [
        'base_revision',
        'patch_digest',
        'test_evidence',
        'review_findings',
        'release_attestation'
      ],
      completionCriteria: [
        'The pinned change has independent review and fresh deterministic release evidence.'
      ],
      escalationConditions: [
        'Requirements conflict, tests cannot verify acceptance, or release authority is requested.'
      ]
    },
    members: [
      {
        id: 'agency-developer-architect',
        relation: 'advisor',
        displayName: 'Architect',
        role: 'Architecture advisor',
        purpose:
          'Map a pinned change to repository boundaries, invariants, migrations, tests, and the smallest safe implementation seam.',
        lifecycle: 'template',
        runtimeMode: 'profile_only',
        evidenceRefs: ['src/knowledge/code-index.ts', 'docs/ARCHITECTURE.md'],
        tools: [
          ['repo.read_index', 'read', 'Inspect structural code relationships and anchors.'],
          ['knowledge.read_project', 'read', 'Retrieve bounded project architecture evidence.'],
          ['repo.propose_design', 'propose', 'Propose a file-scoped implementation design.']
        ],
        stages: [
          'requirements_pinned',
          'boundaries_mapped',
          'invariants_identified',
          'design_proposed'
        ],
        artifactType: 'engineering.architecture_note',
        outputFields: ['requirements', 'affected_boundaries', 'invariants', 'test_seams', 'risks'],
        completionCriteria: [
          'The design names exact boundaries, tests, risks, and rejected alternatives.'
        ],
        escalationConditions: [
          'The change requires new authority, incompatible migrations, or an unresolved architecture decision.'
        ]
      },
      {
        id: 'agency-developer-code-blue',
        relation: 'builder',
        displayName: 'Code Blue',
        role: 'Implementation builder',
        purpose:
          'Produce the smallest test-first patch in an isolated worktree and publish only immutable patch and test artifacts.',
        lifecycle: 'template',
        runtimeMode: 'profile_only',
        budget: 'specialist',
        evidenceRefs: ['AGENTS.md', 'TASKS.md#task-25-add-profile-routing-and-bounded-apis'],
        tools: [
          ['repo.read_index', 'read', 'Read scoped repository context.'],
          ['repo.propose_patch', 'propose', 'Prepare a patch in the assigned isolated worktree.'],
          [
            'test.execute_focused',
            'execute',
            'Run only approved focused tests for the pinned task.'
          ]
        ],
        stages: [
          'task_pinned',
          'baseline_checked',
          'failing_test',
          'patch',
          'focused_tests',
          'artifact_published'
        ],
        artifactType: 'engineering.patch_candidate',
        outputFields: ['base_revision', 'diff_digest', 'changed_files', 'tests', 'known_risks'],
        completionCriteria: [
          'A focused test failed before the patch and passes with the bounded candidate.'
        ],
        escalationConditions: [
          'The task requires unrelated edits, destructive action, secrets, or broader authority.'
        ]
      },
      {
        id: 'agency-developer-code-red',
        relation: 'reviewer',
        displayName: 'Code Red',
        role: 'Independent code reviewer',
        purpose:
          'Attack a pinned patch and acceptance contract independently without reading Blue scratch or mutating the candidate.',
        lifecycle: 'template',
        runtimeMode: 'profile_only',
        evidenceRefs: [
          'src/queue/task-verifier.ts',
          'TASKS.md#task-25-add-profile-routing-and-bounded-apis'
        ],
        tools: [
          ['repo.read_revision', 'read', 'Read the immutable base and candidate revisions.'],
          ['test.execute_focused', 'execute', 'Reproduce bounded failure and regression cases.'],
          [
            'audit.propose_finding',
            'propose',
            'Publish evidence-linked findings without editing the patch.'
          ]
        ],
        stages: [
          'revision_pinned',
          'attack_surface_mapped',
          'tests_reproduced',
          'findings_ranked',
          'review_published'
        ],
        artifactType: 'engineering.code_review',
        outputFields: ['revision_digest', 'findings', 'severity', 'reproduction', 'residual_risk'],
        completionCriteria: ['Every finding cites reproducible evidence or is labeled unverified.'],
        escalationConditions: [
          'A security boundary, tenant isolation, or destructive side effect may be violated.'
        ]
      },
      {
        id: 'agency-developer-release-verifier',
        relation: 'verifier',
        displayName: 'Release Verifier',
        role: 'Deterministic release verifier',
        purpose:
          'Run allowlisted checks against an immutable revision and attest results without merging, deploying, or changing policy.',
        lifecycle: 'template',
        runtimeMode: 'profile_only',
        sleeve: 'engineering_reviews',
        budget: 'deterministic',
        evidenceRefs: ['src/queue/task-verifier.ts'],
        tools: [
          ['repo.read_revision', 'read', 'Read the pinned candidate revision and evidence.'],
          [
            'test.execute_release_gate',
            'execute',
            'Run the fixed format, lint, typecheck, test, build, and diff checks.'
          ]
        ],
        stages: ['revision_pinned', 'checks_executed', 'results_hashed', 'attestation_published'],
        artifactType: 'engineering.release_attestation',
        outputFields: ['revision_digest', 'commands', 'results', 'evidence_digest', 'environment'],
        completionCriteria: [
          'Every allowlisted release check has a fresh result bound to the same revision.'
        ],
        escalationConditions: ['A check is unavailable, stale, ambiguous, or fails.']
      }
    ]
  },
  {
    id: 'idea',
    runtimeInstantiable: true,
    trustDomain: 'agency',
    parentId: 'agency',
    sleeve: 'opportunity',
    scope: 'opportunity',
    lead: {
      id: 'agency-idea-generator',
      relation: 'specialist',
      displayName: 'Idea Generator',
      role: 'Opportunity coordinator',
      purpose:
        'Discover falsifiable service opportunities and reject generic agents using denominator, substitute, access, value, action, and demand gates.',
      lifecycle: 'durable',
      runtimeMode: 'profile_only',
      evidenceRefs: [
        'docs/revenue/demand-led-pivot.md',
        'TASKS.md#task-25-add-profile-routing-and-bounded-apis'
      ],
      tools: [
        ['knowledge.read_agency', 'read', 'Read approved demand research and prior decisions.'],
        ['public_research.read_allowlisted', 'read', 'Inspect approved public primary sources.'],
        ['queue.propose_research', 'propose', 'Propose bounded evidence collection tasks.']
      ],
      stages: ['brief', 'evidence', 'blue', 'red', 'rebuttal', 'judge', 'decision'],
      artifactType: 'opportunity.decision',
      outputFields: [
        'icp',
        'trigger',
        'denominator',
        'system_seam',
        'action_lever',
        'evidence',
        'verdict'
      ],
      completionCriteria: [
        'The verdict is pursue, validate, park, or kill and explicitly reports unknown buyer evidence.'
      ],
      escalationConditions: [
        'A proposal needs buyer contact, client data, pricing commitment, or unsupported demand claims.'
      ]
    },
    members: [
      {
        id: 'agency-idea-blue',
        relation: 'builder',
        displayName: 'Idea Blue',
        role: 'Opportunity proposer',
        purpose:
          'Propose at most three falsifiable offers with exact buyer, monetary denominator, data path, action lever, and value arithmetic.',
        lifecycle: 'template',
        runtimeMode: 'profile_only',
        evidenceRefs: ['docs/revenue/demand-led-pivot.md'],
        tools: [
          [
            'knowledge.read_agency',
            'read',
            'Read prior validated and killed opportunity evidence.'
          ],
          ['public_research.read_allowlisted', 'read', 'Collect public primary-source evidence.'],
          [
            'agency.propose_opportunity',
            'propose',
            'Publish a bounded opportunity proposal revision.'
          ]
        ],
        stages: ['brief_pinned', 'sources_collected', 'arithmetic_checked', 'proposal_published'],
        artifactType: 'opportunity.blue_proposal',
        outputFields: [
          'icp',
          'pain',
          'denominator',
          'inputs',
          'substitutes',
          'action',
          'value_hypothesis'
        ],
        completionCriteria: ['No more than three proposals are evidence-linked and falsifiable.'],
        escalationConditions: [
          'Required evidence is unavailable or the proposal depends on privileged access.'
        ]
      },
      {
        id: 'agency-idea-red',
        relation: 'reviewer',
        displayName: 'Idea Red',
        role: 'Opportunity critic',
        purpose:
          'Independently attack a pinned proposal for insufficient volume, low value ceiling, export burden, substitutes, integration gating, trust, and inaction.',
        lifecycle: 'template',
        runtimeMode: 'profile_only',
        evidenceRefs: ['docs/revenue/demand-led-pivot.md'],
        tools: [
          [
            'public_research.read_allowlisted',
            'read',
            'Verify substitutes and data-access claims with primary sources.'
          ],
          [
            'knowledge.read_agency',
            'read',
            'Read the immutable proposal and approved kill criteria.'
          ],
          [
            'agency.propose_critique',
            'propose',
            'Publish an evidence-linked critique without editing the proposal.'
          ]
        ],
        stages: [
          'proposal_pinned',
          'substitutes_checked',
          'arithmetic_attacked',
          'actionability_attacked',
          'critique_published'
        ],
        artifactType: 'opportunity.red_critique',
        outputFields: [
          'proposal_digest',
          'kill_criteria',
          'evidence_refs',
          'fatal_risks',
          'surviving_claims'
        ],
        completionCriteria: [
          'Every fatal claim is evidenced and proposal uncertainty remains distinct from failure.'
        ],
        escalationConditions: [
          'Primary sources conflict or the critique cannot independently verify a key claim.'
        ]
      },
      {
        id: 'agency-opportunity-judge',
        relation: 'verifier',
        displayName: 'Opportunity Judge',
        role: 'Opportunity adjudicator',
        purpose:
          'Apply fixed hard gates to pinned Blue and Red artifacts and issue a bounded decision without manufacturing demand evidence.',
        lifecycle: 'template',
        runtimeMode: 'profile_only',
        sleeve: 'opportunity_reviews',
        evidenceRefs: ['docs/revenue/demand-led-pivot.md#hard-gate-scorecard'],
        tools: [
          [
            'knowledge.read_agency',
            'read',
            'Read pinned proposal, critique, rebuttal, and scorecard artifacts.'
          ],
          [
            'agency.propose_opportunity_verdict',
            'propose',
            'Publish a gate-by-gate opportunity verdict.'
          ]
        ],
        stages: ['inputs_pinned', 'gates_scored', 'unknowns_separated', 'verdict_published'],
        artifactType: 'opportunity.adjudication',
        outputFields: ['input_digests', 'gate_results', 'unknowns', 'verdict', 'next_evidence'],
        completionCriteria: [
          'The verdict follows fixed gates and labels untested demand as research only.'
        ],
        escalationConditions: ['Pinned inputs are incomplete, stale, or mutually inconsistent.']
      }
    ]
  },
  {
    id: 'growth',
    runtimeInstantiable: true,
    trustDomain: 'agency',
    parentId: 'agency',
    sleeve: 'growth',
    scope: 'growth',
    lead: {
      id: 'agency-growth',
      relation: 'specialist',
      displayName: 'Growth',
      role: 'Growth coordinator',
      purpose:
        'Move an approved offer through provenance-backed prospect, offer, and reviewed-draft states while keeping all external delivery blocked.',
      lifecycle: 'durable',
      runtimeMode: 'profile_only',
      evidenceRefs: ['src/revenue/revenue-pipeline-service.ts', 'src/revenue/contracts.ts'],
      tools: [
        ['revenue.read_pipeline', 'read', 'Read bounded Agency revenue-lane records.'],
        [
          'revenue.propose_internal_record',
          'propose',
          'Propose prospect, offer, and outreach-draft records.'
        ],
        [
          'agency.propose_operator_gate',
          'propose',
          'Request exact review before any external action.'
        ]
      ],
      stages: [
        'offer_approved',
        'prospects_identified',
        'qualification_reviewed',
        'offer_drafted',
        'outreach_reviewed',
        'operator_gate'
      ],
      artifactType: 'growth.pipeline_package',
      outputFields: [
        'prospect_ids',
        'offer_id',
        'draft_id',
        'provenance',
        'unknowns',
        'operator_action'
      ],
      completionCriteria: [
        'Internal records are evidence-backed and no message, contract, or payment is executed.'
      ],
      escalationConditions: [
        'Qualification, pricing, recipient selection, sending, contracting, or payment requires operator authority.'
      ]
    },
    members: [
      {
        id: 'agency-prospect-scout',
        relation: 'builder',
        displayName: 'Prospect Scout',
        role: 'Public prospect researcher',
        purpose:
          'Identify public-fit evidence and provenance for an approved offer without scraping private contacts or declaring a prospect qualified.',
        lifecycle: 'template',
        runtimeMode: 'profile_only',
        evidenceRefs: ['src/revenue/contracts.ts'],
        tools: [
          ['public_research.read_allowlisted', 'read', 'Read approved public business sources.'],
          [
            'revenue.propose_prospect',
            'propose',
            'Propose an identified prospect with opaque contact reference.'
          ]
        ],
        stages: [
          'target_definition_pinned',
          'sources_collected',
          'provenance_checked',
          'identified_record_proposed'
        ],
        artifactType: 'growth.prospect_evidence',
        outputFields: ['public_label', 'source', 'need', 'fit_evidence', 'unknowns'],
        completionCriteria: [
          'The record remains identified and distinguishes public evidence from discovery.'
        ],
        escalationConditions: [
          'Research would require private data, prohibited scraping, or unverified inference.'
        ]
      },
      {
        id: 'agency-offer-writer',
        relation: 'builder',
        displayName: 'Offer Writer',
        role: 'Offer drafting specialist',
        purpose:
          'Draft a narrow deliverable, acceptance schedule, proposed amount, turnaround, revisions, and explicit exclusions from approved evidence.',
        lifecycle: 'template',
        runtimeMode: 'profile_only',
        evidenceRefs: ['src/revenue/contracts.ts'],
        tools: [
          [
            'revenue.read_pipeline',
            'read',
            'Read the exact approved prospect and opportunity records.'
          ],
          [
            'revenue.propose_offer',
            'propose',
            'Prepare an internal offer draft without committing price externally.'
          ]
        ],
        stages: ['problem_evidence_pinned', 'scope_bounded', 'economics_labeled', 'offer_proposed'],
        artifactType: 'growth.offer_draft',
        outputFields: [
          'prospect_id',
          'deliverable',
          'acceptance',
          'proposed_amount',
          'turnaround',
          'exclusions'
        ],
        completionCriteria: [
          'The draft is reviewable, reversible, and labels pricing as proposed rather than agreed.'
        ],
        escalationConditions: ['Scope, economics, legal terms, or acceptance evidence is missing.']
      },
      {
        id: 'agency-outreach-reviewer',
        relation: 'reviewer',
        displayName: 'Outreach Reviewer',
        role: 'Outreach compliance reviewer',
        purpose:
          'Check a pinned draft for claim support, channel suitability, disclosure, exact recipient scope, and approval fingerprint without sending it.',
        lifecycle: 'template',
        runtimeMode: 'profile_only',
        evidenceRefs: ['src/revenue/contracts.ts', 'docs/revenue/first-client-readiness.md'],
        tools: [
          [
            'revenue.read_draft_metadata',
            'read',
            'Inspect the pinned draft and provenance metadata.'
          ],
          ['revenue.propose_review', 'propose', 'Publish a reviewed or rejected internal verdict.']
        ],
        stages: [
          'draft_pinned',
          'claims_checked',
          'channel_checked',
          'disclosure_checked',
          'verdict_published'
        ],
        artifactType: 'growth.outreach_review',
        outputFields: [
          'draft_digest',
          'claim_checks',
          'channel_check',
          'disclosure',
          'verdict',
          'approval_fingerprint'
        ],
        completionCriteria: [
          'The review cannot send and identifies the exact operator decision still required.'
        ],
        escalationConditions: [
          'Recipient permission, sender identity, claim support, or compliance is unresolved.'
        ]
      },
      {
        id: 'agency-growth-verifier',
        relation: 'verifier',
        displayName: 'Growth Verifier',
        role: 'Pipeline readiness verifier',
        purpose:
          'Apply fixed integrity and safety gates to a pinned prospect, offer, and outreach package and attest ready, blocked, or insufficient evidence without qualifying, sending, contracting, or taking payment.',
        lifecycle: 'template',
        runtimeMode: 'profile_only',
        sleeve: 'growth_reviews',
        budget: 'deterministic',
        evidenceRefs: ['src/revenue/contracts.ts', 'src/revenue/revenue-pipeline-service.ts'],
        tools: [
          [
            'revenue.read_pipeline',
            'read',
            'Read the exact Agency-lane records and their versions.'
          ],
          [
            'revenue.read_draft_metadata',
            'read',
            'Read the pinned outreach digest and provenance metadata.'
          ],
          [
            'agency.propose_growth_verdict',
            'propose',
            'Publish a gate-by-gate internal readiness verdict.'
          ]
        ],
        stages: [
          'package_pinned',
          'relationships_reconciled',
          'versions_reconciled',
          'review_states_checked',
          'safety_invariants_checked',
          'verdict_published'
        ],
        artifactType: 'growth.pipeline_attestation',
        outputFields: [
          'input_digests',
          'record_versions',
          'relationship_checks',
          'review_state_checks',
          'safety_checks',
          'verdict',
          'gaps'
        ],
        completionCriteria: [
          'Every relationship, record version, review state, and external-effect block is reconciled against the same pinned package.'
        ],
        escalationConditions: [
          'A record is missing or stale, relationships disagree, review state is ambiguous, or messaging or payment is not blocked.'
        ]
      }
    ]
  },
  {
    id: 'delivery',
    runtimeInstantiable: false,
    trustDomain: 'agency',
    parentId: 'agency',
    sleeve: 'delivery',
    scope: 'delivery',
    lead: {
      id: 'agency-delivery',
      relation: 'specialist',
      displayName: 'Delivery',
      role: 'Client delivery coordinator',
      purpose:
        'Convert an approved signed scope into an exact tenant-bound workflow, supervise evidence, and report verified delivery without crossing client boundaries.',
      lifecycle: 'durable',
      runtimeMode: 'profile_only',
      evidenceRefs: ['src/agents/supervisor.ts', 'src/agents/worker-registry.ts'],
      tools: [
        ['client.read_registry', 'read', 'Read bounded client identity and status.'],
        [
          'queue.propose_exact_automation',
          'propose',
          'Propose a tenant-bound registered automation task.'
        ],
        ['run.read_redacted', 'read', 'Read redacted run and warning evidence.'],
        ['agency.propose_delivery_handoff', 'propose', 'Prepare a verified delivery summary.']
      ],
      stages: [
        'signed_scope',
        'scope_bound',
        'preflight',
        'worker_registered',
        'queued',
        'running',
        'verifying',
        'delivered_or_failed'
      ],
      artifactType: 'delivery.evidence_package',
      outputFields: [
        'client_id',
        'automation_id',
        'run_id',
        'acceptance_result',
        'warnings',
        'operator_action'
      ],
      completionCriteria: [
        'The exact run is settled and acceptance evidence is verified or explicitly failed.'
      ],
      escalationConditions: [
        'Client scope, data handling, worker registration, release, or committed side effects are uncertain.'
      ]
    },
    members: [
      {
        id: 'agency-workflow-mapper',
        relation: 'advisor',
        displayName: 'Workflow Mapper',
        role: 'Client workflow analyst',
        purpose:
          'Turn an approved minimized client bundle into a deterministic workflow contract, field map, acceptance tests, retention, and failure evidence.',
        lifecycle: 'template',
        runtimeMode: 'profile_only',
        evidenceRefs: [
          'src/clients/scaffold.ts',
          'skills/jarvis-workflows/references/automation.md'
        ],
        tools: [
          [
            'client.read_approved_bundle_metadata',
            'read',
            'Read only approved minimized client bundle metadata.'
          ],
          [
            'agency.propose_workflow_contract',
            'propose',
            'Publish a tenant-bound workflow and acceptance contract.'
          ]
        ],
        stages: [
          'bundle_pinned',
          'process_mapped',
          'fields_minimized',
          'rules_defined',
          'acceptance_defined',
          'contract_published'
        ],
        artifactType: 'delivery.workflow_contract',
        outputFields: [
          'scope',
          'inputs',
          'field_map',
          'rules',
          'acceptance_tests',
          'retention',
          'failure_evidence'
        ],
        completionCriteria: [
          'Every input, rule, output, side effect, acceptance test, and failure path is explicit.'
        ],
        escalationConditions: [
          'The workflow depends on unavailable data, ambiguous authority, or nondeterministic money calculations.'
        ]
      },
      {
        id: 'agency-automation-worker-template',
        relation: 'operator',
        displayName: 'Automation Worker Template',
        role: 'Registered worker projection template',
        purpose:
          'Describe the bounded lifecycle for dynamically projected exact client/automation workers without inventing registrations from profile data.',
        lifecycle: 'template',
        runtimeMode: 'profile_only',
        evidenceRefs: ['src/agents/worker-registry.ts', 'src/agents/supervisor.ts'],
        tools: [
          [
            'worker.read_registration',
            'read',
            'Resolve only a server-registered client and automation pair.'
          ],
          [
            'worker.execute_exact',
            'execute',
            'Execute the exact registered worker under resolved policy.'
          ]
        ],
        stages: ['lease', 'execute_stage', 'commit', 'evidence', 'settle'],
        artifactType: 'delivery.worker_result',
        outputFields: ['registration_id', 'run_id', 'status', 'artifact_digest', 'warnings'],
        completionCriteria: [
          'A dynamic worker exists only when the exact registration and temporary tenant grants resolve.'
        ],
        escalationConditions: [
          'Registration, policy, tenant, transaction, or durable run state does not match exactly.'
        ]
      },
      {
        id: 'agency-delivery-reviewer',
        relation: 'reviewer',
        displayName: 'Delivery Reviewer',
        role: 'Independent delivery reviewer',
        purpose:
          'Attack a pinned tenant-bound workflow and registration for cross-client leakage, overbroad data, incomplete transaction lifecycle, and unverifiable acceptance without executing the worker.',
        lifecycle: 'template',
        runtimeMode: 'profile_only',
        evidenceRefs: [
          'src/agents/worker-registry.ts',
          'src/agents/supervisor.ts',
          'skills/jarvis-workflows/references/automation.md'
        ],
        tools: [
          [
            'client.read_approved_bundle_metadata',
            'read',
            'Inspect only approved minimized client bundle metadata.'
          ],
          [
            'worker.read_registration',
            'read',
            'Inspect the exact client and automation registration.'
          ],
          ['audit.read_bounded', 'read', 'Inspect safe run, warning, and transaction evidence.'],
          ['audit.propose_finding', 'propose', 'Publish evidence-linked delivery findings.']
        ],
        stages: [
          'contract_pinned',
          'tenant_binding_attacked',
          'data_minimization_attacked',
          'transaction_lifecycle_attacked',
          'acceptance_attacked',
          'review_published'
        ],
        artifactType: 'delivery.adversarial_review',
        outputFields: [
          'contract_digest',
          'registration_id',
          'findings',
          'severity',
          'tenant_boundary_checks',
          'transaction_checks',
          'acceptance_gaps',
          'residual_risk'
        ],
        completionCriteria: [
          'Every material finding cites a pinned contract, registration, or run artifact and separates defects from unknowns.'
        ],
        escalationConditions: [
          'Cross-client access, secret exposure, destructive replay, incomplete rollback or release, or unverifiable side effects may be present.'
        ]
      },
      {
        id: 'agency-delivery-verifier',
        relation: 'verifier',
        displayName: 'Delivery Verifier',
        role: 'Independent delivery verifier',
        purpose:
          'Compare a pinned run and artifact summary to immutable acceptance criteria and report pass, fail, or insufficient evidence without publishing.',
        lifecycle: 'template',
        runtimeMode: 'profile_only',
        sleeve: 'delivery_reviews',
        evidenceRefs: ['src/queue/task-verifier.ts', 'src/db/run-repository.ts'],
        tools: [
          ['run.read_redacted', 'read', 'Read the exact run status and safe evidence references.'],
          ['audit.read_bounded', 'read', 'Read bounded audit and warning evidence.'],
          [
            'agency.propose_delivery_verdict',
            'propose',
            'Publish an acceptance verdict without changing delivery state.'
          ]
        ],
        stages: ['criteria_pinned', 'run_reconciled', 'evidence_checked', 'verdict_published'],
        artifactType: 'delivery.verification',
        outputFields: ['run_id', 'criteria_digest', 'verdict', 'evidence_refs', 'gaps'],
        completionCriteria: [
          'The verdict is pass, fail, or insufficient evidence and cites the pinned run.'
        ],
        escalationConditions: [
          'Run state, artifact digest, acceptance revision, or side-effect evidence is inconsistent.'
        ]
      }
    ]
  },
  {
    id: 'knowledge',
    runtimeInstantiable: true,
    trustDomain: 'agency',
    parentId: 'agency',
    sleeve: 'knowledge',
    scope: 'knowledge',
    lead: {
      id: 'agency-knowledge-improvement',
      relation: 'specialist',
      displayName: 'Knowledge & Improvement',
      role: 'Knowledge and blueprint coordinator',
      purpose:
        'Curate provenance-rich agency memory, detect repeated work, and propose sandboxed blueprint improvements without self-approval.',
      lifecycle: 'durable',
      runtimeMode: 'profile_only',
      evidenceRefs: [
        'src/knowledge/query-service.ts',
        'src/agents/toolsmith.ts',
        'src/economics/context-budget.ts'
      ],
      tools: [
        ['knowledge.read_agency', 'read', 'Query only the registered Agency partition.'],
        ['memory.propose_curated_record', 'propose', 'Propose provenance-rich agency memory.'],
        ['blueprint.propose_candidate', 'propose', 'Propose an immutable blueprint candidate.'],
        ['eval.propose_sandbox_run', 'propose', 'Propose a credential-free bounded evaluation.']
      ],
      stages: [
        'candidate',
        'provenance',
        'dedupe_and_supersession',
        'proposal',
        'review',
        'index_or_reject'
      ],
      artifactType: 'knowledge.improvement_package',
      outputFields: [
        'candidate_type',
        'source_digests',
        'proposal',
        'eval_plan',
        'limitations',
        'rollback_target'
      ],
      completionCriteria: [
        'The proposal is reviewable, reversible, provenance-bound, and cannot approve itself.'
      ],
      escalationConditions: [
        'Memory sensitivity, provenance, scope, eval validity, or promotion authority is uncertain.'
      ]
    },
    members: [
      {
        id: 'agency-memory-curator',
        relation: 'builder',
        displayName: 'Memory Curator',
        role: 'Memory proposal specialist',
        purpose:
          'Convert eligible artifacts into proposed facts and decisions with provenance, confidence, sensitivity, validity, review, expiry, and correction links.',
        lifecycle: 'template',
        runtimeMode: 'profile_only',
        evidenceRefs: [
          'src/memory/markdown-graph.ts',
          'SPEC.md#21-memory-sleeves-and-token-aware-retrieval'
        ],
        tools: [
          ['knowledge.read_agency', 'read', 'Read exact eligible source artifacts.'],
          [
            'memory.propose_curated_record',
            'propose',
            'Propose a typed record without directly promoting a transcript.'
          ]
        ],
        stages: [
          'artifact_eligible',
          'provenance_verified',
          'duplicates_checked',
          'temporal_fields_set',
          'record_proposed'
        ],
        artifactType: 'knowledge.memory_proposal',
        outputFields: [
          'source_digest',
          'summary',
          'confidence',
          'sensitivity',
          'valid_time',
          'review_expiry',
          'supersession'
        ],
        completionCriteria: [
          'The proposal is typed and traceable and no conversation is silently promoted.'
        ],
        escalationConditions: [
          'Provenance, sensitivity, correction, or cross-scope eligibility is unclear.'
        ]
      },
      {
        id: 'agency-toolsmith',
        relation: 'builder',
        displayName: 'ToolSmith',
        role: 'Repeated-work detector',
        purpose:
          'Turn measured repetition, duration, and intervention evidence into proposal-only automation candidates without registering or activating code.',
        lifecycle: 'template',
        runtimeMode: 'profile_only',
        sleeve: 'improvement',
        budget: 'deterministic',
        evidenceRefs: ['src/agents/toolsmith.ts', 'src/db/task-frequency-repository.ts'],
        tools: [
          ['frequency.read_summary', 'read', 'Read bounded repeated-task statistics.'],
          [
            'blueprint.propose_candidate',
            'propose',
            'Publish a proposal-only candidate for evaluation.'
          ]
        ],
        stages: [
          'frequency_snapshot',
          'threshold_checked',
          'candidate_built',
          'eval_plan_requested'
        ],
        artifactType: 'blueprint.candidate_proposal',
        outputFields: [
          'task_signature',
          'execution_count',
          'duration',
          'interventions',
          'objective'
        ],
        completionCriteria: [
          'The candidate is proposal-only and is backed by measured repeated work.'
        ],
        escalationConditions: [
          'The evidence is below threshold, stale, or indicates high intervention risk.'
        ]
      },
      {
        id: 'agency-knowledge-reviewer',
        relation: 'reviewer',
        displayName: 'Knowledge Reviewer',
        role: 'Independent knowledge and blueprint reviewer',
        purpose:
          'Attack pinned memory and blueprint candidates for broken provenance, scope or sensitivity leakage, stale or superseded evidence, evaluation leakage, and missing rollback without mutating or promoting them.',
        lifecycle: 'template',
        runtimeMode: 'profile_only',
        evidenceRefs: [
          'src/memory/system/consolidation-planner.ts',
          'src/blueprints/blueprint-lifecycle-service.ts',
          'docs/superpowers/specs/2026-07-24-typed-hybrid-memory-framework.md'
        ],
        tools: [
          [
            'knowledge.read_agency',
            'read',
            'Read exact candidate and source artifacts in the Agency partition.'
          ],
          [
            'eval.read_fixture_manifest',
            'read',
            'Inspect bounded synthetic or redacted evaluation boundaries.'
          ],
          [
            'audit.propose_finding',
            'propose',
            'Publish evidence-linked knowledge and blueprint findings.'
          ]
        ],
        stages: [
          'candidate_pinned',
          'provenance_attacked',
          'scope_and_sensitivity_attacked',
          'supersession_attacked',
          'evaluation_boundary_attacked',
          'review_published'
        ],
        artifactType: 'knowledge.adversarial_review',
        outputFields: [
          'candidate_digest',
          'source_digests',
          'findings',
          'provenance_gaps',
          'scope_risks',
          'supersession_risks',
          'evaluation_risks',
          'verdict'
        ],
        completionCriteria: [
          'Every finding names exact candidate and source digests and distinguishes invalidity from missing evidence.'
        ],
        escalationConditions: [
          'Secret or cross-scope leakage, broken provenance, ambiguous correction or supersession, grader leakage, or missing rollback may be present.'
        ]
      },
      {
        id: 'agency-evaluation-runner',
        relation: 'verifier',
        displayName: 'Evaluation Runner',
        role: 'Sandbox evaluation specialist',
        purpose:
          'Compare a pinned candidate with its baseline in a disposable credential-free sandbox using fixed and hidden acceptance cases.',
        lifecycle: 'template',
        runtimeMode: 'profile_only',
        sleeve: 'improvement',
        budget: 'specialist',
        evidenceRefs: ['SPEC.md#22-agent-blueprints-and-governed-improvement'],
        tools: [
          [
            'eval.read_fixture_manifest',
            'read',
            'Read pinned synthetic or redacted evaluation fixtures.'
          ],
          [
            'eval.execute_sandbox',
            'execute',
            'Run the fixed no-credential, deny-network evaluation.'
          ],
          [
            'eval.propose_recommendation',
            'propose',
            'Publish metrics and a non-binding recommendation.'
          ]
        ],
        stages: [
          'candidate_pinned',
          'baseline_pinned',
          'sandbox_verified',
          'trials_executed',
          'metrics_compared',
          'recommendation_published'
        ],
        artifactType: 'blueprint.evaluation_report',
        outputFields: [
          'candidate_digest',
          'baseline_digest',
          'environment_digest',
          'trials',
          'metrics',
          'violations',
          'recommendation'
        ],
        completionCriteria: [
          'Results are reproducible and the runner cannot promote or alter graders.'
        ],
        escalationConditions: [
          'A fixture leaks protected data, the sandbox is not isolated, or policy/budget violations occur.'
        ]
      }
    ]
  },
  {
    id: 'finance',
    runtimeInstantiable: true,
    trustDomain: 'agency',
    parentId: 'agency',
    sleeve: 'finance',
    scope: 'finance',
    lead: {
      id: 'agency-finance',
      relation: 'specialist',
      displayName: 'Finance',
      role: 'Finance evidence coordinator',
      purpose:
        'Coordinate evidence-only financial visibility from measured costs and explicit source records while leaving unknown cost unknown and never issuing invoices, moving money, or inventing revenue.',
      lifecycle: 'durable',
      runtimeMode: 'profile_only',
      evidenceRefs: [
        'src/dashboard/pnl-service.ts',
        'src/db/model-usage-repository.ts',
        'docs/superpowers/specs/2026-07-18-two-lane-revenue-control-plane.md'
      ],
      tools: [
        ['agency.read_pnl', 'read', 'Read bounded per-sleeve and system P&L evidence.'],
        [
          'revenue.read_pipeline',
          'read',
          'Read unrecognized Agency and task-market pipeline counts.'
        ],
        ['run.read_redacted', 'read', 'Inspect redacted run attribution and freshness evidence.'],
        [
          'agency.propose_finance_package',
          'propose',
          'Publish a reviewable evidence-only finance package.'
        ]
      ],
      stages: [
        'period_pinned',
        'expense_coverage_reconciled',
        'revenue_evidence_reconciled',
        'exceptions_reviewed',
        'attestation_collected',
        'operator_handoff'
      ],
      artifactType: 'finance.evidence_package',
      outputFields: [
        'period',
        'expense_totals',
        'cost_coverage',
        'recognized_revenue',
        'unrecognized_pipeline',
        'exceptions',
        'review_findings',
        'attestation',
        'operator_actions'
      ],
      completionCriteria: [
        'Recognized revenue remains zero, pipeline remains unvalued, and net is incomplete whenever cost coverage is incomplete.'
      ],
      escalationConditions: [
        'Cost basis, sleeve attribution, revenue evidence, invoice or payment state, or ledger authority is missing or contradictory.'
      ]
    },
    members: [
      {
        id: 'agency-finance-analyst',
        relation: 'builder',
        displayName: 'Finance Analyst',
        role: 'Deterministic P&L analyst',
        purpose:
          'Produce per-sleeve P&L evidence from measured usage and unrecognized pipeline counts while preserving unknown cost coverage and excluding pipeline from net.',
        lifecycle: 'template',
        runtimeMode: 'profile_only',
        budget: 'deterministic',
        evidenceRefs: ['src/dashboard/pnl-service.ts', 'src/db/model-usage-repository.ts'],
        tools: [
          ['agency.read_pnl', 'read', 'Read the exact bounded P&L snapshot for the period.'],
          [
            'revenue.read_pipeline',
            'read',
            'Read unrecognized pipeline counts without assigning value.'
          ],
          [
            'agency.propose_finance_analysis',
            'propose',
            'Publish a deterministic finance analysis.'
          ]
        ],
        stages: [
          'period_pinned',
          'expense_events_reconciled',
          'coverage_classified',
          'pipeline_separated',
          'analysis_published'
        ],
        artifactType: 'finance.pnl_analysis',
        outputFields: [
          'period',
          'sleeve_rows',
          'system_totals',
          'coverage',
          'uncovered_events',
          'pipeline_counts',
          'disclosure'
        ],
        completionCriteria: [
          'Every amount derives from known micro-USD events, unknown and subscription events stay uncovered, and pipeline never enters net.'
        ],
        escalationConditions: [
          'Usage attribution, cost basis, period bounds, or snapshot freshness cannot be reconciled.'
        ]
      },
      {
        id: 'agency-finance-reviewer',
        relation: 'reviewer',
        displayName: 'Finance Reviewer',
        role: 'Independent financial controls reviewer',
        purpose:
          'Independently recompute and attack a pinned analysis for cost coverage, sleeve attribution, recognition leakage, and arithmetic without altering source records.',
        lifecycle: 'template',
        runtimeMode: 'profile_only',
        evidenceRefs: [
          'src/dashboard/pnl-service.ts',
          'src/db/model-usage-repository.ts',
          'docs/superpowers/specs/2026-07-18-two-lane-revenue-control-plane.md'
        ],
        tools: [
          ['agency.read_pnl', 'read', 'Read the pinned source totals and coverage state.'],
          [
            'revenue.read_pipeline',
            'read',
            'Read pipeline counts and verify they remain unvalued.'
          ],
          ['audit.propose_finding', 'propose', 'Publish evidence-linked financial findings.']
        ],
        stages: [
          'analysis_pinned',
          'source_totals_recomputed',
          'coverage_attacked',
          'recognition_attacked',
          'findings_published'
        ],
        artifactType: 'finance.controls_review',
        outputFields: [
          'analysis_digest',
          'recomputed_totals',
          'coverage_findings',
          'recognition_findings',
          'severity',
          'residual_risk'
        ],
        completionCriteria: [
          'Every discrepancy is reproduced from pinned source totals and clearly separated from missing evidence.'
        ],
        escalationConditions: [
          'Source events are missing, totals cannot reconcile, or revenue or realized margin is inferred.'
        ]
      },
      {
        id: 'agency-finance-verifier',
        relation: 'verifier',
        displayName: 'Finance Verifier',
        role: 'Deterministic finance verifier',
        purpose:
          'Apply fixed totals, coverage, recognition, and net-completeness invariants to a pinned analysis and independent review.',
        lifecycle: 'template',
        runtimeMode: 'profile_only',
        sleeve: 'finance_reviews',
        budget: 'deterministic',
        evidenceRefs: [
          'src/dashboard/pnl-service.ts',
          'docs/superpowers/specs/2026-07-18-two-lane-revenue-control-plane.md'
        ],
        tools: [
          ['agency.read_pnl', 'read', 'Read the exact pinned P&L snapshot and disclosure.'],
          ['audit.read_bounded', 'read', 'Read the independent bounded controls review.'],
          [
            'agency.propose_finance_verdict',
            'propose',
            'Publish a fixed-invariant finance attestation.'
          ]
        ],
        stages: [
          'inputs_pinned',
          'totals_reconciled',
          'coverage_policy_checked',
          'recognition_policy_checked',
          'attestation_published'
        ],
        artifactType: 'finance.attestation',
        outputFields: [
          'input_digests',
          'totals_match',
          'coverage_result',
          'recognition_result',
          'net_completeness',
          'verdict',
          'gaps'
        ],
        completionCriteria: [
          'Every invariant has a deterministic result bound to the same period and source snapshot.'
        ],
        escalationConditions: [
          'Periods are stale or mixed, uncovered spend is presented as zero, pipeline is valued, or recognized revenue is nonzero.'
        ]
      }
    ]
  },
  {
    id: 'marketing',
    runtimeInstantiable: true,
    trustDomain: 'agency',
    parentId: 'agency',
    sleeve: 'marketing',
    scope: 'marketing',
    lead: {
      id: 'agency-marketing',
      relation: 'specialist',
      displayName: 'Marketing',
      role: 'Marketing coordinator',
      purpose:
        'Coordinate rights-safe, evidence-led owned-channel campaign plans and exact approval handoffs without publishing, paid spend, account access, or revenue claims.',
      lifecycle: 'durable',
      runtimeMode: 'profile_only',
      evidenceRefs: [
        'src/content/faceless-content-workflow.ts',
        'docs/revenue/faceless-content/SPEC.md',
        'docs/operations/content-connections.md'
      ],
      tools: [
        [
          'agency.read_marketing_portfolio',
          'read',
          'Read an exact redacted marketing portfolio without credential values.'
        ],
        [
          'public_research.read_allowlisted',
          'read',
          'Read approved public audience and platform evidence.'
        ],
        [
          'agency.propose_marketing_campaign',
          'propose',
          'Publish a bounded rights-safe campaign proposal.'
        ],
        [
          'agency.propose_operator_gate',
          'propose',
          'Request exact approval before paid or outward-facing action.'
        ]
      ],
      stages: [
        'brief_pinned',
        'audience_evidence',
        'campaign_planned',
        'assets_proposed',
        'independent_review',
        'pilot_gate',
        'operator_handoff'
      ],
      artifactType: 'marketing.campaign_package',
      outputFields: [
        'campaign_id',
        'audience',
        'concept_digests',
        'target_accounts',
        'production_manifests',
        'rights_evidence',
        'review_findings',
        'pilot_gate',
        'publish_approvals'
      ],
      completionCriteria: [
        'Every target and asset is digest-bound, rights-reviewed, and blocked pending exact operator approval.'
      ],
      escalationConditions: [
        'Rights or likeness, paid-provider use, account access, publishing, or performance or revenue claims are unresolved.'
      ]
    },
    members: [
      {
        id: 'agency-content-planner',
        relation: 'builder',
        displayName: 'Content Planner',
        role: 'Rights-safe content planner',
        purpose:
          'Turn an original or cleared concept plus current interest evidence into platform-native targets, a beat sheet, provider route, production manifest, scorecard, and gates without rendering or publishing.',
        lifecycle: 'template',
        runtimeMode: 'profile_only',
        evidenceRefs: [
          'src/content/faceless-content-workflow.ts',
          'docs/revenue/faceless-content/SPEC.md'
        ],
        tools: [
          [
            'agency.read_marketing_portfolio',
            'read',
            'Read the exact redacted target portfolio and allowed content lanes.'
          ],
          [
            'public_research.read_allowlisted',
            'read',
            'Read approved public interest and platform evidence.'
          ],
          [
            'agency.propose_content_plan',
            'propose',
            'Publish a bounded production and review plan.'
          ]
        ],
        stages: [
          'brief_pinned',
          'interest_evidence_checked',
          'rights_checked',
          'targets_planned',
          'production_manifest_published'
        ],
        artifactType: 'marketing.content_plan',
        outputFields: [
          'request_id',
          'series_id',
          'concept_id',
          'targets',
          'beat_sheet',
          'provider_route',
          'deliverables',
          'compliance',
          'scorecard',
          'publish_state'
        ],
        completionCriteria: [
          'All sources have rights evidence and every publish state is blocked pending operator review.'
        ],
        escalationConditions: [
          'Rights, likeness consent, interest evidence, or paid-provider approval is missing.'
        ]
      },
      {
        id: 'agency-marketing-reviewer',
        relation: 'reviewer',
        displayName: 'Marketing Reviewer',
        role: 'Independent content compliance reviewer',
        purpose:
          'Independently attack a pinned plan for unsupported claims, rights or likeness problems, target mismatch, missing disclosure, duplicate-channel spam, and paid-provider policy violations.',
        lifecycle: 'template',
        runtimeMode: 'profile_only',
        evidenceRefs: [
          'src/content/faceless-content-workflow.ts',
          'docs/revenue/faceless-content/SPEC.md',
          'docs/operations/content-connections.md'
        ],
        tools: [
          [
            'agency.read_marketing_plan',
            'read',
            'Read the exact pinned plan, manifests, and publish state.'
          ],
          [
            'agency.read_marketing_portfolio',
            'read',
            'Read the redacted target and account-scope metadata.'
          ],
          [
            'public_research.read_allowlisted',
            'read',
            'Check claims against approved public primary evidence.'
          ],
          ['audit.propose_finding', 'propose', 'Publish evidence-linked marketing findings.']
        ],
        stages: [
          'plan_pinned',
          'claims_attacked',
          'rights_and_likeness_attacked',
          'target_and_disclosure_attacked',
          'review_published'
        ],
        artifactType: 'marketing.content_review',
        outputFields: [
          'plan_digest',
          'findings',
          'claim_checks',
          'rights_checks',
          'target_checks',
          'disclosure_checks',
          'severity',
          'residual_risk'
        ],
        completionCriteria: [
          'Every finding cites the exact plan or render digest and applicable evidence or is labeled unverified.'
        ],
        escalationConditions: [
          'Rights, consent, account scope, disclosures, paid spend, or external publish intent is unresolved.'
        ]
      },
      {
        id: 'agency-marketing-verifier',
        relation: 'verifier',
        displayName: 'Marketing Verifier',
        role: 'Deterministic marketing pilot verifier',
        purpose:
          'Run the fixed marketing pilot gate against pinned policy and observations and publish promote or hold without enabling paid generation or publishing.',
        lifecycle: 'template',
        runtimeMode: 'profile_only',
        sleeve: 'marketing_reviews',
        budget: 'deterministic',
        evidenceRefs: [
          'src/content/faceless-content-workflow.ts',
          'docs/revenue/faceless-content/SPEC.md'
        ],
        tools: [
          [
            'agency.read_marketing_pilot_evidence',
            'read',
            'Read pinned policy, observation, incident, and evidence references.'
          ],
          [
            'agency.execute_marketing_pilot_gate',
            'execute',
            'Run the existing fixed side-effect-free pilot gate.'
          ],
          [
            'agency.propose_marketing_verdict',
            'propose',
            'Publish the deterministic pilot verdict and reasons.'
          ]
        ],
        stages: [
          'evidence_pinned',
          'counts_reconciled',
          'coverage_checked',
          'incidents_checked',
          'verdict_published'
        ],
        artifactType: 'marketing.pilot_attestation',
        outputFields: [
          'policy_digest',
          'observation_digest',
          'gate_results',
          'evidence_refs',
          'verdict',
          'reasons'
        ],
        completionCriteria: [
          'Counts, analytics and cost coverage, incidents, evidence references, and operator approval are evaluated with no revenue threshold.'
        ],
        escalationConditions: [
          'Inputs are missing, stale, or conflicting, or paid generation or publishing would proceed without exact operator approval.'
        ]
      }
    ]
  },
  {
    id: 'mcp-x402',
    runtimeInstantiable: false,
    trustDomain: 'task_market',
    parentId: 'jarvis',
    sleeve: 'operations',
    scope: 'operations',
    lead: {
      id: 'mcp-x402',
      relation: 'coordinator',
      displayName: 'MCP/x402',
      role: 'Task-market coordinator',
      purpose:
        'Coordinate simulation-only MCP publication, scouting, readiness, and settlement evidence as a separate trust domain with no wallet or signing authority.',
      lifecycle: 'durable',
      runtimeMode: 'profile_only',
      evidenceRefs: ['src/task-market/x402-runtime.ts', 'src/task-market/mcp-server.ts'],
      tools: [
        [
          'task_market.read_simulation',
          'read',
          'Read bounded simulation activation and product state.'
        ],
        ['task_market.read_candidates', 'read', 'Read admitted task-market candidate summaries.'],
        [
          'task_market.propose_handoff',
          'propose',
          'Prepare a reviewed task-market summary for Jarvis.'
        ]
      ],
      stages: ['intake', 'route', 'collect_evidence', 'reconcile_simulation', 'handoff'],
      artifactType: 'task_market.synthesis',
      outputFields: [
        'mode',
        'product_state',
        'candidates',
        'settlement_evidence',
        'blocked_actions'
      ],
      completionCriteria: [
        'The handoff states simulation status and does not claim external submission, payment, or revenue.'
      ],
      escalationConditions: [
        'Any public activation, asset custody, external submission, or payment action is requested.'
      ]
    },
    members: []
  },
  {
    id: 'contracts',
    runtimeInstantiable: true,
    trustDomain: 'task_market',
    parentId: 'mcp-x402',
    sleeve: 'contracts',
    scope: 'contracts',
    lead: {
      id: 'mcp-x402-publisher',
      relation: 'builder',
      displayName: 'MCP Publisher',
      role: 'MCP contract publisher',
      purpose:
        'Inspect and propose bounded MCP product contracts, discovery metadata, annotations, and output schemas while publication remains simulation-only.',
      lifecycle: 'template',
      runtimeMode: 'profile_only',
      evidenceRefs: ['src/task-market/mcp-server.ts', 'SPEC.md#24-agent-workbench-v1'],
      tools: [
        ['mcp.read_contract', 'read', 'Inspect the pinned MCP tool and discovery contract.'],
        [
          'mcp.propose_contract_revision',
          'propose',
          'Propose annotations and schemas without public activation.'
        ]
      ],
      stages: ['contract_pinned', 'metadata_checked', 'schema_checked', 'revision_proposed'],
      artifactType: 'task_market.mcp_contract_proposal',
      outputFields: [
        'contract_digest',
        'tool_schema',
        'output_schema',
        'annotations',
        'simulation_boundary'
      ],
      completionCriteria: [
        'The proposal has truthful annotations, structured output, and no activation side effect.'
      ],
      escalationConditions: [
        'The contract implies unsafe side effects, public activation, or unsupported protocol behavior.'
      ]
    },
    members: [
      {
        id: 'mcp-x402-contract-red-team',
        relation: 'reviewer',
        displayName: 'Contract Red Team',
        role: 'MCP contract critic',
        purpose:
          'Attack a pinned MCP contract for misleading annotations, schema ambiguity, replay risk, origin handling, and authority confusion.',
        lifecycle: 'template',
        runtimeMode: 'profile_only',
        sleeve: 'contract_reviews',
        evidenceRefs: ['SPEC.md#24-agent-workbench-v1'],
        tools: [
          [
            'mcp.read_contract',
            'read',
            'Read only the pinned contract revision and protocol evidence.'
          ],
          [
            'mcp.propose_security_finding',
            'propose',
            'Publish contract findings without editing or activating it.'
          ]
        ],
        stages: [
          'revision_pinned',
          'annotations_attacked',
          'schema_attacked',
          'transport_attacked',
          'findings_published'
        ],
        artifactType: 'task_market.mcp_contract_review',
        outputFields: ['contract_digest', 'findings', 'severity', 'evidence_refs', 'residual_risk'],
        completionCriteria: [
          'Every finding is evidence-linked and the review performs no publication.'
        ],
        escalationConditions: [
          'A protocol ambiguity or security issue cannot be bounded in simulation.'
        ]
      }
    ]
  },
  {
    id: 'seller',
    runtimeInstantiable: false,
    trustDomain: 'task_market',
    parentId: 'mcp-x402',
    sleeve: 'seller',
    scope: 'seller',
    lead: {
      id: 'mcp-x402-seller-operator',
      relation: 'operator',
      displayName: 'Seller Operator',
      role: 'Simulation readiness operator',
      purpose:
        'Inspect seller simulation state, fixed configuration, deployment evidence, and kill-switch posture without public activation or asset custody.',
      lifecycle: 'template',
      runtimeMode: 'profile_only',
      budget: 'leaf',
      evidenceRefs: ['src/task-market/seller-app.ts', 'deploy/task-market/README.md'],
      tools: [
        ['seller.read_simulation', 'read', 'Read bounded seller simulation state.'],
        ['deployment.read_readiness', 'read', 'Inspect fixed deployment and kill-switch evidence.'],
        ['seller.propose_readiness_report', 'propose', 'Publish a no-activation readiness report.']
      ],
      stages: [
        'configuration_pinned',
        'simulation_checked',
        'deployment_evidence_checked',
        'readiness_reported'
      ],
      artifactType: 'task_market.seller_readiness',
      outputFields: [
        'configuration_digest',
        'simulation_state',
        'deployment_checks',
        'kill_switch',
        'blocked_actions'
      ],
      completionCriteria: [
        'The report distinguishes deployment readiness from public activation and recognized revenue.'
      ],
      escalationConditions: [
        'Public hosting, production credentials, external acceptance, or asset custody is requested.'
      ]
    },
    members: [
      {
        id: 'mcp-x402-deployment-security-gate',
        relation: 'verifier',
        displayName: 'Deployment/Security Gate',
        role: 'Deployment security verifier',
        purpose:
          'Verify pinned image, proxy topology, origin policy, firewall, request limits, isolation, and kill switch before any testnet proposal.',
        lifecycle: 'template',
        runtimeMode: 'profile_only',
        sleeve: 'security_reviews',
        evidenceRefs: ['deploy/task-market/README.md', 'SPEC.md#24-agent-workbench-v1'],
        tools: [
          [
            'deployment.read_manifest',
            'read',
            'Read the pinned deployment manifest and topology evidence.'
          ],
          [
            'security.read_gate_evidence',
            'read',
            'Inspect origin, firewall, isolation, limits, and kill-switch checks.'
          ],
          [
            'security.propose_gate_verdict',
            'propose',
            'Publish a blocked or ready-for-review verdict.'
          ]
        ],
        stages: [
          'manifest_pinned',
          'topology_checked',
          'transport_checked',
          'isolation_checked',
          'kill_switch_checked',
          'verdict_published'
        ],
        artifactType: 'task_market.deployment_gate',
        outputFields: ['manifest_digest', 'checks', 'failures', 'verdict', 'operator_gate'],
        completionCriteria: [
          'Every required security check has fresh evidence and no activation occurs.'
        ],
        escalationConditions: [
          'Any topology, origin, isolation, limit, or kill-switch check is missing or fails.'
        ]
      }
    ]
  },
  {
    id: 'scouting',
    runtimeInstantiable: true,
    trustDomain: 'task_market',
    parentId: 'mcp-x402',
    sleeve: 'scouting',
    scope: 'scouting',
    lead: {
      id: 'mcp-x402-task-market-scout',
      relation: 'specialist',
      displayName: 'Task-Market Scout',
      role: 'Bounded task-market scout',
      purpose:
        'Read admitted fixed-origin signals, reject unsafe or uneconomic candidates, and produce local candidate evidence without external submission.',
      lifecycle: 'template',
      runtimeMode: 'profile_only',
      budget: 'specialist',
      evidenceRefs: ['src/task-market/scout-cycle.ts', 'src/task-market/downtime-admission.ts'],
      tools: [
        ['scout.read_admitted_signals', 'read', 'Read fixed-origin admitted task signals.'],
        [
          'task_market.propose_candidate',
          'propose',
          'Publish a local candidate without claiming or submitting.'
        ]
      ],
      stages: [
        'admission_checked',
        'signals_read',
        'candidates_filtered',
        'candidate_artifacts_published'
      ],
      artifactType: 'task_market.scout_results',
      outputFields: ['source_digest', 'admission_state', 'candidates', 'rejections', 'unknowns'],
      completionCriteria: [
        'Every candidate is local, provenance-bound, and explicitly unsubmitted.'
      ],
      escalationConditions: [
        'Signal provenance, admission, external action, or economics cannot be verified.'
      ]
    },
    members: [
      {
        id: 'mcp-x402-candidate-analyst',
        relation: 'advisor',
        displayName: 'Candidate Analyst',
        role: 'Task candidate analyst',
        purpose:
          'Assess a pinned candidate for fit, deterministic acceptance, effort, risk, evidence, and simulation economics without claiming work.',
        lifecycle: 'template',
        runtimeMode: 'profile_only',
        evidenceRefs: [
          'src/task-market/taskmarket-inspector.ts',
          'src/task-market/edge-validation.ts'
        ],
        tools: [
          ['task_market.read_candidate', 'read', 'Read one pinned bounded candidate.'],
          [
            'task_market.propose_candidate_analysis',
            'propose',
            'Publish a local fit and risk analysis.'
          ]
        ],
        stages: [
          'candidate_pinned',
          'contract_checked',
          'effort_checked',
          'risk_checked',
          'analysis_published'
        ],
        artifactType: 'task_market.candidate_analysis',
        outputFields: [
          'candidate_digest',
          'fit',
          'acceptance',
          'effort',
          'risk',
          'simulation_economics',
          'verdict'
        ],
        completionCriteria: [
          'The verdict is local evidence only and does not claim, bid, pitch, or submit.'
        ],
        escalationConditions: ['Acceptance, effort, provenance, or task authority is ambiguous.']
      },
      {
        id: 'mcp-x402-submission-verifier',
        relation: 'verifier',
        displayName: 'Submission Verifier',
        role: 'Submission intent verifier',
        purpose:
          'Verify a pinned local submission intent, digest, authorization state, and zero-external-effect boundary without performing submission.',
        lifecycle: 'template',
        runtimeMode: 'profile_only',
        sleeve: 'submission_reviews',
        evidenceRefs: ['src/task-market/submission-authorization.ts'],
        tools: [
          [
            'task_market.read_submission_intent',
            'read',
            'Read a pinned local intent and authorization evidence.'
          ],
          [
            'task_market.propose_submission_verdict',
            'propose',
            'Publish allow-review or blocked without external submission.'
          ]
        ],
        stages: [
          'intent_pinned',
          'digest_verified',
          'authorization_checked',
          'effect_boundary_checked',
          'verdict_published'
        ],
        artifactType: 'task_market.submission_verification',
        outputFields: [
          'intent_digest',
          'authorization_state',
          'effect_boundary',
          'verdict',
          'operator_gate'
        ],
        completionCriteria: [
          'The verifier performs no external submission and reports the exact operator gate.'
        ],
        escalationConditions: [
          'Intent, digest, authorization, or external-effect state is stale or inconsistent.'
        ]
      }
    ]
  },
  {
    id: 'settlement',
    runtimeInstantiable: false,
    trustDomain: 'task_market',
    parentId: 'mcp-x402',
    sleeve: 'settlement',
    scope: 'settlement',
    lead: {
      id: 'mcp-x402-settlement-auditor',
      relation: 'auditor',
      displayName: 'Settlement Auditor',
      role: 'Settlement evidence auditor',
      purpose:
        'Read bounded append-only settlement summaries and reconcile simulation evidence without recognizing revenue or controlling assets.',
      lifecycle: 'template',
      runtimeMode: 'profile_only',
      evidenceRefs: ['src/task-market/settlement-ledger.ts', 'src/revenue/contracts.ts'],
      tools: [
        ['settlement.read_summary', 'read', 'Read bounded append-only settlement evidence.'],
        [
          'task_market.read_simulation',
          'read',
          'Read the matching simulation activation and quote.'
        ],
        [
          'settlement.propose_audit',
          'propose',
          'Publish reconciliation findings without revenue recognition.'
        ]
      ],
      stages: ['evidence_pinned', 'ledger_checked', 'simulation_reconciled', 'audit_published'],
      artifactType: 'task_market.settlement_audit',
      outputFields: [
        'evidence_digest',
        'ledger_state',
        'simulation_match',
        'exceptions',
        'revenue_recognition'
      ],
      completionCriteria: [
        'The report labels revenue recognition none unless a separately authorized future system proves otherwise.'
      ],
      escalationConditions: [
        'Ledger integrity, quote, chain evidence, or recognition state cannot be reconciled.'
      ]
    },
    members: [
      {
        id: 'mcp-x402-chain-reconciler',
        relation: 'verifier',
        displayName: 'Chain Reconciler',
        role: 'Independent chain evidence reconciler',
        purpose:
          'Compare pinned public receipt evidence with the local append-only settlement record and report mismatches without transaction authority.',
        lifecycle: 'template',
        runtimeMode: 'profile_only',
        sleeve: 'settlement_reviews',
        evidenceRefs: ['src/task-market/settlement-ledger.ts', 'SPEC.md#24-agent-workbench-v1'],
        tools: [
          ['chain.read_receipt_evidence', 'read', 'Read bounded pinned public receipt evidence.'],
          ['settlement.read_summary', 'read', 'Read the corresponding local settlement summary.'],
          [
            'settlement.propose_reconciliation',
            'propose',
            'Publish match or mismatch evidence without changing the ledger.'
          ]
        ],
        stages: [
          'receipt_pinned',
          'local_record_pinned',
          'fields_compared',
          'reconciliation_published'
        ],
        artifactType: 'task_market.chain_reconciliation',
        outputFields: ['receipt_digest', 'local_digest', 'field_matches', 'exceptions', 'verdict'],
        completionCriteria: [
          'The result is independently evidenced and no transaction or ledger mutation occurs.'
        ],
        escalationConditions: [
          'Receipt provenance, finality, amount precision, or local record integrity is uncertain.'
        ]
      }
    ]
  }
];
