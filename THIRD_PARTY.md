# Third-party attribution

## OpenClaw (MIT, v2026.6.2) — ChatGPT/Codex OAuth adaptation

The Codex/ChatGPT subscription provider adapter
([`src/models/codex-provider.ts`](src/models/codex-provider.ts)) reuses OAuth
token-handling facts and logic adapted from the MIT-licensed **OpenClaw** project
(`~/openclaw`, v2026.6.2), specifically its `extensions/openai/*` runtime:

- The OAuth **token-refresh** contract — `POST https://auth.openai.com/oauth/token`
  with `grant_type=refresh_token` and the public installed-app client id
  `app_EMoamEEZ73f0CkXaXp7hrann` — adapted from
  `extensions/openai/openai-chatgpt-oauth-flow.runtime.ts` (`refreshAccessToken`).
- The **`chatgpt_account_id`** extraction from the access-token JWT claim
  `https://api.openai.com/auth`, adapted from
  `extensions/openai/openai-chatgpt-auth-identity.ts` (`resolveCodexAuthIdentity`).
- The ChatGPT-backend request surface (`https://chatgpt.com/backend-api/codex/responses`
  with the `chatgpt-account-id` / `OpenAI-Beta: responses=experimental` / `originator`
  headers), observed from OpenClaw's `extensions/openai` / `extensions/codex` provider
  transport.

No OpenClaw source files are copied into this repository; the above facts and control
flow were re-implemented against this project's own interfaces and safety boundaries.
OpenClaw is distributed under the MIT License (`~/openclaw/LICENSE`).

Telegram pairing/allowlist formats under `~/.openclaw/credentials/` are read by the
secrets plane ([`src/secrets/provider-credentials.ts`](src/secrets/provider-credentials.ts));
further Telegram-config reuse will be recorded here as it is introduced (Phase E).
