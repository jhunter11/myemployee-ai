CREATE TABLE IF NOT EXISTS telegram_channel_state (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  update_cursor INTEGER NOT NULL CHECK (update_cursor >= -1),
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO telegram_channel_state (singleton_id, update_cursor, updated_at)
VALUES (1, -1, '1970-01-01T00:00:00.000Z');

CREATE TABLE IF NOT EXISTS telegram_channel_inbox (
  update_id INTEGER PRIMARY KEY CHECK (update_id >= 0),
  update_digest TEXT NOT NULL CHECK (update_digest GLOB 'sha256:*'),
  identity_digest TEXT NOT NULL CHECK (identity_digest GLOB 'sha256:*'),
  redacted_kind TEXT NOT NULL CHECK (length(redacted_kind) BETWEEN 3 AND 80),
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed')),
  command_id TEXT,
  received_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_telegram_inbox_status_update
  ON telegram_channel_inbox(status, update_id);
