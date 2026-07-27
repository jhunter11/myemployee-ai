# Faceless Content Studio

> **Status: `built_unverified` — planning and evidence only.** This workflow does not publish, buy
> generation credits, reuse third-party stories, or claim revenue. Every concept, script, paid
> provider promotion, final render, and publish action remains operator-reviewed.

## Decision

Start with one recognizable, original series rather than a collection of unrelated “AI stories.”
The first proof loop is a run of native 65–90 second vertical episodes for TikTok and YouTube
Shorts. Winning premises can then become 8–12 minute YouTube episodes. Visual production is a
separate, swappable choice:

1. `short_story`: original serialized fiction with stills, restrained motion, narration, captions,
   and sound design.
2. `broll_short`: researched, transformative curiosity/story content using owned, licensed, or
   public-domain B-roll.
3. `cinematic_short`: the same narrative discipline with premium generated scenes. Higgsfield is
   eligible only after the pilot gate passes.
4. `longform`: an 8–12 minute original story or researched narrative, assembled from a hybrid of
   B-roll, stills, diagrams, and—after proof—selected cinematic hero shots.

The format and visual provider are deliberately independent. A winning story can move from a cheap
proof treatment to Higgsfield without rewriting the entire Jarvis workflow.

## Account portfolio and reuse

An **email group** represents the accounts controlled through one login email, but the raw email is
private connection data. Jarvis derives a tenant-bound HMAC identifier such as
`email_group:<digest>`, stores the email only behind a secret reference, and uses the opaque group
ID in runs, memory, analytics, and diagrams.

Each group may connect several platform accounts through one of four publishing adapters:

- `manual_export`: no API or subscription; Jarvis packages platform-native files and metadata for a
  human to post.
- `direct_platform`: YouTube, TikTok, or Meta OAuth owned by Jarvis. This avoids a publisher
  subscription but carries separate app review, audits, token refresh, and per-platform maintenance.
- `zernio`: a unified OAuth/publishing/analytics adapter; the first two connected accounts are
  currently free and higher counts are usage-priced per account.
- `ayrshare`: a more expensive unified adapter priced by social profile, with multiple networks in
  one profile and an agency-oriented operational surface.

Credential references are opaque. OAuth access/refresh tokens never enter worker input or output.
The connection end is intentionally compatible with Jarvis's existing scoped connection pattern:
`connectionId`, tenant/scope binding, provider key, state/version, credential expiry, and provider
error state.

The story core, voice performance, visual pack, captions, music/sound layer, and platform metadata
are separate components. A distribution command can reuse one original story across accounts while
assigning a different licensed voice and visual pack to each account. Jarvis refuses to create more
variants than there are unique voice/visual combinations and never approves or performs the publish
itself.

This is controlled adaptation, not duplicate-channel spam:

- every account has a declared audience/role;
- every variant changes both the performance and visual treatment;
- titles, captions, hooks, and calls to action are platform/account-native;
- the exact rendered file and target account receive their own publish proposal;
- stagger/cadence policy is explicit; and
- analytics remain attributable to the story core, variant, account, and platform.

## Daily operating loop

Publishing starts as a **manual hour**, not an automation. Jarvis produces an ordered session sheet
and the operator executes it: sign in to one account, upload that account's approved items, verify
the posts are live, record the public URLs, sign out completely, then move to the next account.

Four uploads across four accounts fit in roughly 44 minutes at six minutes per upload plus five
minutes of per-account overhead, leaving slack inside a 60-minute block. The planner refuses to
schedule beyond the declared budget: overflow is deferred with a reason rather than silently
truncated, and items that are not QC-approved or rights-cleared are rejected rather than scheduled.

Jarvis never signs in, never holds a platform password, and never uploads in this phase. The
procedure is in [RUNBOOK.md](./RUNBOOK.md); the staged path from here to agentic upload, ElevenLabs,
and Higgsfield is in [ROADMAP.md](./ROADMAP.md).

## Why this shape

- TikTok's Creator Rewards Program requires eligible videos to be original, high-quality, and at
  least one minute; account and regional eligibility are separate. A 65–90 second master is safely
  on the monetizable-format side while remaining usable as a YouTube Short.
- YouTube classifies vertical videos up to three minutes as Shorts, but monetization review rejects
  repetitive, mass-produced, or minimally transformed content. Original narrative substance and a
  visible creative point of view are therefore product requirements, not optional polish.
- YouTube's ad-revenue YPP threshold is currently 1,000 subscribers plus either 4,000 public
  long-form watch hours in 12 months or 10 million valid public Shorts views in 90 days. Shorts
  watch time does not count toward the 4,000-hour path, so a shorts-only strategy leaves out the more
  controllable long-form watch-time route.
- Monetized YouTube videos eight minutes or longer can use mid-roll ads. This is why the long-form
  lane targets 8–12 minutes, not because length alone makes a video valuable.
- TikTok's 2026 trend report emphasizes curiosity, niche communities, emotional return, and content
  worth the viewer's time. YouTube also emphasizes worlds and fandoms that audiences can expand.
  A recurring original universe is a better fit than anonymous template churn.

## Recommended first series

Use **original micro-mysteries with a human dilemma** as the default creative sandbox: one
recognizable narrator, one visual identity, a cold-open consequence, an escalating mystery, a fair
reveal, and a final question that invites interpretation. Horror, speculative fiction, alternate
history, folklore, and science-curiosity treatments can all use that structure, but each episode
must add a distinct premise and payoff.

This is a recommendation to test, not a claim that one niche is universally best. Jarvis records
the operator's creative thesis and interest evidence for every concept, then lets real retention,
sharing, comments, follow conversion, and cost data decide.

## Formats to avoid

- Scraped Reddit/story-site narration, unlicensed podcast or movie clips, and news-feed readings.
- Generic quote slides, interchangeable “top ten” templates, or lightly varied generated scenes.
- Fake real-world events, public-figure endorsements, unconsented likenesses, and cloned voices
  without permission.
- A high posting volume before the channel has a stable creative voice and quality baseline.
- Revenue projections based on third-party RPM anecdotes. Jarvis records actual platform analytics
  and actual known costs; unknown revenue or cost remains unknown.

## Pilot

The recommended first gate is 12 eligible episodes with:

- a preregistered winner definition based on the channel's own seven-day baseline;
- complete seven-day analytics for every eligible post;
- at least three winners;
- complete known-cost coverage;
- zero rights or platform-policy incidents; and
- an explicit operator decision to allow paid visual generation.

Suggested winner inputs are engaged-view/hold rate, average percentage viewed, shares and meaningful
comments per 1,000 views, and follows per 1,000 views. Do not choose the winning metric after seeing
the outcome.

## Provider and startup-cost decision

Prices below were checked on 2026-07-23 and are planning inputs, not permanent constants. Tax,
region, annual discounts, overages, model choice, and provider changes can alter them.

| Layer             | Proof-of-concept choice                   | When to pay                                                    |
| ----------------- | ----------------------------------------- | -------------------------------------------------------------- |
| Editing/render    | Local FFmpeg/captions                     | Keep local until throughput or template operations become hard |
| B-roll            | Pexels API + owned footage                | Paid stock only when search quality or exclusivity is limiting |
| Narration         | Human/local placeholder, then ElevenLabs  | ElevenLabs is the first quality upgrade for story-led content  |
| Cinematic visuals | Stills + restrained motion                | Higgsfield only after a story/series wins the evidence gate    |
| Publishing        | Manual export or two free Zernio accounts | Unified API after the manual loop proves useful                |
| Planning          | Existing Jarvis model/runtime             | Record actual usage; do not invent per-video model cost        |

Observed public entry points:

- **ElevenLabs:** free tier; commercial-license/instant-cloning Starter was shown around $5–$6 per
  month by locale; Creator around $22/month (with a first-month promotion shown separately). The API
  reports character cost and request/trace IDs, so Jarvis can keep an actual usage ledger.
- **Higgsfield:** plans were shown from roughly $9/month, with broader model access around $29+ and
  higher video tiers above that. Credits vary by model, duration, and resolution, so a plan price is
  not a trustworthy per-video cost.
- **Zernio:** first two connected accounts free; accounts 3–10 at $6/account/month, then graduated
  lower tiers. One email group with YouTube, TikTok, Instagram, and Facebook would currently be
  about $12/month after the two free connections.
- **Ayrshare:** Premium $149/month for one social profile and up to 13 networks; Launch $299/month
  for up to ten profiles. This is hard to justify for an unproven internal content network.
- **Pexels:** free API with default limits of 200 requests/hour and 20,000/month. Preserve asset
  provenance and license/attribution evidence even when attribution is optional.

**Higgsfield and ElevenLabs are not substitutes.** ElevenLabs is an audio/voice system; Higgsfield
is a visual/film-production system with character consistency, cinematic control, and native audio.
For faceless stories, narration quality affects every second, while expensive cinematic shots may
only affect selected beats. Spend on ElevenLabs first if the placeholder voice is clearly hurting
retention. Add Higgsfield after the narrative has proof, then use it for hero scenes rather than
automatically generating every second.

## Current official references

Verified on 2026-07-23:

- [YouTube channel monetization policies](https://support.google.com/youtube/answer/1311392?hl=en-EN)
- [YouTube Partner Program eligibility](https://support.google.com/youtube/answer/72851)
- [YouTube three-minute Shorts](https://support.google.com/youtube/answer/15424877)
- [YouTube synthetic-content disclosure](https://support.google.com/youtube/answer/14328491)
- [YouTube mid-roll eligibility](https://support.google.com/youtube/answer/6175006)
- [TikTok Creator Rewards announcement and eligibility](https://newsroom.tiktok.com/introducing-the-new-creator-rewards-program?lang=en)
- [TikTok AI-generated content policy](https://support.tiktok.com/en/using-tiktok/creating-videos/ai-generated-content)
- [TikTok Next 2026 trend report](https://newsroom.tiktok.com/introducing-tiktok-next-2026-our-trend-forecast-for-marketers-for-the-year-ahead?lang=en)
- [Higgsfield Cinema Studio 3.0](https://higgsfield.ai/blog/cinema-studio-3)
- [ElevenLabs API billing](https://elevenlabs.io/docs/overview/administration/billing)
- [ElevenLabs pricing](https://elevenlabs.io/pricing)
- [Pexels API](https://www.pexels.com/api/documentation/)
- [Zernio pricing](https://docs.zernio.com/pricing)
- [Zernio account connections](https://docs.zernio.com/guides/connecting-accounts)
- [Ayrshare pricing](https://www.ayrshare.com/pricing/)
- [YouTube Data API video uploads](https://developers.google.com/youtube/v3/guides/uploading_a_video)
- [TikTok Content Posting API](https://developers.tiktok.com/doc/content-posting-api-get-started)

Higgsfield V1 uses a reviewable manual production manifest. Jarvis must not assume or reverse
engineer a generation API; a programmatic adapter requires separate verification of official API
documentation.
