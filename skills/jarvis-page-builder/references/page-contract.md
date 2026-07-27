# Jarvis page contract

Use this reference as a fast index, then inspect the named source files before changing behavior. The code and tests remain authoritative.

## Declarative widgets

Page Studio maps operator language through `src/dashboard/page-planner.ts`. Published specs are data-only and validated by `src/dashboard/contracts.ts`.

| Widget             | Same-origin source           | Existing bounded capability                                   |
| ------------------ | ---------------------------- | ------------------------------------------------------------- |
| `health`           | `/api/v1/dashboard/overview` | Process health and status                                     |
| `clients`          | `/api/v1/dashboard/overview` | Bounded registered-client summary                             |
| `recent-runs`      | `/api/v1/dashboard/overview` | Bounded automation-run summary                                |
| `attention`        | `/api/v1/dashboard/overview` | Bounded audit/attention summary                               |
| `toolsmith`        | `/api/v1/dashboard/overview` | Proposal-only improvements                                    |
| `memory-graph`     | `/api/v1/dashboard/graph`    | Sanitized Markdown graph index                                |
| `model-economics`  | `/api/v1/dashboard/overview` | Bounded model usage and routing economics                     |
| `work-queue`       | `/api/v1/dashboard/queue`    | Redacted queue snapshot for the server-configured tenant      |
| `revenue-pipeline` | `/api/v1/dashboard/revenue`  | Redacted snapshots for the fixed agency and task-market lanes |

The current published page schema allows at most seven widgets per page. Treat a request that cannot fit the validated schema as a gap; do not silently omit widgets.

## Fixed views and endpoints

- `/dashboard?view=queue` is the queue's own default operator page. Keep it independently navigable even when a generated page includes `work-queue`.
- `GET /api/v1/dashboard/overview`, `GET /api/v1/dashboard/queue`, `GET /api/v1/dashboard/revenue`, `GET /api/v1/dashboard/graph`, and `GET /api/v1/dashboard/pages` accept no browser-selected tenant or project scope.
- `POST /api/v1/dashboard/page-plans` accepts only a bounded request string and returns the canonical mapping, gaps, checks, and fingerprint.
- `POST /api/v1/dashboard/pages` accepts only the original request, the expected fingerprint, and literal confirmation. It is a loopback-only mutation; the server recomputes the plan before publication.

The queue tenant is fixed during server composition. Revenue returns only the two fixed lanes. A request for an arbitrary client, project, tenant, path, database, or graph is unsupported until repository code binds an exact registered scope on the server and proves isolation with tests.

## Source-of-truth files

- `src/dashboard/contracts.ts`: strict page, widget, plan, and publication schemas.
- `src/dashboard/page-planner.ts`: deterministic keyword-to-capability catalog and gap detection.
- `src/dashboard/page-service.ts`: canonical re-plan, fingerprint check, and publication policy.
- `src/dashboard/dashboard-service.ts`: fixed, bounded, redacted dashboard DTO construction.
- `src/dashboard/routes.ts`: same-origin reads and loopback publication route.
- `src/gateway/server.ts`: concrete repositories and server-fixed tenant composition.
- `public/dashboard/index.html` and `public/dashboard/assets/app.js`: navigation, Page Studio, dictation, and widget rendering.
- `tests/dashboard/` and `tests/gateway/`: contract, route, composition, and browser-shell coverage.

## Gap decision

Choose declarative publication only when the planner returns a non-empty mapping, no gaps, `ready: true`, and `recommendedWorkflow: "declarative_page"`. Choose repository TDD for every other result, including a missing interaction, an unregistered scope, or a renderer that does not consume the mapped DTO. Never publish a partial substitute.
