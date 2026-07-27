CREATE TABLE IF NOT EXISTS model_usage_events (
    id TEXT PRIMARY KEY
        CHECK (length(id) BETWEEN 3 AND 128),
    recorded_at TEXT NOT NULL
        CHECK (length(recorded_at) BETWEEN 20 AND 40),
    client_id TEXT,
    operation TEXT NOT NULL
        CHECK (operation IN (
            'classification', 'extraction', 'drafting', 'summarization',
            'synthesis', 'code', 'review'
        )),
    provider TEXT NOT NULL
        CHECK (length(provider) BETWEEN 1 AND 32),
    model TEXT NOT NULL
        CHECK (length(model) BETWEEN 1 AND 96),
    route TEXT NOT NULL
        CHECK (route IN ('local', 'economy', 'frontier')),
    input_tokens INTEGER
        CHECK (
            input_tokens IS NULL OR
            (typeof(input_tokens) = 'integer' AND input_tokens BETWEEN 0 AND 2147483647)
        ),
    output_tokens INTEGER
        CHECK (
            output_tokens IS NULL OR
            (typeof(output_tokens) = 'integer' AND output_tokens BETWEEN 0 AND 2147483647)
        ),
    cache_read_tokens INTEGER
        CHECK (
            cache_read_tokens IS NULL OR
            (typeof(cache_read_tokens) = 'integer' AND cache_read_tokens BETWEEN 0 AND 2147483647)
        ),
    cache_write_tokens INTEGER
        CHECK (
            cache_write_tokens IS NULL OR
            (typeof(cache_write_tokens) = 'integer' AND cache_write_tokens BETWEEN 0 AND 2147483647)
        ),
    latency_ms INTEGER NOT NULL
        CHECK (typeof(latency_ms) = 'integer' AND latency_ms BETWEEN 0 AND 86400000),
    status TEXT NOT NULL
        CHECK (status IN ('succeeded', 'failed', 'timeout', 'cancelled')),
    cost_basis TEXT NOT NULL
        CHECK (cost_basis IN ('observed', 'estimated', 'unknown', 'subscription', 'local')),
    cost_microusd INTEGER
        CHECK (
            cost_microusd IS NULL OR
            (typeof(cost_microusd) = 'integer' AND cost_microusd BETWEEN 0 AND 1000000000000)
        ),
    pricing_version TEXT
        CHECK (pricing_version IS NULL OR length(pricing_version) BETWEEN 1 AND 64),
    CHECK (
        (cost_basis = 'unknown' AND cost_microusd IS NULL AND pricing_version IS NULL) OR
        (cost_basis = 'subscription' AND cost_microusd IS NULL AND pricing_version IS NULL) OR
        (cost_basis = 'local' AND cost_microusd = 0 AND pricing_version IS NULL) OR
        (cost_basis = 'observed' AND cost_microusd IS NOT NULL) OR
        (
            cost_basis = 'estimated' AND
            cost_microusd IS NOT NULL AND
            pricing_version IS NOT NULL
        )
    ),
    FOREIGN KEY (client_id) REFERENCES client_registry(id)
);

CREATE INDEX IF NOT EXISTS idx_model_usage_recorded
    ON model_usage_events (recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_model_usage_client_recorded
    ON model_usage_events (client_id, recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_model_usage_provider_route
    ON model_usage_events (provider, model, route, recorded_at DESC);
