CREATE TABLE IF NOT EXISTS revenue_prospects (
    id TEXT PRIMARY KEY
        CHECK (
            length(id) BETWEEN 3 AND 64 AND
            substr(id, 1, 1) GLOB '[a-z]' AND
            id NOT GLOB '*[^a-z0-9_-]*'
        ),
    lane TEXT NOT NULL CHECK (lane IN ('agency', 'task_market')),
    public_label TEXT NOT NULL
        CHECK (length(public_label) BETWEEN 1 AND 120 AND trim(public_label) = public_label),
    contact_channel TEXT NOT NULL
        CHECK (contact_channel IN ('email', 'linkedin', 'referral', 'marketplace', 'other')),
    contact_reference TEXT
        CHECK (
            contact_reference IS NULL OR (
                length(contact_reference) BETWEEN 11 AND 104 AND
                substr(contact_reference, 1, 8) = 'contact:' AND
                contact_reference NOT GLOB '*[^a-z0-9._:-]*' AND
                instr(contact_reference, '@') = 0
            )
        ),
    source TEXT NOT NULL
        CHECK (source IN ('operator_research', 'referral', 'public_directory', 'github')),
    need TEXT NOT NULL
        CHECK (need IN ('agency_automation_audit', 'agency_workflow_pilot', 'task_validation_api')),
    status TEXT NOT NULL CHECK (status IN ('identified', 'qualified', 'paused', 'archived')),
    version INTEGER NOT NULL CHECK (version >= 1),
    created_at TEXT NOT NULL CHECK (unixepoch(created_at) IS NOT NULL),
    updated_at TEXT NOT NULL CHECK (unixepoch(updated_at) IS NOT NULL),
    UNIQUE (id, lane),
    CHECK (
        (lane = 'agency' AND need IN ('agency_automation_audit', 'agency_workflow_pilot')) OR
        (lane = 'task_market' AND need = 'task_validation_api')
    )
);

CREATE TABLE IF NOT EXISTS revenue_offers (
    id TEXT PRIMARY KEY
        CHECK (
            length(id) BETWEEN 3 AND 64 AND
            substr(id, 1, 1) GLOB '[a-z]' AND
            id NOT GLOB '*[^a-z0-9_-]*'
        ),
    prospect_id TEXT NOT NULL,
    lane TEXT NOT NULL CHECK (lane IN ('agency', 'task_market')),
    title TEXT NOT NULL
        CHECK (length(title) BETWEEN 1 AND 120 AND trim(title) = title),
    deliverable TEXT NOT NULL
        CHECK (deliverable IN ('automation_audit', 'workflow_pilot', 'edge_validation_v1')),
    proposed_amount_microusd INTEGER NOT NULL
        CHECK (proposed_amount_microusd BETWEEN 1 AND 1000000000000),
    currency TEXT NOT NULL CHECK (currency = 'USD'),
    turnaround_hours INTEGER NOT NULL CHECK (turnaround_hours BETWEEN 1 AND 2160),
    revision_limit INTEGER NOT NULL CHECK (revision_limit BETWEEN 0 AND 10),
    status TEXT NOT NULL CHECK (status IN ('draft', 'review_ready', 'reviewed', 'archived')),
    version INTEGER NOT NULL CHECK (version >= 1),
    created_at TEXT NOT NULL CHECK (unixepoch(created_at) IS NOT NULL),
    updated_at TEXT NOT NULL CHECK (unixepoch(updated_at) IS NOT NULL),
    UNIQUE (id, prospect_id, lane),
    CHECK (
        (lane = 'agency' AND deliverable IN ('automation_audit', 'workflow_pilot')) OR
        (lane = 'task_market' AND deliverable = 'edge_validation_v1')
    ),
    FOREIGN KEY (prospect_id, lane) REFERENCES revenue_prospects(id, lane)
);

CREATE TABLE IF NOT EXISTS revenue_outreach_drafts (
    id TEXT PRIMARY KEY
        CHECK (
            length(id) BETWEEN 3 AND 64 AND
            substr(id, 1, 1) GLOB '[a-z]' AND
            id NOT GLOB '*[^a-z0-9_-]*'
        ),
    prospect_id TEXT NOT NULL,
    offer_id TEXT NOT NULL,
    lane TEXT NOT NULL CHECK (lane IN ('agency', 'task_market')),
    channel TEXT NOT NULL
        CHECK (channel IN ('email', 'linkedin', 'referral', 'marketplace', 'other')),
    subject TEXT NOT NULL
        CHECK (length(subject) BETWEEN 1 AND 160 AND trim(subject) = subject),
    body TEXT NOT NULL
        CHECK (length(body) BETWEEN 1 AND 8000 AND trim(body) = body),
    content_sha256 TEXT NOT NULL
        CHECK (length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^a-f0-9]*'),
    status TEXT NOT NULL CHECK (status IN ('draft', 'review_ready', 'reviewed', 'archived')),
    version INTEGER NOT NULL CHECK (version >= 1),
    created_at TEXT NOT NULL CHECK (unixepoch(created_at) IS NOT NULL),
    updated_at TEXT NOT NULL CHECK (unixepoch(updated_at) IS NOT NULL),
    UNIQUE (id, prospect_id, offer_id, lane),
    FOREIGN KEY (prospect_id, lane) REFERENCES revenue_prospects(id, lane),
    FOREIGN KEY (offer_id, prospect_id, lane) REFERENCES revenue_offers(id, prospect_id, lane)
);

CREATE TABLE IF NOT EXISTS task_market_activation (
    id TEXT PRIMARY KEY CHECK (id = 'task_market'),
    product_id TEXT NOT NULL
        CHECK (
            length(product_id) BETWEEN 3 AND 64 AND
            substr(product_id, 1, 1) GLOB '[a-z]' AND
            product_id NOT GLOB '*[^a-z0-9-]*'
        ),
    a2a_version TEXT NOT NULL CHECK (length(a2a_version) BETWEEN 5 AND 24),
    a2a_skill_id TEXT NOT NULL
        CHECK (
            length(a2a_skill_id) BETWEEN 3 AND 64 AND
            substr(a2a_skill_id, 1, 1) GLOB '[a-z]' AND
            a2a_skill_id NOT GLOB '*[^a-z0-9_-]*'
        ),
    input_contract TEXT NOT NULL CHECK (input_contract = 'bounded_numeric_series'),
    output_contract TEXT NOT NULL CHECK (output_contract = 'validation_verdict'),
    contract_sha256 TEXT NOT NULL
        CHECK (length(contract_sha256) = 64 AND contract_sha256 NOT GLOB '*[^a-f0-9]*'),
    x402_scheme TEXT NOT NULL CHECK (x402_scheme = 'exact'),
    quoted_amount_microusd INTEGER NOT NULL
        CHECK (quoted_amount_microusd BETWEEN 1 AND 1000000000000),
    currency TEXT NOT NULL CHECK (currency = 'USD'),
    activation_state TEXT NOT NULL CHECK (activation_state IN ('contract_only', 'simulation')),
    network_mode TEXT NOT NULL CHECK (network_mode = 'none'),
    payment_mode TEXT NOT NULL CHECK (payment_mode IN ('blocked', 'simulated')),
    wallet_mode TEXT NOT NULL CHECK (wallet_mode = 'forbidden'),
    version INTEGER NOT NULL CHECK (version >= 1),
    created_at TEXT NOT NULL CHECK (unixepoch(created_at) IS NOT NULL),
    updated_at TEXT NOT NULL CHECK (unixepoch(updated_at) IS NOT NULL),
    UNIQUE (id, version),
    CHECK (
        (activation_state = 'contract_only' AND payment_mode = 'blocked') OR
        (activation_state = 'simulation' AND payment_mode = 'simulated')
    )
);

CREATE TABLE IF NOT EXISTS task_market_simulations (
    id TEXT PRIMARY KEY
        CHECK (
            length(id) BETWEEN 3 AND 64 AND
            substr(id, 1, 1) GLOB '[a-z]' AND
            id NOT GLOB '*[^a-z0-9_-]*'
        ),
    activation_id TEXT NOT NULL CHECK (activation_id = 'task_market'),
    activation_version INTEGER NOT NULL CHECK (activation_version >= 1),
    scenario TEXT NOT NULL
        CHECK (scenario IN ('authorization_accepted', 'authorization_rejected', 'duplicate_replay')),
    outcome TEXT NOT NULL CHECK (outcome IN ('pass', 'fail')),
    request_sha256 TEXT NOT NULL
        CHECK (length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^a-f0-9]*'),
    evidence_sha256 TEXT NOT NULL
        CHECK (length(evidence_sha256) = 64 AND evidence_sha256 NOT GLOB '*[^a-f0-9]*'),
    quoted_amount_microusd INTEGER NOT NULL
        CHECK (quoted_amount_microusd BETWEEN 1 AND 1000000000000),
    currency TEXT NOT NULL CHECK (currency = 'USD'),
    simulation_only INTEGER NOT NULL CHECK (simulation_only = 1),
    recorded_at TEXT NOT NULL CHECK (unixepoch(recorded_at) IS NOT NULL),
    FOREIGN KEY (activation_id) REFERENCES task_market_activation(id)
);

CREATE TABLE IF NOT EXISTS revenue_pipeline_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    lane TEXT NOT NULL CHECK (lane IN ('agency', 'task_market')),
    entity_type TEXT NOT NULL CHECK (entity_type IN (
        'prospect', 'offer', 'outreach_draft', 'task_market_activation', 'task_market_simulation'
    )),
    entity_id TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK (event_type IN ('created', 'status_changed', 'simulation_recorded')),
    from_status TEXT,
    to_status TEXT NOT NULL,
    entity_version INTEGER NOT NULL CHECK (entity_version >= 1),
    actor_id TEXT NOT NULL CHECK (length(actor_id) BETWEEN 3 AND 128),
    detail_json TEXT NOT NULL CHECK (json_valid(detail_json)),
    occurred_at TEXT NOT NULL CHECK (unixepoch(occurred_at) IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_revenue_prospects_lane_status
    ON revenue_prospects (lane, status, updated_at DESC, id);
CREATE INDEX IF NOT EXISTS idx_revenue_offers_lane_status
    ON revenue_offers (lane, status, updated_at DESC, id);
CREATE INDEX IF NOT EXISTS idx_revenue_drafts_lane_status
    ON revenue_outreach_drafts (lane, status, updated_at DESC, id);
CREATE INDEX IF NOT EXISTS idx_revenue_events_lane_sequence
    ON revenue_pipeline_events (lane, sequence DESC);
CREATE INDEX IF NOT EXISTS idx_task_market_simulations_recorded
    ON task_market_simulations (recorded_at DESC, id);

CREATE TRIGGER IF NOT EXISTS revenue_prospect_contract_immutable
BEFORE UPDATE ON revenue_prospects
WHEN
    OLD.id IS NOT NEW.id OR
    OLD.lane IS NOT NEW.lane OR
    OLD.public_label IS NOT NEW.public_label OR
    OLD.contact_channel IS NOT NEW.contact_channel OR
    OLD.contact_reference IS NOT NEW.contact_reference OR
    OLD.source IS NOT NEW.source OR
    OLD.need IS NOT NEW.need OR
    OLD.created_at IS NOT NEW.created_at
BEGIN
    SELECT RAISE(ABORT, 'revenue prospect contract is immutable');
END;

CREATE TRIGGER IF NOT EXISTS revenue_prospect_status_transition
BEFORE UPDATE ON revenue_prospects
WHEN
    NEW.version <> OLD.version + 1 OR
    NOT (
        (OLD.status = 'identified' AND NEW.status IN ('qualified', 'paused', 'archived')) OR
        (OLD.status = 'qualified' AND NEW.status IN ('paused', 'archived')) OR
        (OLD.status = 'paused' AND NEW.status IN ('identified', 'qualified', 'archived'))
    )
BEGIN
    SELECT RAISE(ABORT, 'invalid revenue prospect status transition');
END;

CREATE TRIGGER IF NOT EXISTS revenue_offer_requires_qualified_prospect
BEFORE INSERT ON revenue_offers
WHEN NOT EXISTS (
    SELECT 1 FROM revenue_prospects
    WHERE id = NEW.prospect_id AND lane = NEW.lane AND status = 'qualified'
)
BEGIN
    SELECT RAISE(ABORT, 'revenue offer requires a qualified prospect in the same lane');
END;

CREATE TRIGGER IF NOT EXISTS revenue_offer_contract_immutable
BEFORE UPDATE ON revenue_offers
WHEN
    OLD.id IS NOT NEW.id OR
    OLD.prospect_id IS NOT NEW.prospect_id OR
    OLD.lane IS NOT NEW.lane OR
    OLD.title IS NOT NEW.title OR
    OLD.deliverable IS NOT NEW.deliverable OR
    OLD.proposed_amount_microusd IS NOT NEW.proposed_amount_microusd OR
    OLD.currency IS NOT NEW.currency OR
    OLD.turnaround_hours IS NOT NEW.turnaround_hours OR
    OLD.revision_limit IS NOT NEW.revision_limit OR
    OLD.created_at IS NOT NEW.created_at
BEGIN
    SELECT RAISE(ABORT, 'revenue offer contract is immutable');
END;

CREATE TRIGGER IF NOT EXISTS revenue_offer_status_transition
BEFORE UPDATE ON revenue_offers
WHEN
    NEW.version <> OLD.version + 1 OR
    NOT (
        (OLD.status = 'draft' AND NEW.status IN ('review_ready', 'archived')) OR
        (OLD.status = 'review_ready' AND NEW.status IN ('draft', 'reviewed', 'archived')) OR
        (OLD.status = 'reviewed' AND NEW.status = 'archived')
    )
BEGIN
    SELECT RAISE(ABORT, 'invalid revenue offer status transition');
END;

CREATE TRIGGER IF NOT EXISTS revenue_draft_requires_reviewed_offer
BEFORE INSERT ON revenue_outreach_drafts
WHEN NOT EXISTS (
    SELECT 1
    FROM revenue_offers AS offer
    JOIN revenue_prospects AS prospect
      ON prospect.id = offer.prospect_id AND prospect.lane = offer.lane
    WHERE offer.id = NEW.offer_id
      AND offer.prospect_id = NEW.prospect_id
      AND offer.lane = NEW.lane
      AND offer.status = 'reviewed'
      AND prospect.contact_channel = NEW.channel
)
BEGIN
    SELECT RAISE(ABORT, 'outreach draft requires a reviewed same-lane offer and matching channel');
END;

CREATE TRIGGER IF NOT EXISTS revenue_draft_contract_immutable
BEFORE UPDATE ON revenue_outreach_drafts
WHEN
    OLD.id IS NOT NEW.id OR
    OLD.prospect_id IS NOT NEW.prospect_id OR
    OLD.offer_id IS NOT NEW.offer_id OR
    OLD.lane IS NOT NEW.lane OR
    OLD.channel IS NOT NEW.channel OR
    OLD.subject IS NOT NEW.subject OR
    OLD.body IS NOT NEW.body OR
    OLD.content_sha256 IS NOT NEW.content_sha256 OR
    OLD.created_at IS NOT NEW.created_at
BEGIN
    SELECT RAISE(ABORT, 'revenue outreach draft contract is immutable');
END;

CREATE TRIGGER IF NOT EXISTS revenue_draft_status_transition
BEFORE UPDATE ON revenue_outreach_drafts
WHEN
    NEW.version <> OLD.version + 1 OR
    NOT (
        (OLD.status = 'draft' AND NEW.status IN ('review_ready', 'archived')) OR
        (OLD.status = 'review_ready' AND NEW.status IN ('draft', 'reviewed', 'archived')) OR
        (OLD.status = 'reviewed' AND NEW.status = 'archived')
    )
BEGIN
    SELECT RAISE(ABORT, 'invalid revenue outreach draft status transition');
END;

CREATE TRIGGER IF NOT EXISTS task_market_activation_contract_immutable
BEFORE UPDATE ON task_market_activation
WHEN
    OLD.id IS NOT NEW.id OR
    OLD.product_id IS NOT NEW.product_id OR
    OLD.a2a_version IS NOT NEW.a2a_version OR
    OLD.a2a_skill_id IS NOT NEW.a2a_skill_id OR
    OLD.input_contract IS NOT NEW.input_contract OR
    OLD.output_contract IS NOT NEW.output_contract OR
    OLD.contract_sha256 IS NOT NEW.contract_sha256 OR
    OLD.x402_scheme IS NOT NEW.x402_scheme OR
    OLD.quoted_amount_microusd IS NOT NEW.quoted_amount_microusd OR
    OLD.currency IS NOT NEW.currency OR
    OLD.network_mode IS NOT NEW.network_mode OR
    OLD.wallet_mode IS NOT NEW.wallet_mode OR
    OLD.created_at IS NOT NEW.created_at
BEGIN
    SELECT RAISE(ABORT, 'task-market contract is immutable');
END;

CREATE TRIGGER IF NOT EXISTS task_market_activation_transition
BEFORE UPDATE ON task_market_activation
WHEN NOT (
    OLD.activation_state = 'contract_only' AND
    NEW.activation_state = 'simulation' AND
    OLD.payment_mode = 'blocked' AND
    NEW.payment_mode = 'simulated' AND
    NEW.version = OLD.version + 1
)
BEGIN
    SELECT RAISE(ABORT, 'task-market activation is limited to contract-only then simulation');
END;

CREATE TRIGGER IF NOT EXISTS task_market_simulation_gate
BEFORE INSERT ON task_market_simulations
WHEN NOT EXISTS (
    SELECT 1 FROM task_market_activation
    WHERE id = NEW.activation_id
      AND activation_state = 'simulation'
      AND payment_mode = 'simulated'
      AND network_mode = 'none'
      AND wallet_mode = 'forbidden'
      AND version = NEW.activation_version
      AND quoted_amount_microusd = NEW.quoted_amount_microusd
      AND currency = NEW.currency
)
BEGIN
    SELECT RAISE(ABORT, 'simulation evidence requires matching simulation activation');
END;

CREATE TRIGGER IF NOT EXISTS task_market_simulations_no_update
BEFORE UPDATE ON task_market_simulations
BEGIN
    SELECT RAISE(ABORT, 'task_market_simulations is append-only');
END;

CREATE TRIGGER IF NOT EXISTS task_market_simulations_no_delete
BEFORE DELETE ON task_market_simulations
BEGIN
    SELECT RAISE(ABORT, 'task_market_simulations is append-only');
END;

CREATE TRIGGER IF NOT EXISTS revenue_pipeline_events_no_update
BEFORE UPDATE ON revenue_pipeline_events
BEGIN
    SELECT RAISE(ABORT, 'revenue_pipeline_events is append-only');
END;

CREATE TRIGGER IF NOT EXISTS revenue_pipeline_events_no_delete
BEFORE DELETE ON revenue_pipeline_events
BEGIN
    SELECT RAISE(ABORT, 'revenue_pipeline_events is append-only');
END;
