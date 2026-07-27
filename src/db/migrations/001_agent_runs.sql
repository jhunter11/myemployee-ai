CREATE TABLE IF NOT EXISTS agent_runs (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    automation TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
    input_json TEXT,
    output_json TEXT,
    error_message TEXT,
    parent_run_id TEXT,
    worker_id TEXT,
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME,
    FOREIGN KEY (client_id) REFERENCES client_registry(id)
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_client_started
    ON agent_runs (client_id, started_at DESC);

-- The canonical table intentionally remains unchanged. This additive invariant
-- makes each frequency update a single, concurrency-safe SQLite upsert.
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_frequency_log_signature_unique
    ON task_frequency_log (task_signature);
