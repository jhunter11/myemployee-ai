DROP TRIGGER IF EXISTS agent_conversations_canonical_insert;
DROP TRIGGER IF EXISTS agent_messages_canonical_insert;
DROP TRIGGER IF EXISTS agent_conversations_version_requires_message;
DROP TRIGGER IF EXISTS agent_messages_advance_conversation;

CREATE TRIGGER IF NOT EXISTS agent_conversations_canonical_insert
BEFORE INSERT ON agent_conversations
WHEN
    NEW.id GLOB '*[._:-][._:-]*' OR
    substr(NEW.id, -1, 1) GLOB '[._:-]' OR
    NEW.agent_id GLOB '*[._:-][._:-]*' OR
    substr(NEW.agent_id, -1, 1) GLOB '[._:-]' OR
    (
        NEW.title IS NOT NULL AND EXISTS (
            WITH RECURSIVE positions(index_value) AS (
                SELECT 1
                UNION ALL
                SELECT index_value + 1
                FROM positions
                WHERE index_value < length(NEW.title)
            )
            SELECT 1
            FROM positions
            WHERE
                unicode(substr(NEW.title, index_value, 1)) < 32 OR
                unicode(substr(NEW.title, index_value, 1)) = 127
        )
    )
BEGIN
    SELECT RAISE(ABORT, 'agent conversation canonical contract failed');
END;

CREATE TRIGGER IF NOT EXISTS agent_messages_canonical_insert
BEFORE INSERT ON agent_messages
WHEN
    NEW.id GLOB '*[._:-][._:-]*' OR
    substr(NEW.id, -1, 1) GLOB '[._:-]' OR
    NEW.conversation_id GLOB '*[._:-][._:-]*' OR
    substr(NEW.conversation_id, -1, 1) GLOB '[._:-]' OR
    NEW.conversation_agent_id GLOB '*[._:-][._:-]*' OR
    substr(NEW.conversation_agent_id, -1, 1) GLOB '[._:-]' OR
    NEW.sequence <> (
        SELECT version
        FROM agent_conversations
        WHERE
            id = NEW.conversation_id AND
            agent_id = NEW.conversation_agent_id AND
            trust_domain = NEW.trust_domain
    ) OR
    julianday(NEW.created_at) < (
        SELECT julianday(updated_at)
        FROM agent_conversations
        WHERE
            id = NEW.conversation_id AND
            agent_id = NEW.conversation_agent_id AND
            trust_domain = NEW.trust_domain
    ) OR
    json_array_length(NEW.evidence_refs_json) > 32 OR
    EXISTS (
        SELECT 1
        FROM json_each(NEW.evidence_refs_json)
        WHERE
            type <> 'text' OR
            length(value) NOT BETWEEN 1 AND 256 OR
            substr(value, 1, 1) NOT GLOB '[A-Za-z0-9]' OR
            value GLOB '*[^A-Za-z0-9._:/#@-]*'
    ) OR
    (
        SELECT count(*)
        FROM json_each(NEW.evidence_refs_json)
    ) <> (
        SELECT count(DISTINCT value)
        FROM json_each(NEW.evidence_refs_json)
    )
BEGIN
    SELECT RAISE(ABORT, 'agent message canonical contract failed');
END;

CREATE TRIGGER IF NOT EXISTS agent_conversations_version_requires_message
BEFORE UPDATE ON agent_conversations
WHEN NOT EXISTS (
    SELECT 1
    FROM agent_messages
    WHERE
        conversation_id = NEW.id AND
        conversation_agent_id = NEW.agent_id AND
        trust_domain = NEW.trust_domain AND
        sequence = NEW.version - 1 AND
        created_at = NEW.updated_at
)
BEGIN
    SELECT RAISE(ABORT, 'agent conversation version requires a matching message');
END;

CREATE TRIGGER IF NOT EXISTS agent_messages_advance_conversation
AFTER INSERT ON agent_messages
BEGIN
    UPDATE agent_conversations
    SET
        version = version + 1,
        updated_at = NEW.created_at
    WHERE
        id = NEW.conversation_id AND
        agent_id = NEW.conversation_agent_id AND
        trust_domain = NEW.trust_domain AND
        version = NEW.sequence AND
        version < 2147483647 AND
        julianday(NEW.created_at) >= julianday(updated_at);

    SELECT CASE
        WHEN changes() <> 1
        THEN RAISE(ABORT, 'agent message checkpoint advance failed')
    END;
END;
