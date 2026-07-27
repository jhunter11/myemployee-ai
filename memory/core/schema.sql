-- SQLite schema for global Master Agent (Jarvis) Memory
-- This tracks all clients, overall metrics, and system-wide audits.

CREATE TABLE IF NOT EXISTS client_registry (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    profile_type TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    status TEXT DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS agency_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    total_active_clients INTEGER,
    total_monthly_recurring_revenue INTEGER,
    total_token_spend REAL
);

CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    severity TEXT NOT NULL,
    event_description TEXT NOT NULL,
    client_id TEXT, -- NULL if global event
    resolved BOOLEAN DEFAULT FALSE,
    FOREIGN KEY (client_id) REFERENCES client_registry(id)
);

CREATE TABLE IF NOT EXISTS task_frequency_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_signature TEXT NOT NULL, -- A hashed or categorized signature of the task
    execution_count INTEGER DEFAULT 1,
    avg_duration_seconds REAL,
    last_executed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    manual_intervention_count INTEGER DEFAULT 0
);
