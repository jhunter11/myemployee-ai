# Reference Checkouts — `.reference/`

Upstream repositories cloned for **design and pattern reference only**. Nothing here is built,
imported, linted, typechecked, graphed, or deployed. `.reference/` is gitignored; these checkouts
are re-cloned per machine, never committed.

The rule is one-directional: we read patterns out of `.reference/` and write our own code by hand.
No file is ever copied across wholesale, and no dependency is added to `package.json` because a
reference checkout uses it.

## Current checkouts

| Path                                         | Upstream                                                | License | Kept for                                                                      |
| -------------------------------------------- | ------------------------------------------------------- | ------- | ----------------------------------------------------------------------------- |
| `.reference/next-shadcn-dashboard-starter/`  | [Kiranism/next-shadcn-dashboard-starter][starter]        | MIT     | shadcn/ui component composition, dashboard layout & IA, data-table and form patterns, OKLCH theming |

[starter]: https://github.com/Kiranism/next-shadcn-dashboard-starter

### Why this one is reference-only and not adopted

The starter is Next.js 16 / React 19 / Tailwind v4 with **Clerk** auth and **Sentry** error
tracking. Two hard conflicts with this repo:

- **Hosted third-party services.** Clerk and Sentry both require external accounts and keys. Jarvis
  is a fail-closed local-first control plane with its own secrets/auth plane (`npm run auth:status`);
  adding a hosted identity provider would cut against that.
- **Stack mismatch.** This repo is `"type": "commonjs"` on Express 5 with a `tsc` build. The
  dashboard at `public/dashboard/` is ~8k lines of hand-written vanilla JS/CSS with its own widget
  registry, served by `express.static` from `src/dashboard/routes.ts`. Grafting the starter in would
  be a rewrite of working code, not an install.

What we take instead: layout structure, component anatomy, spacing and theming decisions, and
table/form interaction patterns — reimplemented in our own stack.

## Useful paths inside the starter

- `src/components/ui/` — shadcn primitives as composed by this starter
- `src/features/` — per-feature `api/types.ts` → `api/service.ts` → `api/queries.ts` layering
- `docs/themes.md` — OKLCH color system and font configuration
- `docs/forms.md` — composable field / multi-step form patterns
- `REFERENCE-AGENTS.md` — the starter's own full stack and convention writeup

## Bundled instruction files are neutralized

The starter ships its own `CLAUDE.md` and `AGENTS.md`. Those describe a **different** project and
contradict our conventions (it mandates single quotes and no trailing comma; our `.prettierrc`
governs this repo). Left in place they would be auto-discovered as project instructions for any
agent reading files in that directory, so they are renamed to `REFERENCE-CLAUDE.md` and
`REFERENCE-AGENTS.md` — still readable, no longer auto-loaded.

**Re-apply this after every update**, because `git pull` restores the original filenames.

## Adding or refreshing a checkout

```bash
git clone --depth 1 <url> .reference/<name>
```

Refresh an existing one, then re-neutralize any instruction files:

```bash
git -C .reference/next-shadcn-dashboard-starter pull --depth 1
```

Ignore coverage is already wired for the whole `.reference/` tree: `.gitignore`, `.prettierignore`,
`.graphifyignore`, and the Impeccable detector (`.impeccable/config.json` → `ignoreFiles`). ESLint
and `tsc` only ever see `src`, `tests`, and `clients`, so they need no entry.
