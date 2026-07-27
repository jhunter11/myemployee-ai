# Model Runtime — Operator Runbook

Jarvis is fail-closed: **model execution is OFF until the operator enables it** in a durable,
version-checked, audited record. Turning it on is the only thing that lets a real model call happen.
This runbook covers the three CLIs that observe, enable, and exercise the runtime.

## The three commands

| Command                    | What it does                                                        | Writes state? |
| -------------------------- | ------------------------------------------------------------------- | ------------- |
| `npm run models:status`    | Probes providers/credentials, prints route bindings. Read-only.     | No            |
| `npm run models:enable`    | Views / flips the durable enablement gate (`status`/`enable`/`disable`). | Yes (audited) |
| `npm run models:run`       | Runs one real turn through the full coordinator and prints the reply.   | Usage event   |

## Providers on this host

`models:status` resolves the real credentials/runtimes and binds each logical tier:

- **`local` → Ollama** (`localhost:11434`). No credential, cost basis `local` (a genuine 0). This is
  the universal backstop and the cheapest proof that the runtime works.
- **`economy`/`frontier` → Claude** (Max subscription) via the headless `claude -p` CLI — the same
  OAuth this machine's Claude Code uses. Cost basis `subscription` (never a metered API key). If the
  token is revoked/logged-out, the call degrades cleanly to the next provider.
- Codex and Gemini are wired but gated separately.

## 1. Enable execution (operator gate)

Enable is version-checked and requires an approver and reason; the allow-lists are the exact tiers,
surfaces, and providers permitted. Start with the **local-only, zero-cost** posture:

```bash
npm run models:enable -- enable \
  --approver "jackhunter" --reason "local runtime proof" \
  --tiers 1 --surfaces automation --providers ollama
```

Check or reverse it any time:

```bash
npm run models:enable -- status
npm run models:enable -- disable --updated-by "jackhunter" --reason "pausing model execution"
```

- `--tiers` — `1` (local), `2` (economy), `3` (frontier); comma-separated.
- `--surfaces` — `web`, `telegram`, `automation`.
- `--providers` — `claude`, `codex`, `gemini`, `ollama`.

Deny-first: a provider/tier/surface that is available but not on the allow-list is never attempted.

## 2. Run a turn

```bash
npm run models:run -- --message "Reply with exactly one word: PONG" --route local
```

`--route local` resolves to tier-1 work (Ollama). `--route economy` / `--route frontier` resolve to
tiers 2/3 (Claude, with Ollama as the graceful fallback). Other flags: `--surface` (default
`automation`), `--system`, `--max-output-tokens`, `--timeout-ms`, `--client`, `--json`.

Exit codes: `0` executed (reply printed), `2` denied/no-runtime (gate closed or nothing available),
`1` invalid input. A denial prints the router reasons (e.g. `MODEL_EXECUTION_DISABLED`,
`TIER_NOT_ENABLED`, `SURFACE_NOT_ENABLED`) so you can see exactly which allow-list to widen.

### Worked local proof

```
$ npm run models:enable -- enable --approver jackhunter --reason "local runtime proof" \
    --tiers 1 --surfaces automation --providers ollama
{"enabled":true,"version":2,"allowedTiers":[1],"allowedSurfaces":["automation"],"allowedProviders":["ollama"], ...}

$ npm run models:run -- --message "Reply with exactly one word: PONG" --route local
{"status":"executed","tier":1,"route":"local","execution":{"status":"succeeded","provider":"ollama","model":"qwen2.5-coder:7b","usageEventId":"model-usage:..."}}

PONG
```

Each turn writes exactly one `model_usage_events` row (`cost_basis` `local` for Ollama,
`subscription` for Claude) — the metering the executor requires before it will return a reply.

## Using the Claude subscription (OAuth) path

The `economy`/`frontier` routes use the `claude` CLI's own credential. If a turn falls through to
Ollama with a `claude:failed` attempt, the subscription credential is not usable headlessly:

- **`Please run /login` / `401 OAuth ... revoked`** — the stored token is dead. Re-authenticate the
  Claude CLI yourself (`claude`, then `/login`); the runtime cannot and will not do this for you.
  Confirm with `npm run models:status` (claude `up`) and a direct `claude -p` check before enabling
  tier 2/3 with `--providers claude`.

The runtime never fabricates a reply: if no authorized provider succeeds, the turn returns
`all_failed`/`no_runtime` and the caller degrades to deterministic behaviour.
