CREATE TABLE IF NOT EXISTS run_recovery_queue (
    run_id TEXT PRIMARY KEY,
    queued_at DATETIME NOT NULL,
    audit_id INTEGER,
    FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE,
    FOREIGN KEY (audit_id) REFERENCES audit_logs(id)
);
