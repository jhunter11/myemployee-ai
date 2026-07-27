CREATE TABLE IF NOT EXISTS calendar_provider_connections (
    connection_id TEXT PRIMARY KEY
        CHECK (
            length(connection_id) BETWEEN 3 AND 64 AND
            substr(connection_id, 1, 1) GLOB '[a-z]' AND
            connection_id NOT GLOB '*[^a-z0-9_]*'
        ),
    scope_kind TEXT NOT NULL CHECK (scope_kind IN ('personal', 'client')),
    scope_id TEXT NOT NULL
        CHECK (
            length(scope_id) BETWEEN 10 AND 103 AND
            scope_id NOT GLOB '*[^a-z0-9_:-]*' AND
            (
                (scope_kind = 'personal' AND substr(scope_id, 1, 9) = 'personal:') OR
                (scope_kind = 'client' AND substr(scope_id, 1, 7) = 'client:')
            )
        ),
    provider_key TEXT NOT NULL
        CHECK (
            length(provider_key) BETWEEN 2 AND 64 AND
            substr(provider_key, 1, 1) GLOB '[a-z]' AND
            provider_key NOT GLOB '*[^a-z0-9_]*'
        ),
    state TEXT NOT NULL CHECK (state IN (
        'disconnected', 'active', 'credential_expired', 'revoked', 'provider_error'
    )),
    sync_cursor TEXT CHECK (
        sync_cursor IS NULL OR length(sync_cursor) BETWEEN 1 AND 4096
    ),
    credential_expires_at TEXT CHECK (
        credential_expires_at IS NULL OR unixepoch(credential_expires_at) IS NOT NULL
    ),
    last_synced_at TEXT CHECK (
        last_synced_at IS NULL OR unixepoch(last_synced_at) IS NOT NULL
    ),
    last_error_code TEXT CHECK (last_error_code IS NULL OR last_error_code IN (
        'credential_expired', 'revoked', 'provider_unavailable', 'invalid_response'
    )),
    version INTEGER NOT NULL
        CHECK (typeof(version) = 'integer' AND version BETWEEN 1 AND 2147483647),
    created_at TEXT NOT NULL CHECK (unixepoch(created_at) IS NOT NULL),
    updated_at TEXT NOT NULL CHECK (
        unixepoch(updated_at) IS NOT NULL AND updated_at >= created_at
    ),
    CHECK (
        (state = 'disconnected' AND credential_expires_at IS NULL) OR
        state <> 'disconnected'
    ),
    CHECK (
        (state = 'active' AND last_error_code IS NULL) OR
        state <> 'active'
    ),
    CHECK (
        (state = 'credential_expired' AND last_error_code = 'credential_expired') OR
        state <> 'credential_expired'
    ),
    CHECK (
        (state = 'revoked' AND last_error_code = 'revoked') OR
        state <> 'revoked'
    ),
    CHECK (
        (state = 'provider_error' AND last_error_code IN ('provider_unavailable', 'invalid_response')) OR
        state <> 'provider_error'
    ),
    UNIQUE (connection_id, scope_id)
);

CREATE INDEX IF NOT EXISTS idx_calendar_connections_scope
    ON calendar_provider_connections (scope_id, state, connection_id);

CREATE TABLE IF NOT EXISTS calendar_provider_events (
    calendar_event_id TEXT PRIMARY KEY
        CHECK (
            length(calendar_event_id) = 57 AND
            substr(calendar_event_id, 1, 9) = 'calendar:' AND
            substr(calendar_event_id, 10) NOT GLOB '*[^a-f0-9]*'
        ),
    connection_id TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    provider_event_id TEXT NOT NULL CHECK (length(provider_event_id) BETWEEN 1 AND 512),
    provider_revision TEXT NOT NULL CHECK (length(provider_revision) BETWEEN 1 AND 512),
    title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 160),
    start_at TEXT NOT NULL CHECK (unixepoch(start_at) IS NOT NULL),
    end_at TEXT NOT NULL CHECK (unixepoch(end_at) IS NOT NULL AND end_at > start_at),
    all_day INTEGER NOT NULL CHECK (typeof(all_day) = 'integer' AND all_day IN (0, 1)),
    location TEXT CHECK (location IS NULL OR length(trim(location)) BETWEEN 1 AND 160),
    attendee_count INTEGER NOT NULL CHECK (
        typeof(attendee_count) = 'integer' AND attendee_count BETWEEN 0 AND 500
    ),
    event_state TEXT NOT NULL CHECK (event_state IN ('active', 'deleted')),
    first_seen_at TEXT NOT NULL CHECK (unixepoch(first_seen_at) IS NOT NULL),
    updated_at TEXT NOT NULL CHECK (
        unixepoch(updated_at) IS NOT NULL AND updated_at >= first_seen_at
    ),
    UNIQUE (connection_id, provider_event_id),
    FOREIGN KEY (connection_id, scope_id)
        REFERENCES calendar_provider_connections(connection_id, scope_id)
);

CREATE INDEX IF NOT EXISTS idx_calendar_events_scope_window
    ON calendar_provider_events (scope_id, connection_id, event_state, start_at, end_at);

CREATE TRIGGER IF NOT EXISTS calendar_connections_guard_update
BEFORE UPDATE ON calendar_provider_connections
WHEN
    OLD.connection_id IS NOT NEW.connection_id OR
    OLD.scope_kind IS NOT NEW.scope_kind OR
    OLD.scope_id IS NOT NEW.scope_id OR
    OLD.provider_key IS NOT NEW.provider_key OR
    OLD.created_at IS NOT NEW.created_at OR
    NEW.version <> OLD.version + 1
BEGIN
    SELECT RAISE(ABORT, 'calendar connection ownership is immutable and versioned');
END;

CREATE TRIGGER IF NOT EXISTS calendar_events_guard_update
BEFORE UPDATE ON calendar_provider_events
WHEN
    OLD.calendar_event_id IS NOT NEW.calendar_event_id OR
    OLD.connection_id IS NOT NEW.connection_id OR
    OLD.scope_id IS NOT NEW.scope_id OR
    OLD.provider_event_id IS NOT NEW.provider_event_id OR
    OLD.first_seen_at IS NOT NEW.first_seen_at
BEGIN
    SELECT RAISE(ABORT, 'calendar event ownership is immutable');
END;
