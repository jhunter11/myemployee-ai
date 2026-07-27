# SPEC: Meta-UX Operator Dashboard

Date: 2026-07-20

## Overview

This iteration makes the dashboard a trustworthy orientation and decision surface. It preserves the
existing bounded server DTOs and safe DOM rendering, while separating deterministic presentation
logic from browser effects and making every view communicate posture, freshness, next action, and
evidence consistently.

## Architecture

```text
bounded same-origin DTOs
  -> independent source refresh coordinator
  -> pure dashboard-core state/presentation rules
  -> semantic DOM adapter
  -> one concise status announcement + visible source freshness
```

### `dashboard-core.js`

A dependency-free UMD module owns only pure rules:

- canonical view titles, summaries, and document titles;
- health posture that distinguishes core readiness from optional dependency degradation;
- exact run and queue summaries that do not hide failed work;
- source-settlement reduction with monotonic request sequence and last-good retention;
- active, paused, stale, and disconnected refresh presentation;
- bounded retry delay and safe allowlisted status class tokens;
- identifier presentation and bounded-list disclosure.

It receives plain data and returns plain data. It cannot access the DOM, fetch, timers, storage,
filesystem paths, tenant data, or mutation routes.

### Browser adapter

`app.js` remains responsible for fetch, scheduling, event listeners, and DOM text nodes. It requests
the five existing sources independently, gives each request a ten-second abort deadline, commits and
renders each source as soon as it settles, retains last-good values, and marks only failed sources
stale. Auto-refresh uses a recursive timeout, never overlaps an active load, pauses while the document
is hidden, and backs off after failures. Background success does not announce; operator refresh and
Page Studio outcomes use one global `role="status"`, while dictation keeps its local state message.

### Semantic shell and visual system

- The active view is the document `h1`; the brand is not a competing `h1`.
- Direct view sections use `h2` and nested evidence uses `h3`, preserving a navigable outline.
- URL, title, visible heading, summary, navigation current state, and focus update atomically.
- Modified or middle-click navigation keeps native browser behavior.
- A persistent context strip exposes core posture, next safe decision, control mode, and freshness.
- Queue metrics name running, succeeded, and failed work explicitly.
- Safe health evidence lists allowlisted check labels and values, never raw errors.
- Growth places the next gated move before prospect and simulation evidence and discloses
  `showing N of total` when the bounded read model returns fewer records.
- Decorative borders and control boundaries use separate contrast tokens. Normal text meets WCAG
  2.2 AA contrast; essential control/state boundaries meet non-text contrast requirements.
- Long identifiers wrap inside `min-width: 0` grid children. Layouts reflow without document
  overflow from 320px phones through 2406px ultrawide displays.
- At compact widths, the current hierarchical control-site contract supersedes the original
  seven-destination grid: Today, Jarvis, Work, Agents, and More remain visible in a fixed safe-area
  command bar. More exposes all secondary deep links. The decision is first in both DOM and visual
  order; context and metric evidence remain bounded rather than causing document overflow.
  Metric strips are named focus regions so arrow-key scrolling does not depend on browser heuristics.
- Container-aware grids also reflow under 200% text resizing; direct Saved-view loads request every
  read model that an allowlisted widget may need.
- Reduced motion removes the view transform and animation rather than compressing it to a near-zero
  duration.

## Browser State

```text
source = { value, status: empty|fresh|stale|unavailable, sequence, updatedAt, message }
refresh = { derivedMode: active|paused|stale|disconnected, failureCount, timer }
```

State is memory-only and contains only the already-redacted DTOs. A failed first load is
`unavailable`; a failed refresh with prior data is `stale`. An older response cannot replace a newer
sequence.

## Interface Contracts

- `viewDefinition(view)` returns one allowlisted title, summary, document title, and source list;
  invalid input resolves to Today, the newer personal command-surface default in `SPEC.md`.
- `healthPosture(health)` returns `ready`, `attention`, or `blocked`, plus core/optional evidence.
- `reduceSourceState(previous, event)` accepts `source_succeeded` or `source_failed` and returns a
  new plain-data shape while rejecting an older sequence.
- `nextRefreshDelay(failureCount)` returns a bounded delay from 30 seconds to 5 minutes.
- Presentation functions return text and allowlisted class tokens only. Server strings remain text.

No new HTTP endpoint, browser storage, client identifier, credential, mutation, or external network
capability is introduced.

## Domain Bridge

| Operator need                    | Technical implementation                                             |
| -------------------------------- | -------------------------------------------------------------------- |
| Know whether Jarvis can work     | Core readiness separated from optional dependency degradation        |
| Know what to do next             | Persistent decision summary and action-first Growth order            |
| Trust the screen after failure   | Per-source last-good retention and visible stale/unavailable state   |
| Regain context after navigation  | Atomic URL/title/heading/current/focus update                        |
| Operate across screen formats    | Complete navigation, decision-first compact evidence, bounded reflow |
| Avoid accidental external action | Existing review-only and loopback boundaries remain unchanged        |

## Refinement and Edge Cases

- **One source fails:** render other fresh sources; retain and label prior data only for the failed
  source.
- **All sources fail:** show disconnected posture and local error states without destroying prior
  data.
- **Two refreshes race:** the newest sequence wins.
- **One endpoint stalls:** other sources render immediately and the stalled request becomes
  unavailable after ten seconds, allowing the refresh cycle to continue.
- **Tab becomes hidden:** pause the next timer; resume with a fresh read when visible.
- **Modified navigation:** do not intercept it.
- **Unknown status or identifier:** show neutral text/class; never derive arbitrary class names.
- **No queue item:** state that no work is ready; do not invent an action.
- **Long IDs, text spacing, or 200% text:** content wraps and controls remain reachable.
- **Phone, rotation, tablet, or ultrawide:** the shell fills the actual page viewport, every
  navigation target remains contained, and active content introduces no document overflow.
- **Reduced motion:** no transform or transition is required to understand a view change.

Dependencies are stable: vanilla browser APIs, current DTOs, and current routes. The only operational
risk is extra local read traffic, mitigated by a 30-second floor, visibility pause, backoff, and no
overlap.

## Gap Analysis and Tasks

| Gap                                  | Change                                                 | Complexity | Verification                                                       |
| ------------------------------------ | ------------------------------------------------------ | ---------- | ------------------------------------------------------------------ |
| Browser logic is untestable monolith | Add pure `dashboard-core.js` and unit tests            | Moderate   | CommonJS tests cover view, posture, source, delay, and safe tokens |
| One failed endpoint wipes all panels | Independent settlement and last-good state             | Moderate   | Regression test plus intercepted browser failure                   |
| One stalled endpoint freezes cycling | Per-request abort deadline and immediate source commit | Moderate   | Delayed-route browser check plus timeout shell contract            |
| Health/runs omit decisive evidence   | Truthful presenters and health evidence                | Moderate   | Exact presenter tests and live DTO comparison                      |
| Growth action is below evidence      | Reorder semantic DOM and add safe internal navigation  | Trivial    | DOM order and above-pipeline browser assertion                     |
| Mobile Knowledge/header overflow     | Grid containment and non-stretching responsive shell   | Moderate   | Every view at 320/390/901/1024/1440                                |
| Compact nav and context hide work    | Complete nav grid and decision-first evidence strips   | Moderate   | 390×844 geometry plus portrait/landscape/zoom/ultrawide matrix     |
| Static title and generic focus       | Atomic navigation effect                               | Moderate   | URL/title/heading/current/focus and history checks                 |
| Broad live regions are noisy         | One global status; local form regions only             | Trivial    | Shell contract and accessibility snapshot                          |
| Contrast token misses AA             | Split text/control tokens and raise quiet contrast     | Trivial    | Programmatic contrast test and computed styles                     |
| Bounded prospect list is silent      | Render showing/total disclosure                        | Trivial    | Presenter and live Growth assertions                               |

Critical path: core tests → core implementation → DOM adapter → semantic/CSS implementation →
focused tests → live browser matrix → complete release gate.

## Testability and Completion Criteria

1. Unit tests first fail, then pass for all pure contracts and regression cases above.
2. Shell tests prove one `h1`, one global status region, no broad metric `aria-live`, fixed asset
   ordering, real navigation links, and unchanged CSP/loopback boundaries.
3. All seven live views have exactly one visible panel, matching URL/title/heading/current item, no
   console error, complete contained navigation, and no document overflow across phone portrait,
   phone landscape, tablet portrait/landscape, zoom-equivalent, desktop, and ultrawide formats.
4. Keyboard checks cover skip link, all navigation, lane buttons, dynamic rows, Refresh, Knowledge
   search, and Page Studio; focus is visible and never lands in hidden content.
5. A simulated single-source failure retains unrelated and last-good content, labels the exact stale
   source, renders a successful Queue source even when Overview is unavailable, and recovers on the
   next successful refresh.
6. A simulated stalled source cannot delay a successful source from rendering and clears the busy
   state at the ten-second request deadline.
7. Reduced-motion, 200% text, text-spacing overrides, and forced-colors checks preserve content and
   controls.
8. Focused tests, typecheck, lint, full coverage, format check, build, graph rebuild, and
   `git diff --check` pass before completion.

The accessibility baseline is [WCAG 2.2](https://www.w3.org/TR/WCAG22/), including page titles,
status messages, reflow, contrast, focus visibility, and target size. WAI guidance is treated as
implementation advice, not as new conformance criteria.

## Transcend and Include

- **Keep:** safe read models, DOM `textContent`, anchors, pushState restoration, 44px controls,
  reduced-motion intent, Page Studio confirmation, CSP, and loopback mutation enforcement.
- **Extend:** navigation metadata, refresh state, health evidence, responsive tokens, and action
  hierarchy.
- **Replace:** global `Promise.all` failure coupling, static title, duplicated visual headings,
  broad live regions, dynamic status class suffixes, and silent bounded-list truncation.
