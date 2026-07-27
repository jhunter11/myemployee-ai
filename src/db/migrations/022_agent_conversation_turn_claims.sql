CREATE TABLE IF NOT EXISTS agent_conversation_turn_claims (
    conversation_id TEXT NOT NULL,
    conversation_agent_id TEXT NOT NULL,
    trust_domain TEXT NOT NULL CHECK (trust_domain IN ('personal', 'agency', 'task_market')),
    expected_version INTEGER NOT NULL
        CHECK (typeof(expected_version) = 'integer' AND expected_version BETWEEN 1 AND 2147483645),
    claim_id TEXT NOT NULL UNIQUE
        CHECK (
            length(claim_id) BETWEEN 14 AND 107 AND
            substr(claim_id, 1, 11) = 'turn-claim:' AND
            substr(claim_id, 12, 1) GLOB '[a-z0-9]' AND
            claim_id NOT GLOB '*[^a-z0-9._:-]*'
        ),
    claimed_at TEXT NOT NULL CHECK (unixepoch(claimed_at) IS NOT NULL),
    expires_at TEXT NOT NULL
        CHECK (unixepoch(expires_at) IS NOT NULL AND expires_at > claimed_at),
    PRIMARY KEY (conversation_id, expected_version),
    FOREIGN KEY (conversation_id, conversation_agent_id, trust_domain)
        REFERENCES agent_conversations(id, agent_id, trust_domain)
);

CREATE INDEX IF NOT EXISTS idx_agent_conversation_turn_claims_expiry
    ON agent_conversation_turn_claims (expires_at, conversation_id, expected_version);

CREATE TRIGGER IF NOT EXISTS agent_conversation_turn_claims_canonical_insert
BEFORE INSERT ON agent_conversation_turn_claims
WHEN
    NEW.conversation_id GLOB '*[._:-][._:-]*' OR
    substr(NEW.conversation_id, -1, 1) GLOB '[._:-]' OR
    NEW.conversation_agent_id GLOB '*[._:-][._:-]*' OR
    substr(NEW.conversation_agent_id, -1, 1) GLOB '[._:-]' OR
    NEW.claim_id GLOB '*[._:-][._:-]*' OR
    substr(NEW.claim_id, -1, 1) GLOB '[._:-]'
BEGIN
    SELECT RAISE(ABORT, 'agent conversation turn claim canonical contract failed');
END;

CREATE TRIGGER IF NOT EXISTS agent_conversation_turn_claims_canonical_update
BEFORE UPDATE ON agent_conversation_turn_claims
WHEN
    OLD.conversation_id IS NOT NEW.conversation_id OR
    OLD.conversation_agent_id IS NOT NEW.conversation_agent_id OR
    OLD.trust_domain IS NOT NEW.trust_domain OR
    OLD.expected_version IS NOT NEW.expected_version OR
    NEW.claimed_at <= OLD.claimed_at OR
    NEW.expires_at <= NEW.claimed_at OR
    NEW.claim_id = OLD.claim_id
BEGIN
    SELECT RAISE(ABORT, 'agent conversation turn claim replacement contract failed');
END;
