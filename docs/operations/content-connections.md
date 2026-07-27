# Content Connections — Operator Runbook

The faceless-content pipeline draws narration and visuals from **connections**. Free/local
connections work immediately; premium ones (ElevenLabs, Higgsfield) are fully wired but **inert until
their credential is plugged in** — no code change, no redeploy. Connecting a key is the switch.

## See what's connected

```bash
npm run content:connections
```

Read-only. It probes each provider and prints, secret-free, what is live and how each lane binds:

```
Narration (voice)
  [up  ] local_say          free     macOS say runtime available (local, no credential)
  [down] elevenlabs         premium  no credential connected (set ELEVENLABS_API_KEY or keychain ...)
  starter -> local_say
  premium ready -> none connected

Visuals
  [down] pexels             free     no credential connected (set PEXELS_API_KEY or keychain ...)
  [up  ] local_title_card   free     local renderer available (no credential)
  [down] higgsfield         premium  no credential connected (set HIGGSFIELD_API_KEY or keychain ...)
  starter -> local_title_card
  premium ready -> none connected
```

`starter` is the free-first default the pipeline uses automatically. `premium ready` lists connected
premium tools available on explicit request — premium is never auto-selected.

## The connections

| Lane | Provider | Cost basis | Needs | Notes |
| --- | --- | --- | --- | --- |
| Narration | `local_say` | local (0) | nothing | macOS `say`; the free starter voice |
| Narration | `elevenlabs` | metered | `ELEVENLABS_API_KEY` | premium; character-priced; the first voice upgrade |
| Visuals | `local_title_card` | local (0) | nothing | generated title cards; the guaranteed backstop |
| Visuals | `pexels` | free API | `PEXELS_API_KEY` | free stock B-roll; auto-becomes the visual starter once connected |
| Visuals | `higgsfield` | subscription | `HIGGSFIELD_API_KEY` | premium; V1 emits a **manual production manifest** (no reverse-engineered API) |

## Connecting a tool

Set an environment variable **or** add a macOS Keychain entry — either flips the provider to `up` on
the next `content:connections` run. The value is read only at call time by the adapter and is never
logged or printed.

Environment variable (simplest):

```bash
export PEXELS_API_KEY="<your key>"
export ELEVENLABS_API_KEY="<your key>"
export HIGGSFIELD_API_KEY="<your key>"
```

Keychain (survives shell restarts; add it yourself so the secret never passes through Jarvis):

```bash
security add-generic-password -s ai-agency-jarvis.pexels -a api-key -w
```

(`-w` prompts for the value interactively; the same pattern applies to
`ai-agency-jarvis.elevenlabs` and `ai-agency-jarvis.higgsfield`.)

## What each connection does when live

- **Pexels** — searches `/videos/search` and returns clip links with provenance and the Pexels
  license preserved per asset.
- **ElevenLabs** — synthesizes narration via `/v1/text-to-speech/{voice}` to an audio file; reports
  the character count that is its cost basis.
- **Higgsfield** — with a credential connected, `query()` returns reviewable manual-production shot
  specs (`requiresManualProduction: true`). When an official API is separately verified, only the
  adapter's internal body changes — the connection contract is identical, so it keeps working.

Every adapter fails closed: a missing credential, rejected key, timeout, or rate limit throws a typed
error and the pipeline falls back to the free starter rather than fabricating media.
