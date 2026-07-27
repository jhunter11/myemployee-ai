# Agency Kanban Board

Privacy-first local task tracking for Jarvis. Detailed dependency and acceptance criteria live in
`TASKS.md` and the dated plans under `docs/superpowers/plans/`.

## 📋 Next

- [ ] Continue Tasks 3–4 of the active production-reliability roadmap.
- [ ] Implement proof-gated pending, verification, settlement, and finalization semantics before
      any model can cause worker execution.
- [ ] Complete the canonical clean-tree release/attestation gate and the remaining governed-change
      lifecycle before production activation.

## 🏗️ In Progress

- [ ] Jarvis production reliability and governed self-management roadmap (Tasks 3–32; no production
      acceptance claimed).

## ✅ Done

- [x] Deterministic loopback gateway, dashboard, client registry, exact-agent conversations, and
      `acme_corp` daily-report fixture.
- [x] Markdown memory graph, scoped memory sleeves, and deterministic recovery foundations.
- [x] Default-off model routing, durable operator enablement, usage ledger, and fake provider stack.
- [x] Pre-LLM text-only coordination boundary, strict validation, deny-first provider probing, and
      crash-safe subscription cooldown recovery.
- [x] One `npm run verify:framework` gate for the deterministic pre-LLM checkpoint.
- [x] Agent archetype generalization V2: 45-profile static catalog from pod recipes, plus
      operator-approved runtime pod instantiation bound to an exact company, client, or project
      scope with blueprint-only grants and a governed lease that quarantines on expiry.
- [x] Generative Jarvis conversation adapter through the text-only `ModelTurnCoordinator`
      (`src/chat/jarvis-model-chat.ts`), with the keyword router kept as the switch-off fallback.
      Model execution remains OFF in the durable enablement record until an operator turns it on.
- [x] Multi-provider model executor (Claude/Codex/Gemini/Ollama) bound to logical tiers, with
      provider rate-limit circuits and a crash-safe recovery scheduler.
- [x] Interchangeable `MemorySystem` seam: `flat` (default), `typed_hybrid`, `typed_temporal`, and
      event-sourced `ledger` backends, selected by `JARVIS_MEMORY_BACKEND`. Additive and default-off.
- [x] Faceless-content pipeline with gated provider connections; free/local providers work with no
      credentials and credentialed ones stay inert until a key is connected.
- [x] Read-only memory and code graph views on the dashboard, plus the layout grid.

## 🐛 Automated Bug Reports

_(Auto-populated by Jarvis Nightly Audits.)_

- [ ] No open checkpoint-blocking bugs.
