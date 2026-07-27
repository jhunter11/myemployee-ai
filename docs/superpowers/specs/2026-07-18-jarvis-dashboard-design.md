# Jarvis Operator Dashboard Design

Date: 2026-07-18

## Goal

Add a useful, calm operator surface to the existing loopback-first Jarvis gateway. The dashboard must expose honest operational data, make the Obsidian-compatible Markdown graph browsable without an IDE, accept typed or dictated page requests, and publish only reviewed declarative pages. Requests that need executable code must be routed to a repository skill instead of editing source from an HTTP request.

## Product Shape

The dashboard is a dependency-free same-origin web application served at `/dashboard`:

- Overview: health, current-process request metrics, client counts, run counts, recent safe run summaries, unresolved attention, and ToolSmith proposals.
- Clients: bounded client cards with profile/status, without tenant-private memory.
- Runs: bounded summaries without input, output, or raw error payloads.
- Memory: validated global `graph.json`, searchable nodes, and neighbor relationships. Private notes under `clients/<id>/memory/notes` are never served.
- Improvements: proposal-only ToolSmith candidates.
- Pages: saved declarative operator pages and a request composer with an explicit preview-then-create flow.

Every panel has loading, empty, degraded, error, and refreshed states. Navigation is keyboard-operable, focus is visible, status never relies on color alone, announcements use `aria-live`, and reduced-motion/mobile layouts remain usable.

## Read Model

`DashboardService` composes narrow ports rather than exposing tables or files directly:

- `ClientRepository.list()`
- bounded `RunRepository.dashboardSummary(limit)`
- bounded `AuditRepository.dashboardSummary(limit)`
- `RequestMetrics.snapshot()` (labeled current process)
- `HealthProvider.check()`
- bounded `ToolSmith.analyze()`
- validated `MarkdownGraph.readIndex()` and `listOperatorPages()`

The overview DTO excludes run input/output/errors, audit descriptions/actions, tenant-private notes, revenue, and token cost until those values have real writers and authorization boundaries.

## Page Studio

The flow is deliberately two-step:

```text
typed or dictated request
  -> deterministic capability catalog
  -> preview with mapping, gaps, checks, slug, widgets, fingerprint
  -> explicit human confirmation
  -> canonical re-plan and fingerprint check
  -> atomic Markdown page publication + graph rebuild
```

The planner is Tier 0 deterministic work: it consumes no model tokens. It maps fixed keywords to allowlisted widgets and same-origin data sources:

| Capability              | Widget         | Source                 |
| ----------------------- | -------------- | ---------------------- |
| health/status           | `health`       | dashboard overview     |
| clients                 | `clients`      | dashboard overview     |
| runs/automations        | `recent-runs`  | dashboard overview     |
| audits/errors/attention | `attention`    | dashboard overview     |
| improvements/ToolSmith  | `toolsmith`    | dashboard overview     |
| memory/graph            | `memory-graph` | validated global graph |

Unknown or partly unsupported requirements produce a gap and `recommendedWorkflow: "repository_skill"`; partial pages cannot be published silently. The create request contains only the original request and expected SHA-256 plan fingerprint. The server re-plans rather than trusting browser-supplied titles, slugs, widgets, paths, HTML, or endpoints.

Published pages are ordinary Markdown notes under `memory/graph/pages/`, linked from `pages/index.md` and the global index. A validated JSON manifest is stored in frontmatter so Obsidian and the dashboard share one canonical artifact. Equal retries are idempotent; a different plan using an existing slug returns 409.

## Dictation

Dictation progressively enhances the editable request textarea. The browser adapter feature-detects `SpeechRecognition` and `webkitSpeechRecognition`, starts only from an explicit button gesture, shows interim/final text, and never submits or creates a page automatically. Stop, error, denial, unsupported, and end states retain typed input.

Jarvis stores no audio. The UI warns that some browsers may send microphone audio to their own recognition service, consistent with current [MDN SpeechRecognition guidance](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition). Only text explicitly submitted for preview is sent to Jarvis.

## Security Boundary

- Dashboard mutations are accepted only from a loopback socket while operator authentication remains future work.
- JSON bodies are strict and bounded; slugs, titles, requests, widgets, manifests, and fingerprints are Zod-validated.
- Static assets use fixed roots, dotfile denial, no extension fallback, and restrictive CSP/referrer/content-type/frame policies.
- Browser rendering uses DOM `textContent` for server values; page manifests cannot contain executable fields.
- Global graph reads validate the generated index and never traverse tenant-private memory.
- Page writes reuse serialized, symlink-rejecting, atomic graph primitives and rebuild immediately; broken links fail closed.

## Verification

- Unit: planner mapping, gaps, deterministic fingerprints, validation, idempotency/conflict, symlink rejection, and graph adjacency.
- Repository: bounded ordering/counts and proof that sensitive run/audit fields are absent.
- Service/routes: exact overview/graph/page DTOs, strict invalid input, local-only mutation, static security headers.
- Browser: desktop/mobile accessibility snapshots, page preview/create, navigation, error/empty states, unsupported dictation fallback, and screenshot review.
- Full: format, lint, typecheck, coverage thresholds, build, graph validation, live HTTP/browser checks, and independent review.
