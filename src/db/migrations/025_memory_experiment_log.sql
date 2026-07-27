-- Append-only memory-architecture experiment log (Report 4: experimental program).
--
-- The report's machine-readable run-log schema, made durable. Two tables:
--   * memory_experiment_runs   -> one row per (phase, arm, split, item) replay, with
--                                 the FULL manifest: model/env identity, frozen budget,
--                                 seeds, simulated time, and every stage hash.
--   * memory_experiment_scores -> one row per metric per run.
--
-- The program's hardest rule is enforced here rather than in prose: REFUSE TO SCORE
-- ANY RUN LACKING A COMPLETE MANIFEST. Every manifest, budget, seed, and hash column
-- is NOT NULL with a shape CHECK, and a score row is refused unless its parent run
-- carries a complete manifest. A partially-manifested run cannot exist, so it cannot
-- be half-scored into a leaderboard that no downstream statistic could clean up.
--
-- Discipline matches 023/024: immutable rows, no updates at all, no deletes. A run log
-- is evidence; amending one silently would destroy the reproducibility claim the whole
-- program rests on. A rerun that disagrees is a NEW run, or a refused insert.

CREATE TABLE IF NOT EXISTS memory_experiment_runs (
    run_id TEXT PRIMARY KEY
        CHECK (
            length(run_id) BETWEEN 1 AND 128 AND
            substr(run_id, 1, 1) GLOB '[A-Za-z0-9]' AND
            run_id NOT GLOB '*[^A-Za-z0-9._:-]*'
        ),

    -- --- Experimental identity ---------------------------------------------
    phase_id TEXT NOT NULL
        CHECK (
            phase_id IN (
                'harness_validation', 'representation_screening', 'confirmatory_comparison',
                'budget_ablation', 'consolidation_forgetting', 'hierarchy_privacy'
            )
        ),
    arm_id TEXT NOT NULL
        CHECK (
            arm_id IN (
                'FlatTag', 'TypedBasic', 'TypedTemporal', 'Hierarchical',
                'GraphAssist', 'EpisodeOnly', 'FactOnly', 'HybridLedger'
            )
        ),
    dataset_split TEXT NOT NULL
        CHECK (
            dataset_split IN (
                'synthetic_micro', 'synthetic_dev', 'synthetic_holdout', 'real_shadow_holdout'
            )
        ),
    item_id TEXT NOT NULL
        CHECK (
            length(item_id) BETWEEN 3 AND 128 AND
            substr(item_id, 1, 1) GLOB '[a-z]' AND
            item_id NOT GLOB '*[^a-z0-9_]*'
        ),
    item_family TEXT NOT NULL
        CHECK (
            item_family IN (
                'person_state', 'project_state', 'cross_project', 'tool_procedure',
                'update_control', 'reasoning', 'multi_agent', 'adversarial'
            )
        ),
    item_tier TEXT NOT NULL CHECK (item_tier IN ('easy', 'medium', 'hard', 'very_hard')),

    -- --- Replay identity: what bytes were replayed and scored against -------
    history_hash TEXT NOT NULL
        CHECK (length(history_hash) = 64 AND history_hash NOT GLOB '*[^a-f0-9]*'),
    ground_truth_hash TEXT NOT NULL
        CHECK (length(ground_truth_hash) = 64 AND ground_truth_hash NOT GLOB '*[^a-f0-9]*'),
    workload_fingerprint TEXT NOT NULL
        CHECK (length(workload_fingerprint) = 64 AND workload_fingerprint NOT GLOB '*[^a-f0-9]*'),

    -- --- Model/environment manifest ----------------------------------------
    -- The report treats the environment as part of the experiment: an arm compared
    -- across two runtimes is two experiments. These are all NOT NULL because a run
    -- that cannot name its environment cannot be replicated, and a run that cannot
    -- be replicated is not scorable.
    harness_version TEXT NOT NULL
        CHECK (
            length(harness_version) BETWEEN 1 AND 64 AND
            substr(harness_version, 1, 1) GLOB '[a-z0-9]' AND
            harness_version NOT GLOB '*[^a-z0-9._-]*'
        ),
    backend_id TEXT NOT NULL
        CHECK (backend_id IN ('flat_untyped', 'flat', 'typed_hybrid', 'typed_temporal', 'ledger')),
    runtime_name TEXT NOT NULL CHECK (length(trim(runtime_name)) BETWEEN 1 AND 64),
    runtime_version TEXT NOT NULL CHECK (length(trim(runtime_version)) BETWEEN 1 AND 64),
    platform TEXT NOT NULL CHECK (length(trim(platform)) BETWEEN 1 AND 64),
    -- Zero answer-model calls is a legitimate manifest (retrieval-only replay); an
    -- ABSENT model identity is not, so the field is recorded either way.
    answer_model TEXT NOT NULL CHECK (length(trim(answer_model)) BETWEEN 1 AND 96),

    -- --- Frozen fairness budget --------------------------------------------
    -- Carried per run, not per experiment, so scoring can re-verify fairness against
    -- the row it is scoring instead of trusting a launch-time convention.
    candidate_cap INTEGER NOT NULL
        CHECK (typeof(candidate_cap) = 'integer' AND candidate_cap BETWEEN 1 AND 1000),
    compiled_context_token_cap INTEGER NOT NULL
        CHECK (
            typeof(compiled_context_token_cap) = 'integer' AND
            compiled_context_token_cap BETWEEN 1 AND 200000
        ),
    store_bytes_cap INTEGER NOT NULL
        CHECK (
            typeof(store_bytes_cap) = 'integer' AND
            store_bytes_cap BETWEEN 1024 AND 1099511627776
        ),
    llm_call_cap INTEGER NOT NULL
        CHECK (typeof(llm_call_cap) = 'integer' AND llm_call_cap BETWEEN 0 AND 64),
    retrieval_k INTEGER NOT NULL
        CHECK (typeof(retrieval_k) = 'integer' AND retrieval_k BETWEEN 1 AND 1000),

    -- --- Seeds and simulated clock -----------------------------------------
    -- The only entropy the program ever sees, and the only clock it ever reads.
    workload_seed INTEGER NOT NULL
        CHECK (typeof(workload_seed) = 'integer' AND workload_seed >= 0),
    attack_seed INTEGER NOT NULL
        CHECK (typeof(attack_seed) = 'integer' AND attack_seed >= 0),
    simulated_time TEXT NOT NULL CHECK (unixepoch(simulated_time) IS NOT NULL),
    recorded_at TEXT NOT NULL CHECK (unixepoch(recorded_at) IS NOT NULL),

    -- --- Stage instrumentation ---------------------------------------------
    llm_calls INTEGER NOT NULL
        CHECK (typeof(llm_calls) = 'integer' AND llm_calls BETWEEN 0 AND 1000),
    write_count INTEGER NOT NULL
        CHECK (typeof(write_count) = 'integer' AND write_count BETWEEN 0 AND 2000),
    accepted_write_count INTEGER NOT NULL
        CHECK (typeof(accepted_write_count) = 'integer' AND accepted_write_count BETWEEN 0 AND 2000),
    maintenance_count INTEGER NOT NULL
        CHECK (typeof(maintenance_count) = 'integer' AND maintenance_count BETWEEN 0 AND 2000),
    candidate_count INTEGER NOT NULL
        CHECK (typeof(candidate_count) = 'integer' AND candidate_count BETWEEN 0 AND 1000),
    compiled_context_hash TEXT NOT NULL
        CHECK (length(compiled_context_hash) = 64 AND compiled_context_hash NOT GLOB '*[^a-f0-9]*'),
    compiled_context_tokens INTEGER NOT NULL
        CHECK (
            typeof(compiled_context_tokens) = 'integer' AND
            compiled_context_tokens BETWEEN 0 AND 1000000
        ),
    compiled_context_items INTEGER NOT NULL
        CHECK (
            typeof(compiled_context_items) = 'integer' AND
            compiled_context_items BETWEEN 0 AND 1000
        ),
    compiled_context_truncated INTEGER NOT NULL
        CHECK (
            typeof(compiled_context_truncated) = 'integer' AND
            compiled_context_truncated IN (0, 1)
        ),

    -- --- Output hashes ------------------------------------------------------
    -- Hashes only. Storing the assembled answer would put gold strings and client
    -- content into every archived run, which the contamination protocol forbids.
    answer_sha256 TEXT
        CHECK (
            answer_sha256 IS NULL OR
            (length(answer_sha256) = 64 AND answer_sha256 NOT GLOB '*[^a-f0-9]*')
        ),
    action_trace_sha256 TEXT
        CHECK (
            action_trace_sha256 IS NULL OR
            (length(action_trace_sha256) = 64 AND action_trace_sha256 NOT GLOB '*[^a-f0-9]*')
        ),
    abstained INTEGER NOT NULL
        CHECK (typeof(abstained) = 'integer' AND abstained IN (0, 1)),

    -- The canonical digest of the whole ArmRunLog. Two bench executions are
    -- bit-identical exactly when every one of these agrees.
    run_log_sha256 TEXT NOT NULL
        CHECK (length(run_log_sha256) = 64 AND run_log_sha256 NOT GLOB '*[^a-f0-9]*'),

    -- The fairness caps re-asserted as row invariants: a run that exceeded a frozen
    -- cap is refused storage rather than stored and filtered out at scoring time.
    CHECK (candidate_count <= candidate_cap),
    CHECK (compiled_context_tokens <= compiled_context_token_cap),
    CHECK (retrieval_k <= candidate_cap),
    CHECK (llm_calls <= llm_call_cap),
    CHECK (accepted_write_count <= write_count),
    -- A scored run must produce an answer or an action trace, and an abstention that
    -- still executed actions is not an abstention.
    CHECK (answer_sha256 IS NOT NULL OR action_trace_sha256 IS NOT NULL),
    CHECK (abstained = 0 OR action_trace_sha256 IS NULL),
    -- One scored run per arm per item per phase and split. A second, divergent replay
    -- is a different experiment and needs its own run id.
    UNIQUE (phase_id, arm_id, dataset_split, item_id)
);

CREATE INDEX IF NOT EXISTS idx_memory_experiment_runs_phase_arm
    ON memory_experiment_runs (phase_id, dataset_split, arm_id, item_id, run_id);

CREATE INDEX IF NOT EXISTS idx_memory_experiment_runs_item
    ON memory_experiment_runs (item_id, phase_id, arm_id, run_id);

CREATE TABLE IF NOT EXISTS memory_experiment_scores (
    run_id TEXT NOT NULL,
    -- `group.field`, exactly the contract's METRIC_PATHS vocabulary. The group is
    -- constrained here so a typo cannot invent a metric a gate would then never find.
    metric_path TEXT NOT NULL
        CHECK (
            length(metric_path) BETWEEN 5 AND 96 AND
            instr(metric_path, '.') > 1 AND
            substr(metric_path, 1, instr(metric_path, '.') - 1) IN (
                'write', 'maintenance', 'retrieval', 'compilation', 'behavior'
            ) AND
            length(substr(metric_path, instr(metric_path, '.') + 1)) >= 1 AND
            substr(metric_path, instr(metric_path, '.') + 1) NOT GLOB '*[^A-Za-z0-9]*'
        ),
    -- NULL means "not computed". The gate evaluator reads that as a FAILURE, so the
    -- column stays nullable on purpose: erasing the difference between an unmeasured
    -- metric and a measured zero is exactly how a safety gate goes quiet.
    metric_value REAL
        CHECK (metric_value IS NULL OR typeof(metric_value) IN ('real', 'integer')),
    PRIMARY KEY (run_id, metric_path),
    FOREIGN KEY (run_id) REFERENCES memory_experiment_runs(run_id)
);

CREATE INDEX IF NOT EXISTS idx_memory_experiment_scores_metric
    ON memory_experiment_scores (metric_path, run_id, metric_value);

-- Defence in depth for the program's refusal rule. The NOT NULL columns above already
-- make an incomplete manifest unstorable; this trigger makes the same rule explicit at
-- the SCORING boundary, so a future migration that relaxes a column cannot quietly
-- re-enable half-manifested scoring.
CREATE TRIGGER IF NOT EXISTS memory_experiment_scores_require_manifest
BEFORE INSERT ON memory_experiment_scores
WHEN NOT EXISTS (
    SELECT 1 FROM memory_experiment_runs
    WHERE run_id = new.run_id
      AND length(trim(harness_version)) > 0
      AND length(trim(backend_id)) > 0
      AND length(trim(runtime_name)) > 0
      AND length(trim(runtime_version)) > 0
      AND length(trim(platform)) > 0
      AND length(trim(answer_model)) > 0
      AND length(history_hash) = 64
      AND length(ground_truth_hash) = 64
      AND length(workload_fingerprint) = 64
      AND length(run_log_sha256) = 64
      AND unixepoch(simulated_time) IS NOT NULL
)
BEGIN
    SELECT RAISE(ABORT, 'experiment run manifest is incomplete; refusing to score');
END;

-- Fully immutable. Unlike 023's stores there is no legitimate supersession pointer to
-- set later: a run log records what happened once, and every later fact about it is a
-- new row somewhere else.
CREATE TRIGGER IF NOT EXISTS memory_experiment_runs_guard_update
BEFORE UPDATE ON memory_experiment_runs
BEGIN
    SELECT RAISE(ABORT, 'experiment runs are immutable');
END;

CREATE TRIGGER IF NOT EXISTS memory_experiment_scores_guard_update
BEFORE UPDATE ON memory_experiment_scores
BEGIN
    SELECT RAISE(ABORT, 'experiment scores are immutable');
END;

CREATE TRIGGER IF NOT EXISTS memory_experiment_runs_no_delete
BEFORE DELETE ON memory_experiment_runs
BEGIN SELECT RAISE(ABORT, 'experiment runs cannot be deleted'); END;

CREATE TRIGGER IF NOT EXISTS memory_experiment_scores_no_delete
BEFORE DELETE ON memory_experiment_scores
BEGIN SELECT RAISE(ABORT, 'experiment scores cannot be deleted'); END;
