# Jarvis Interface Language

## Direction: the operator's instrument

Jarvis should feel like a precise control instrument used at a desk for long sessions: calm, dark, legible, information-dense, and quietly distinctive. It must not resemble a neon sci-fi prop, a marketing site, or a grid of interchangeable SaaS cards.

## Signature

The persistent scope rail and authority map are the recognizable element. Every screen answers: where am I, whose data is this, what authority is active, and what needs me?

## Tokens

- Canvas `#090d12`; rail `#0c1117`; surface `#111820`; raised surface `#151e27`.
- Ink `#edf2f5`; muted `#c0cbd3`; quiet `#a4b1bb`.
- Primary signal `#7dd8c7`; approval amber `#e8ba70`; danger `#ef8e8e`; evidence blue `#91bde8`.
- Radius is 3px. Pills are reserved for small state labels, not containers.
- Body uses Avenir Next/Segoe UI fallback; utility labels use the platform monospace.

## Structure

- Desktop: scope/navigation rail → work surface → contextual inspector where needed.
- Mobile web: compact identity plus horizontally scrollable deep links; critical cards and metrics scroll within bounded regions. Telegram becomes the true on-the-go steering channel.
- Prefer bordered rows, timelines, stage rails, tables, and split workbenches over repeated cards.
- Chat uses Answer / Evidence / Trace / Artifacts / Approval tabs when those contracts exist.
- Agent views use purpose, scope, sleeve, lifecycle, current work, elapsed time, tokens, cost coverage, and reliability—not avatars.

## Interaction

- Controls are at least 44px where practical, have visible keyboard focus, and never depend on hover.
- Motion is one 200ms view transition and purposeful state feedback; reduced motion removes transforms.
- Loading, empty, stale-last-good, unavailable, blocked, and error are distinct states.
- Copy names the user's object and action. Planned controls are disabled and labeled; they do not simulate data.

## Avoid

Purple/pink AI palettes, gradient text, glass, huge hero metrics, nested cards, decorative charts, emoji icons, raw chain-of-thought, invented cost/time values, and visual hierarchy that hides tenant or authority boundaries.
