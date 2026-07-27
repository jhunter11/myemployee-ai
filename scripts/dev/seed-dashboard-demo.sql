-- DEMO DATA ONLY — never run against a real operator database.
--
-- Populates the run-supervision and P&L surfaces so the dashboard can be
-- developed and visually verified without waiting for real automations. Every
-- row is prefixed `demo_` so it is trivially identifiable and removable.
--
-- Deliberately exercises all three supervisor derivations and all cost bases:
--   * demo_run_root        -> no parent, system sleeve      -> Jarvis
--   * demo_run_acme_root   -> no parent, tenant sleeve      -> sleeve manager
--   * demo_run_acme_child  -> parent_run_id set             -> delegating run
--   * cost bases observed / estimated / local / subscription / unknown, so
--     coverage renders as `partial` rather than a falsely complete total.
--
-- Usage:  npm run dev:seed-dashboard

DELETE FROM model_usage_events WHERE id LIKE 'demo_%';
DELETE FROM agent_runs WHERE id LIKE 'demo_%';
DELETE FROM client_registry WHERE id LIKE 'demo_%';

-- OR IGNORE keeps this re-runnable: `system` is a shared, non-demo id that the
-- `demo_%` cleanup above deliberately does not delete.
INSERT OR IGNORE INTO client_registry (id, name, profile_type, status) VALUES
  ('demo_acme', 'Acme Corp (demo)', 'agency_client', 'active'),
  ('demo_northwind', 'Northwind (demo)', 'agency_client', 'active'),
  ('system', 'System', 'internal', 'active');

INSERT INTO agent_runs (id, client_id, automation, status, parent_run_id, worker_id, started_at, completed_at) VALUES
  ('demo_run_root', 'system', 'nightly-reconciliation', 'succeeded', NULL, 'worker_a',
   '2026-07-24T22:10:00.000Z', '2026-07-24T22:12:41.000Z'),
  ('demo_run_acme_root', 'demo_acme', 'client-intake-review', 'succeeded', NULL, 'worker_b',
   '2026-07-24T23:05:00.000Z', '2026-07-24T23:07:12.000Z'),
  ('demo_run_acme_child', 'demo_acme', 'brief-drafting', 'succeeded', 'demo_run_acme_root', 'worker_b',
   '2026-07-24T23:07:20.000Z', '2026-07-24T23:09:02.000Z'),
  ('demo_run_acme_failed', 'demo_acme', 'invoice-preparation', 'failed', 'demo_run_acme_root', 'worker_c',
   '2026-07-25T00:15:00.000Z', '2026-07-25T00:15:48.000Z'),
  ('demo_run_northwind', 'demo_northwind', 'weekly-digest', 'running', NULL, 'worker_d',
   '2026-07-25T01:40:00.000Z', NULL),
  ('demo_run_pending', 'system', 'graph-compaction', 'pending', NULL, NULL,
   '2026-07-25T02:00:00.000Z', NULL);

INSERT INTO model_usage_events
  (id, recorded_at, client_id, operation, provider, model, route,
   input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
   latency_ms, status, cost_basis, cost_microusd, pricing_version) VALUES
  -- Acme: metered API spend, dollars genuinely known.
  ('demo_use_1', '2026-07-24T23:05:30.000Z', 'demo_acme', 'summarization', 'anthropic',
   'claude-sonnet-5', 'frontier', 4200, 900, 0, 0, 2400, 'succeeded', 'observed', 31500, 'v2026-07'),
  ('demo_use_2', '2026-07-24T23:08:10.000Z', 'demo_acme', 'drafting', 'anthropic',
   'claude-sonnet-5', 'frontier', 6100, 2300, 1200, 0, 3100, 'succeeded', 'observed', 58200, 'v2026-07'),
  ('demo_use_3', '2026-07-25T00:15:20.000Z', 'demo_acme', 'extraction', 'openai',
   'gpt-5-mini', 'economy', 1800, 400, 0, 0, 900, 'failed', 'estimated', 4100, 'v2026-07'),
  -- Northwind: flat-rate subscription. Cost per call is unknowable, so this is
  -- uncovered, NOT $0 — the sleeve must render coverage `none`.
  ('demo_use_4', '2026-07-25T01:41:00.000Z', 'demo_northwind', 'synthesis', 'anthropic',
   'claude-opus-4-8', 'frontier', 9000, 3000, 0, 0, 5200, 'succeeded', 'subscription', NULL, NULL),
  ('demo_use_5', '2026-07-25T01:44:00.000Z', 'demo_northwind', 'review', 'anthropic',
   'claude-opus-4-8', 'frontier', 3000, 1100, 0, 0, 2800, 'succeeded', 'subscription', NULL, NULL),
  -- System: local Ollama runtime. A genuine, known $0 — distinct from unknown.
  ('demo_use_6', '2026-07-24T22:10:30.000Z', 'system', 'classification', 'ollama',
   'llama3.1', 'local', 1200, 300, 0, 0, 700, 'succeeded', 'local', 0, NULL),
  ('demo_use_7', '2026-07-24T22:11:15.000Z', 'system', 'code', 'ollama',
   'qwen2.5-coder', 'local', 2600, 1400, 0, 0, 1600, 'succeeded', 'local', 0, NULL),
  -- System: one unknown-basis call, so system coverage is partial.
  ('demo_use_8', '2026-07-25T02:01:00.000Z', 'system', 'review', 'gemini',
   'gemini-2.5-pro', 'economy', NULL, NULL, NULL, NULL, 1400, 'succeeded', 'unknown', NULL, NULL);
