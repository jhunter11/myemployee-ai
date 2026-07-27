---
name: jarvis-page-builder
description: Inspect, map, create, add, build, revise, or validate a verified Jarvis dashboard page from an operator request and the repository's bounded read models. Use when a user asks for a Jarvis dashboard page, view, widget, dictation flow, navigation change, or Page Studio workflow.
---

# Jarvis Page Builder

Turn a page request into either a verified declarative Page Studio publication or a tested repository implementation. Keep every page useful, bounded, and tenant-safe.

## Orient

1. Confirm the repository root and inspect the worktree without disturbing unrelated changes.
2. Read [references/page-contract.md](references/page-contract.md).
3. Inspect the request, current code, and bounded read models. Read the relevant dashboard contracts, planner, service, routes, browser files, and tests before deciding that a capability exists.
4. Produce a compact mapping of each requested capability to its existing read model, endpoint, supported widgets, implementation files, and capability gaps.
5. Preserve the queue as its own default page at `/dashboard?view=queue`. A generated page may reuse an allowlisted queue widget, but must not replace, hide, or absorb the default queue page.

Do not infer support from visual similarity. A widget is supported only when its validated DTO, same-origin route, renderer, and focused tests all exist.

## Choose the implementation lane

Use the declarative Page Studio lane only when every requested capability maps to the current allowlist and the preview reports `ready: true` with no gaps:

1. Preview the exact operator request through `POST /api/v1/dashboard/page-plans`.
2. Review the canonical mapping, checks, gaps, and fingerprint returned by the server.
3. Obtain explicit human confirmation for that preview.
4. Publish with only the original request, returned fingerprint, and `confirmed: true`. Let the server re-plan; never forge a slug, widget, source, manifest, or fingerprint.
5. Reload the published page and verify every requested capability.

Use a TDD repository implementation when any requested capability lacks a bounded read model, route, widget, interaction, or test:

1. Do not publish a partial page.
2. Write a failing contract, service, route, or browser test for the missing behavior.
3. Add the smallest fixed DTO, server-side scope, same-origin endpoint, renderer, and interaction needed to make it supported.
4. Add the capability to Page Studio only after the complete path is validated.
5. Re-preview and publish only when the planner reports no gaps.

## Enforce the page boundary

- Expose only fixed same-origin bounded DTOs; never proxy arbitrary URLs, files, SQL, graph selectors, or model output to the browser.
- Keep loopback-only mutations, explicit confirmation, server-side re-planning, strict schemas, and safe DOM text rendering.
- Bind a scoped page to the exact registered client or project scope on the server. Never accept a request-controlled tenant, client, project, path, database, or graph scope.
- Keep client and project agents inside their registered sandbox. Exclude tenant-private data, secrets, raw payloads, contact references, draft bodies, leases, and unrestricted graph content from dashboard responses.
- Treat dictation as local request input: require a visible start/stop state, never auto-submit, and never persist audio. Keep typed input as the fallback.
- Never auto-send, pay, deploy, activate mainnet, open remote access, or perform another external side effect from page creation.

If a request conflicts with these boundaries, mark it as a capability gap and implement a safe server-side abstraction or stop. Do not weaken the boundary.

## Verify before completion

1. Run the focused contract/service/route/browser tests while iterating, then typecheck, lint, and the repository release gate when practical.
2. Start the real dashboard and browser-verify desktop and mobile layouts. Check the requested page, the default queue page, navigation, reload/back behavior, keyboard operation, labels, loading, empty, and error states.
3. At desktop and mobile widths, inspect console errors, failed network calls, clipped controls, horizontal document overflow, and unreadable density. Test at least one narrow phone viewport such as 390x844.
4. Confirm every request stays same-origin, no browser-controlled scope appears in a query or body, and every mutation remains local and confirmed.
5. Report the request-to-code mapping, gaps resolved, files changed, tests run, browser evidence, and any remaining limitation. Do not claim the page works from tests alone.
