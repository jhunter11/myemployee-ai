# Token and model economics workflow

Use this lane for token usage, model selection, context compression, caching, latency, budgets, or work-per-dollar optimization.

## Measure first

1. Identify the exact operation and whether it needs a model at all.
2. Capture provider, model, route reason, input/output/cache tokens, latency, status, and an explicit pricing-version identifier.
3. Separate observed usage from estimated cost. Do not invent missing prices or silently treat unknown usage as zero.
4. Keep tenant identifiers and prompts out of global telemetry; store bounded metadata only.

## Route by value

- Tier 0: deterministic schemas, rules, indexes, SQL, and local validation. Cost is zero model tokens.
- Tier 1: the cheapest capable local or small model for classification, extraction, and drafts with machine-checkable outputs.
- Tier 2: a stronger model for ambiguous planning, synthesis, or code changes.
- Tier 3: the strongest model only for high-risk or repeatedly failed work, with an explicit reason.

Prefer one strong call over repeated weak retries when the task is intrinsically hard. Prefer a small model when validation can cheaply catch errors.

## Reduce context

- Retrieve only relevant files and source slices; deduplicate stable instructions.
- Cache stable system context and deterministic results by content hash.
- Summarize completed phases into durable Markdown with provenance, then start later work from the summary plus changed files.
- Cap tool output, history, proposals, and retries. Stop retry loops on deterministic validation failures.
- Batch independent lookups and parallelize bounded work where it reduces wall time without duplicating model context.

## Verify economics

Test route selection, hard budget caps, missing usage/pricing, cached usage, fallback, timeout, redaction, and aggregation. Report work completed, quality evidence, latency, and cost together; the cheapest failed run is not efficient.
