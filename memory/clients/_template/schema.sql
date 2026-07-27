-- SQLite schema for isolated Client Agent Memory
-- This tracks tasks, CRM-like data, and specific interactions unique to this client.

CREATE TABLE IF NOT EXISTS task_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_name TEXT NOT NULL,
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME,
    status TEXT NOT NULL, -- 'pending', 'success', 'failed'
    tokens_used INTEGER DEFAULT 0,
    result_summary TEXT
);

CREATE TABLE IF NOT EXISTS crm_leads (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    name TEXT,
    company TEXT,
    status TEXT DEFAULT 'new',
    last_contacted_at DATETIME,
    ai_analysis_notes TEXT
);

CREATE TABLE IF NOT EXISTS agent_scratchpad (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT UNIQUE NOT NULL,
    value_json TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
