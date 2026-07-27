# Jarvis Client Demo and Handoff

## What this demo proves

The current local build demonstrates a safe personal/agency control pattern:

- a deterministic daily briefing over a local demo calendar, private memory, and agency approvals;
- calendar conflict detection and a proposed focus block with no provider write;
- personal Markdown memory that is not part of the agency/client graph;
- an agency posture that separates reversible internal work, approvals, and blocked work;
- local Jarvis chat backed by bounded read models, with source references and no model call;
- declarative Page Studio recipes, canonical preview/fingerprint/confirmation, and a rendered saved
  Jarvis page;
- queue, client, run, growth, knowledge, health, and economics surfaces already present in the
  control plane.

It does not claim a connected Google/Outlook calendar, configured Telegram bot credential/private
chat, authenticated remote site, live LLM conversation, non-Jarvis profile executors, or unrestricted
autonomy. The 34-profile hierarchy and persistent exact-agent conversations are implemented, but
only Jarvis has a deterministic conversation runtime; other profiles return
`runtime_not_configured` for work. See
[`../operations/v1-operator-handoff.md`](../operations/v1-operator-handoff.md) for the exact status
and activation boundaries.

## Start

```bash
npm ci
npm run build
npm test
npm start
```

Open <http://127.0.0.1:3000/dashboard>.

## Seven-minute walkthrough

1. **Today:** show two explicit local-demo events, agency approval count, memory-review count, and
   guarded-autonomy posture. Explain that empty, stale, and unavailable are distinct.
2. **Jarvis:** ask “What needs my attention today?” and “Show agency agent status.” Expand the
   evidence references. Explain that V1 is deterministic and token-free.
3. **Calendar:** show the conflict count and proposed focus block. Point out “no provider write
   performed” and the approval verdict.
4. **Personal memory:** show the projects and decisions branches. Explain that personal records use
   strict metadata and are never included in the agency graph.
5. **Agent floor:** traverse the server-owned Jarvis → Agency / MCP-x402 tree, open an exact profile
   conversation, and show its tools, sleeves, scope, continuation plan, and truthful runtime mode.
   Explain that containment grants no authority and profile-only agents do not execute work.
6. **Page Studio:** open the published Jarvis page. Then load a quick recipe, preview its mappings,
   inspect gaps/checks/fingerprint, confirm, and publish.
7. **Queue/Runs:** show how actual deterministic client workers are ordered and how completion
   evidence is recorded.

## Client conversation

Ask the client:

- Which daily decision requires reconstructing context from two or more systems?
- Which repeated internal task is reversible, measurable, and safe to run without contacting
  anyone?
- Which action must always show an exact approval preview?
- What information must never cross from personal/company/client scope?
- What export or API can prove the workflow before a broad integration?

Use the answers to define one bounded pilot. Do not sell a generic autonomous agent.

## Next connection decision

The provider-neutral calendar repository, incremental-sync service, and reader seam exist, but no
provider-specific adapter or credential is configured. Choose the operator's actual provider before
implementing exactly one adapter:

- Google Calendar: narrow read scope, local PKCE OAuth, Keychain refresh token, incremental sync.
- Outlook: delegated Microsoft Graph scope and PKCE.

The private Telegram long-polling adapter now exists but remains disabled until the operator stores a
bot token in macOS Keychain and installs one exact positive user/private-chat allowlist. It supports
bounded reads and proposals, not approval or execution. Follow the activation steps in the operator
handoff; Telegram is a steering channel, not a private document vault.

Do not expose the existing gateway through a reverse proxy. Remote browser access requires a
separate authenticated listener; the first version should be GET-only until the security gate
passes.
