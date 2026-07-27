# Operator page workflow

Use this lane for dashboard pages, views, widgets, navigation, dictation, or Page Studio changes.

## Inspect

Read only the relevant slices of:

- `src/dashboard/contracts.ts` for the declarative allowlist and request schemas.
- `src/dashboard/page-planner.ts` for request-to-capability mapping.
- `src/dashboard/page-service.ts` for preview, confirmation, and canonical replanning.
- `src/dashboard/dashboard-service.ts` and repository summaries for safe read models.
- `src/dashboard/routes.ts`, `src/gateway/app.ts`, and `src/gateway/server.ts` for delivery.
- `public/dashboard/` for rendering and dictation.
- `src/memory/markdown-graph.ts` for durable page manifests.

## Choose a lane

- If every requested capability already has an allowlisted widget and safe read model, extend the deterministic mapping and declarative renderer.
- If any requested capability is missing, implement and test the bounded read model first. Do not publish a partial page or generate runtime HTML/JavaScript from the request.
- Keep planning token-free unless the user explicitly authorizes a model-backed planner. Unknown requirements must route to repository work.

## Preserve invariants

- Accept only strict request text plus a server-issued fingerprint and explicit confirmation.
- Re-plan on the server immediately before publication.
- Render with DOM text APIs; never interpolate untrusted HTML.
- Keep page creation loopback-only until authentication and authorization exist.
- Treat speech recognition as optional. Never auto-submit, auto-create, or store audio; keep typed input available and disclose browser recognition privacy.
- Journal Markdown page publication so the page note, indexes, and `graph.json` recover as one logical change.

## Verify

Cover planner mappings and gaps, stale fingerprints, confirmation, route validation, Markdown recovery, safe rendering, browser console, keyboard labels, and a 390px viewport without document overflow.
