CREATE TABLE IF NOT EXISTS provider_rate_limit_circuits (
  provider TEXT PRIMARY KEY
    CHECK (provider IN ('claude', 'codex', 'gemini')),
  state TEXT NOT NULL
    CHECK (state IN ('open', 'half_open')),
  detected_at INTEGER NOT NULL
    CHECK (typeof(detected_at) = 'integer' AND detected_at >= 0),
  reset_at INTEGER
    CHECK (
      reset_at IS NULL OR
      (typeof(reset_at) = 'integer' AND reset_at > detected_at)
    ),
  not_before INTEGER NOT NULL
    CHECK (typeof(not_before) = 'integer' AND not_before >= detected_at),
  last_checked_at INTEGER NOT NULL
    CHECK (typeof(last_checked_at) = 'integer' AND last_checked_at >= detected_at),
  claim_expires_at INTEGER
    CHECK (
      claim_expires_at IS NULL OR
      (
        typeof(claim_expires_at) = 'integer' AND
        claim_expires_at >= last_checked_at AND
        claim_expires_at <= 9007199254740991
      )
    ),
  CHECK (
    (state = 'open' AND claim_expires_at IS NULL) OR
    (state = 'half_open' AND claim_expires_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_provider_rate_limit_circuits_due
  ON provider_rate_limit_circuits (state, not_before, claim_expires_at, provider);
