BEGIN IMMEDIATE;

CREATE TABLE IF NOT EXISTS jarvis_primary_schema (
    singleton_id TEXT PRIMARY KEY CHECK (singleton_id = 'primary'),
    schema_version INTEGER NOT NULL CHECK (schema_version >= 1)
);

CREATE TRIGGER IF NOT EXISTS jarvis_primary_schema_no_delete
BEFORE DELETE ON jarvis_primary_schema
BEGIN
    SELECT RAISE(ABORT, 'primary schema version cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS jarvis_primary_schema_monotonic_update
BEFORE UPDATE ON jarvis_primary_schema
WHEN
    OLD.singleton_id IS NOT NEW.singleton_id OR
    NEW.schema_version != OLD.schema_version + 1
BEGIN
    SELECT RAISE(ABORT, 'primary schema version must advance exactly once');
END;

INSERT OR IGNORE INTO jarvis_primary_schema (singleton_id, schema_version)
VALUES ('primary', 19);

UPDATE jarvis_primary_schema
SET schema_version = 19
WHERE singleton_id = 'primary' AND schema_version = 18;

COMMIT;
