CREATE TABLE IF NOT EXISTS agent_conversations (
    id TEXT PRIMARY KEY
        CHECK (
            length(id) BETWEEN 16 AND 109 AND
            substr(id, 1, 13) = 'conversation:' AND
            substr(id, 14, 1) GLOB '[a-z0-9]' AND
            id NOT GLOB '*[^a-z0-9._:-]*'
        ),
    agent_id TEXT NOT NULL
        CHECK (
            length(agent_id) BETWEEN 1 AND 128 AND
            substr(agent_id, 1, 1) GLOB '[a-z]' AND
            agent_id NOT GLOB '*[^a-z0-9._:-]*'
        ),
    trust_domain TEXT NOT NULL CHECK (trust_domain IN ('personal', 'agency', 'task_market')),
    title TEXT
        CHECK (
            title IS NULL OR (
                length(title) BETWEEN 1 AND 160 AND
                trim(title) = title AND
                instr(title, char(0)) = 0
            )
        ),
    version INTEGER NOT NULL DEFAULT 1
        CHECK (typeof(version) = 'integer' AND version BETWEEN 1 AND 2147483647),
    created_at TEXT NOT NULL CHECK (unixepoch(created_at) IS NOT NULL),
    updated_at TEXT NOT NULL CHECK (unixepoch(updated_at) IS NOT NULL AND updated_at >= created_at),
    UNIQUE (id, agent_id, trust_domain)
);

CREATE TABLE IF NOT EXISTS agent_messages (
    id TEXT PRIMARY KEY
        CHECK (
            length(id) BETWEEN 11 AND 104 AND
            substr(id, 1, 8) = 'message:' AND
            substr(id, 9, 1) GLOB '[a-z0-9]' AND
            id NOT GLOB '*[^a-z0-9._:-]*'
        ),
    conversation_id TEXT NOT NULL,
    conversation_agent_id TEXT NOT NULL,
    trust_domain TEXT NOT NULL CHECK (trust_domain IN ('personal', 'agency', 'task_market')),
    sequence INTEGER NOT NULL
        CHECK (typeof(sequence) = 'integer' AND sequence BETWEEN 1 AND 2147483646),
    author_kind TEXT NOT NULL CHECK (author_kind IN ('operator', 'agent')),
    responding_agent_id TEXT
        CHECK (
            responding_agent_id IS NULL OR (
                length(responding_agent_id) BETWEEN 1 AND 128 AND
                substr(responding_agent_id, 1, 1) GLOB '[a-z]' AND
                responding_agent_id NOT GLOB '*[^a-z0-9._:-]*'
            )
        ),
    response_mode TEXT NOT NULL CHECK (response_mode IN (
        'operator_input', 'deterministic', 'profile', 'model', 'runtime_not_configured'
    )),
    message_text TEXT NOT NULL
        CHECK (
            length(message_text) BETWEEN 1 AND 16000 AND
            length(trim(message_text)) > 0 AND
            instr(message_text, char(0)) = 0
        ),
    evidence_refs_json TEXT NOT NULL
        CHECK (
            length(evidence_refs_json) BETWEEN 2 AND 16384 AND
            json_valid(evidence_refs_json) AND
            json_type(evidence_refs_json) = 'array'
        ),
    created_at TEXT NOT NULL CHECK (unixepoch(created_at) IS NOT NULL),
    UNIQUE (conversation_id, sequence),
    CHECK (
        (
            author_kind = 'operator' AND
            responding_agent_id IS NULL AND
            response_mode = 'operator_input'
        ) OR (
            author_kind = 'agent' AND
            responding_agent_id = conversation_agent_id AND
            response_mode IN ('deterministic', 'profile', 'model', 'runtime_not_configured')
        )
    ),
    FOREIGN KEY (conversation_id, conversation_agent_id, trust_domain)
        REFERENCES agent_conversations(id, agent_id, trust_domain)
);

CREATE INDEX IF NOT EXISTS idx_agent_conversations_agent_updated
    ON agent_conversations (agent_id, trust_domain, updated_at DESC, id);

CREATE INDEX IF NOT EXISTS idx_agent_messages_conversation_sequence
    ON agent_messages (conversation_id, conversation_agent_id, trust_domain, sequence);

CREATE TRIGGER IF NOT EXISTS agent_conversations_append_transition
BEFORE UPDATE ON agent_conversations
WHEN
    OLD.id IS NOT NEW.id OR
    OLD.agent_id IS NOT NEW.agent_id OR
    OLD.trust_domain IS NOT NEW.trust_domain OR
    OLD.title IS NOT NEW.title OR
    OLD.created_at IS NOT NEW.created_at OR
    NEW.version <> OLD.version + 1 OR
    NEW.updated_at < OLD.updated_at
BEGIN
    SELECT RAISE(ABORT, 'agent conversation identity is immutable');
END;

CREATE TRIGGER IF NOT EXISTS agent_conversations_no_delete
BEFORE DELETE ON agent_conversations
BEGIN
    SELECT RAISE(ABORT, 'agent conversations cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS agent_messages_no_update
BEFORE UPDATE ON agent_messages
BEGIN
    SELECT RAISE(ABORT, 'agent messages are append-only');
END;

CREATE TRIGGER IF NOT EXISTS agent_messages_no_delete
BEFORE DELETE ON agent_messages
BEGIN
    SELECT RAISE(ABORT, 'agent messages are append-only');
END;
