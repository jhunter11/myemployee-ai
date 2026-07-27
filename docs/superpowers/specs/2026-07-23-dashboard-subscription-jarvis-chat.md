# Dashboard Subscription Jarvis Chat

Date: 2026-07-23

## Outcome

The loopback dashboard lets the local operator connect and select exactly one
supported subscription runtime—Claude.ai or OpenAI ChatGPT—and then use that
runtime for ordinary conversations with the durable `jarvis` profile.

Grounded Jarvis commands remain deterministic. Model execution remains disabled
until the operator explicitly selects a connected subscription, and disabling
the runtime is a durable kill switch.

## Operator flow

1. Open `/dashboard?view=chat`.
2. Review the redacted Claude and OpenAI connection states.
3. If needed, start the provider-owned browser login from a fixed dashboard
   button. The browser request cannot supply a command, executable, credential,
   callback, scope, tenant, model, or CLI argument.
4. Select one connected provider. The mutation carries only the public provider
   name and the current durable version.
5. Start or open a Jarvis conversation and send an ordinary message.
6. A successful subscription turn is persisted with response mode `model` and a
   content-free model-usage evidence reference. A denied or failed turn falls
   back visibly to deterministic Jarvis without fabricating model output.
7. Disable the runtime from the same card to clear every model allow-list.

## Trust boundaries

- Dashboard routes require an exact loopback host. Mutations also use the
  existing same-origin loopback guard.
- Public provider names are `claude` and `openai`; `openai` maps internally to
  the `codex` execution adapter.
- Selection is accepted only when a fixed CLI status probe confirms a
  subscription login:
  - Claude: logged in through `claude.ai`, never an API-key provider.
  - OpenAI: Codex reports a ChatGPT login, never an API-key login.
- The server supplies the approver, reason, tier 2, `web` surface, and the exact
  one-provider allow-list. Browser input cannot widen them.
- The model coordinator is constructor-bound to `surface: web` and
  `clientId: null`.
- Only the exact `jarvis` profile can reach this web model responder. Other
  profiles remain profile-only.
- Model requests carry no tools. The system policy cannot be replaced by
  conversation text.
- Conversation history comes from the repository binding, not request fields,
  and is reduced to a bounded recent window before execution.
- Model output must be non-empty and no longer than the durable message limit.
- Provider output, prompts, credentials, account identifiers, and raw CLI
  status output are never logged or returned by the runtime-control API.

## Fixed execution policy

Ordinary Jarvis conversation uses:

- operation: `jarvis_conversation`
- work type: `synthesis`
- risk: `low`
- sensitivity: `confidential`
- assurance: `standard`
- prior validation failures: `0`
- network mode: `allowlist`
- tier: `2`
- surface: `web`
- tenant/client: none
- tools: omitted
- output: at most 1,024 tokens and 16,000 characters
- timeout: bounded below the coordinator maximum

The existing deterministic intents—today, calendar, memory, agency, saved
pages, and the agent-tree synthesis—do not call a model.

## Dashboard API

### `GET /api/v1/dashboard/model-runtime`

Returns only:

- durable enabled state and version;
- selected public provider or `null`;
- the two bounded provider connection states;
- login availability/in-progress state;
- a short redacted status detail.

### `POST /api/v1/dashboard/model-runtime/providers/:provider/login`

Starts one fixed provider-owned login process and returns `202`. The provider
route parameter is strict and no request body fields are accepted.

### `POST /api/v1/dashboard/model-runtime/select`

Accepts exactly:

```json
{ "provider": "claude", "expectedVersion": 1 }
```

The server stores tier `[2]`, surface `["web"]`, and exactly one mapped provider.

### `POST /api/v1/dashboard/model-runtime/disable`

Accepts exactly:

```json
{ "expectedVersion": 2 }
```

The server clears every model execution allow-list.

## Acceptance evidence

- Unit tests cover redacted status checks, strict login launches, selection,
  version conflicts, durable disabling, deterministic bypass, bounded history,
  model success, oversized/invalid output, and every fallback outcome.
- Route tests reject unknown provider, scope, tenant, tier, model, actor, command,
  and callback fields.
- A production-composition test uses a fake provider to prove selection,
  response-mode persistence, usage attribution with `client_id = NULL`, restart
  persistence, and zero calls after disable.
- Opt-in live smokes prove one harmless text-only turn through the current Claude
  subscription and one through the current ChatGPT subscription.
- The full release gate passes.
- The built dashboard is exercised at desktop and 390 px with a clean console,
  then the installed loopback runtime is restarted and proven to serve the
  tested release.
