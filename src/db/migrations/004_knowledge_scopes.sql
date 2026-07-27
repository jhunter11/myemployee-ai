CREATE TABLE IF NOT EXISTS knowledge_scopes (
    scope_id TEXT PRIMARY KEY,
    scope_kind TEXT NOT NULL
        CHECK (scope_kind IN ('harness', 'project', 'client')),
    subject_id TEXT NOT NULL
        CHECK (
            length(subject_id) BETWEEN 3 AND 63 AND
            substr(subject_id, 1, 1) GLOB '[a-z]' AND
            subject_id NOT GLOB '*[^a-z0-9_]*'
        ),
    parent_scope_id TEXT,
    client_id TEXT,
    root_key TEXT NOT NULL UNIQUE,
    graph_partition TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
        CHECK (length(created_at) BETWEEN 20 AND 40),
    CHECK (scope_id = scope_kind || ':' || subject_id),
    CHECK (root_key = 'knowledge/' || scope_kind || '/' || subject_id),
    CHECK (graph_partition = 'graphify/' || scope_kind || '/' || subject_id),
    CHECK (
        (
            scope_kind = 'harness' AND
            parent_scope_id IS NULL AND
            client_id IS NULL
        ) OR
        (
            scope_kind = 'project' AND
            parent_scope_id GLOB 'harness:*' AND
            client_id IS NULL
        ) OR
        (
            scope_kind = 'client' AND
            parent_scope_id GLOB 'project:*' AND
            client_id = subject_id
        )
    ),
    FOREIGN KEY (parent_scope_id) REFERENCES knowledge_scopes(scope_id),
    FOREIGN KEY (client_id) REFERENCES client_registry(id)
);

CREATE INDEX IF NOT EXISTS idx_knowledge_scopes_parent
    ON knowledge_scopes (parent_scope_id, scope_kind, scope_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_scopes_client
    ON knowledge_scopes (client_id)
    WHERE client_id IS NOT NULL;
