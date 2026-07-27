# Jarvis Control Site Refactor: SPAR Decision

## Decision

Refactor Jarvis as a clean-room operator product. Do not fork World Monitor, WrenAI, or Edict. Each contains useful interaction patterns, but none supplies Jarvis's trust model, and two create material license risk for direct UI reuse.

| Reference     | What survives                                                                                                                                         | What fails                                                                                                                                                                                       | Decision                                                                      |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| World Monitor | Widget registry, explicit loading/empty/stale/error lifecycle, freshness, named layouts, lazy hydration, mobile categories, bounded server projection | ~4,401 files and ~680k TS/JS lines; large provider/Redis/relay surface; UI/platform is AGPL; programmatic access is not the free dashboard; generated summaries are not claim-level citations    | Borrow patterns; later benchmark a narrow OSINT adapter; no fork or code copy |
| WrenAI        | Governed metric definitions, confirmed examples, Answer/Evidence-style workbench, lineage, build→verify→preview→publish                               | Current main is a Python/Rust semantic SQL engine, not the pictured web app; classic UI is frozen/AGPL and desktop-first; wrong abstraction for personal/code memory; no native SQLite connector | Defer read-only analytics sidecar until a real client has multi-table BI pain |
| Edict         | Visible execution gates, compact stage rail, joined task control/evidence, agent telemetry, blueprint gallery                                         | MIT but immature; polished UI targets a legacy contract; newer API lacks Jarvis-grade auth/tenant boundaries; raw thinking is a liability; “court discussion” is one-model role-play             | Reimplement selected UI ideas over Jarvis contracts; reject runtime/fork      |

Primary evidence: [World Monitor license](https://github.com/koala73/worldmonitor/blob/5cd162f594babb3ab9b22ef9fec78076a4978430/LICENSE), [panel shell](https://github.com/koala73/worldmonitor/blob/5cd162f594babb3ab9b22ef9fec78076a4978430/src/components/Panel.ts), [Wren transition notice](https://github.com/Canner/WrenAI/blob/13fb14214caac034b05b5e4632d3a52cbd8c754c/README.md), [Wren classic answer tabs](https://github.com/Canner/WrenAI/blob/e42b8d057c611016d781c7bbe74ba4e5aeb9712d/wren-ui/src/components/pages/home/promptThread/AnswerResult.tsx), [Edict task board](https://github.com/cft0808/edict/blob/14a207557719c046af0f993a7bff1cc5a5015b33/edict/frontend/src/components/EdictBoard.tsx), and [Edict API security posture](https://github.com/cft0808/edict/blob/14a207557719c046af0f993a7bff1cc5a5015b33/edict/backend/app/main.py).

## Design-skill review

- Installed Anthropic's official `frontend-design` skill: strongest at subject-specific visual direction and resisting templated output. The source repository currently shows about 163k stars. [Source](https://github.com/anthropics/skills/tree/main/skills/frontend-design)
- Installed Impeccable: strongest at product-interface critique, information architecture, accessibility, responsive hardening, and deterministic anti-pattern detection; its repository currently shows about 48.5k stars. [Source](https://github.com/pbakaus/impeccable)
- Retained the already-installed UI/UX Pro Max database for checklists and data-display guidance. Its generated purple/pink “AI” palette and spa typography were rejected as mismatched—the database is an input, not a design authority. [Source](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill)

## Product architecture

```text
scope rail          operator workbench                 inspector
You                 Today / Jarvis / Work / Agents      evidence
├─ Personal         conversation + answer tabs          grants
├─ Agency           lifecycle rail + artifact state     sleeves
└─ Clients          roster + truthful telemetry         approvals
```

Containment, delegation, and grants remain separate graphs. The workbench must render typed read models rather than infer authority from UI selection.

## Refactor sequence

1. **Visual and information architecture — implemented locally.** New dark instrument system, scope rail, grouped navigation, bounded status band, conversation inspector, authority topology, agent registry shell, responsive reflow, and honest disabled telemetry controls.
2. **Frontend seams.** Split the 747-line HTML and 1,993-line controller into an app shell, typed view registry, source store, widget registry, and per-view modules. Add common widget lifecycle and named workspace manifests.
3. **Real control contracts.** Implement scope/agent/sleeve/grant repositories, URL-preserved roster filters, execution rails, per-run evidence tabs, and SSE freshness.
4. **Blueprint Studio.** Add versioned blueprint cards, verifier/eval status, shadow/canary state, approval gates, and rollback evidence.
5. **Optional intelligence.** Benchmark direct primary-source/RSS retrieval before any paid World Monitor adapter. Retain publisher, URL, published/retrieved time, hash, freshness, and supporting record IDs.

## Kill criteria

- No direct AGPL UI/code import without an explicit licensing decision.
- No raw reasoning display, invented telemetry, cross-sleeve search, or free-text tenant selection.
- No map/news layer on the home screen unless operator tests show it improves daily decisions.
- No Wren sidecar until a 20-question client benchmark beats deterministic reporting with zero scope failures and under two hours onboarding.
- No dashboard refactor is complete until desktop/mobile keyboard, contrast, overflow, stale/error, and console checks pass.
