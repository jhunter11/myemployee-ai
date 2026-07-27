CREATE TABLE IF NOT EXISTS memory_fragments (
    fragment_id TEXT PRIMARY KEY
        CHECK (
            length(fragment_id) BETWEEN 1 AND 128 AND
            substr(fragment_id, 1, 1) GLOB '[A-Za-z0-9]' AND
            fragment_id NOT GLOB '*[^A-Za-z0-9._:-]*'
        ),
    owner_scope_id TEXT NOT NULL,
    sleeve_id TEXT NOT NULL,
    source_id TEXT NOT NULL
        CHECK (
            length(source_id) BETWEEN 1 AND 160 AND
            substr(source_id, 1, 1) GLOB '[A-Za-z0-9]' AND
            source_id NOT GLOB '*[^A-Za-z0-9._:/-]*'
        ),
    source_hash TEXT NOT NULL
        CHECK (length(source_hash) = 64 AND source_hash NOT GLOB '*[^a-f0-9]*'),
    extraction_version TEXT NOT NULL
        CHECK (
            length(extraction_version) BETWEEN 1 AND 64 AND
            substr(extraction_version, 1, 1) GLOB '[a-z0-9]' AND
            extraction_version NOT GLOB '*[^a-z0-9._-]*'
        ),
    memory_kind TEXT NOT NULL
        CHECK (
            memory_kind IN (
                'policy', 'identity', 'fact', 'decision', 'preference',
                'procedure', 'blueprint', 'episode', 'artifact', 'summary'
            )
        ),
    title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 240),
    content TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 65536),
    tags_json TEXT NOT NULL CHECK (json_valid(tags_json) AND json_type(tags_json) = 'array'),
    tags_text TEXT NOT NULL CHECK (length(tags_text) <= 1024),
    valid_from TEXT NOT NULL CHECK (unixepoch(valid_from) IS NOT NULL),
    valid_until TEXT CHECK (valid_until IS NULL OR unixepoch(valid_until) IS NOT NULL),
    recorded_at TEXT NOT NULL CHECK (unixepoch(recorded_at) IS NOT NULL),
    confidence_permille INTEGER NOT NULL
        CHECK (typeof(confidence_permille) = 'integer' AND confidence_permille BETWEEN 0 AND 1000),
    sensitivity TEXT NOT NULL
        CHECK (sensitivity IN ('public', 'internal', 'confidential', 'private', 'restricted')),
    supersedes_fragment_id TEXT,
    superseded_by_fragment_id TEXT,
    review_at TEXT CHECK (review_at IS NULL OR unixepoch(review_at) IS NOT NULL),
    expires_at TEXT CHECK (expires_at IS NULL OR unixepoch(expires_at) IS NOT NULL),
    retrieval_eligible INTEGER NOT NULL
        CHECK (typeof(retrieval_eligible) = 'integer' AND retrieval_eligible IN (0, 1)),
    CHECK (valid_until IS NULL OR unixepoch(valid_until) > unixepoch(valid_from)),
    CHECK (expires_at IS NULL OR unixepoch(expires_at) > unixepoch(recorded_at)),
    CHECK (supersedes_fragment_id IS NULL OR supersedes_fragment_id <> fragment_id),
    CHECK (superseded_by_fragment_id IS NULL OR superseded_by_fragment_id <> fragment_id),
    FOREIGN KEY (owner_scope_id) REFERENCES control_scopes(scope_id),
    FOREIGN KEY (sleeve_id) REFERENCES memory_sleeves(sleeve_id),
    FOREIGN KEY (supersedes_fragment_id) REFERENCES memory_fragments(fragment_id),
    FOREIGN KEY (superseded_by_fragment_id) REFERENCES memory_fragments(fragment_id)
);

CREATE INDEX IF NOT EXISTS idx_memory_fragments_scope_source
    ON memory_fragments (sleeve_id, owner_scope_id, source_id, recorded_at DESC, fragment_id);

CREATE INDEX IF NOT EXISTS idx_memory_fragments_scope_eligibility
    ON memory_fragments (
        sleeve_id,
        owner_scope_id,
        retrieval_eligible,
        superseded_by_fragment_id,
        expires_at,
        valid_from,
        valid_until
    );

CREATE TRIGGER IF NOT EXISTS memory_fragments_scope_binding_insert
BEFORE INSERT ON memory_fragments
WHEN NOT EXISTS (
    SELECT 1
    FROM memory_sleeves
    WHERE sleeve_id = new.sleeve_id
      AND owner_scope_id = new.owner_scope_id
      AND state = 'active'
)
BEGIN
    SELECT RAISE(ABORT, 'memory fragment sleeve binding invalid');
END;

CREATE TRIGGER IF NOT EXISTS memory_fragments_supersession_binding_insert
BEFORE INSERT ON memory_fragments
WHEN new.supersedes_fragment_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM memory_fragments
    WHERE fragment_id = new.supersedes_fragment_id
      AND sleeve_id = new.sleeve_id
      AND owner_scope_id = new.owner_scope_id
)
BEGIN
    SELECT RAISE(ABORT, 'memory supersession cannot cross sleeves');
END;

CREATE TRIGGER IF NOT EXISTS memory_fragments_guard_update
BEFORE UPDATE ON memory_fragments
WHEN
    old.fragment_id IS NOT new.fragment_id OR
    old.owner_scope_id IS NOT new.owner_scope_id OR
    old.sleeve_id IS NOT new.sleeve_id OR
    old.source_id IS NOT new.source_id OR
    old.source_hash IS NOT new.source_hash OR
    old.extraction_version IS NOT new.extraction_version OR
    old.memory_kind IS NOT new.memory_kind OR
    old.title IS NOT new.title OR
    old.content IS NOT new.content OR
    old.tags_json IS NOT new.tags_json OR
    old.tags_text IS NOT new.tags_text OR
    old.valid_from IS NOT new.valid_from OR
    old.valid_until IS NOT new.valid_until OR
    old.recorded_at IS NOT new.recorded_at OR
    old.confidence_permille IS NOT new.confidence_permille OR
    old.sensitivity IS NOT new.sensitivity OR
    old.supersedes_fragment_id IS NOT new.supersedes_fragment_id OR
    old.review_at IS NOT new.review_at OR
    old.expires_at IS NOT new.expires_at OR
    old.retrieval_eligible IS NOT new.retrieval_eligible OR
    old.superseded_by_fragment_id IS NOT NULL OR
    new.superseded_by_fragment_id IS NULL OR
    NOT EXISTS (
        SELECT 1
        FROM memory_fragments AS successor
        WHERE successor.fragment_id = new.superseded_by_fragment_id
          AND successor.sleeve_id = old.sleeve_id
          AND successor.owner_scope_id = old.owner_scope_id
    )
BEGIN
    SELECT RAISE(ABORT, 'memory fragment immutable binding or supersession failed');
END;

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fragments_fts USING fts5(
    title,
    content,
    tags_text,
    content = 'memory_fragments',
    content_rowid = 'rowid',
    tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS memory_fragments_fts_after_insert
AFTER INSERT ON memory_fragments BEGIN
    INSERT INTO memory_fragments_fts(rowid, title, content, tags_text)
    VALUES (new.rowid, new.title, new.content, new.tags_text);
END;

CREATE TRIGGER IF NOT EXISTS memory_fragments_fts_after_delete
AFTER DELETE ON memory_fragments BEGIN
    INSERT INTO memory_fragments_fts(memory_fragments_fts, rowid, title, content, tags_text)
    VALUES ('delete', old.rowid, old.title, old.content, old.tags_text);
END;

CREATE TRIGGER IF NOT EXISTS memory_fragments_fts_after_update
AFTER UPDATE OF title, content, tags_text ON memory_fragments BEGIN
    INSERT INTO memory_fragments_fts(memory_fragments_fts, rowid, title, content, tags_text)
    VALUES ('delete', old.rowid, old.title, old.content, old.tags_text);
    INSERT INTO memory_fragments_fts(rowid, title, content, tags_text)
    VALUES (new.rowid, new.title, new.content, new.tags_text);
END;

INSERT INTO memory_fragments_fts(memory_fragments_fts) VALUES ('rebuild');
