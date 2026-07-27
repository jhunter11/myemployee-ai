# Content anchors

A task that cites `src/task-market/x402-runtime.ts:503` is wrong the moment anyone inserts a line
above 503, and it fails silently — the citation still resolves, just to the wrong code. Anchors
replace line numbers with content-addressed references that drift only when the anchored content
itself changes, which is exactly when a citing task should be re-verified.

## Syntax

In Markdown, the marker sits on its own line and the anchored sentence is the next non-empty line:

```markdown
<!-- @anchor tm.mcp.batch-surface -->

The MCP endpoint accepts JSON-RPC arrays and dispatches each element independently.
```

In source files, the sentence follows a dash separator on the same line:

```ts
// @anchor tm.mcp.batch-surface - transport accepts JSON-RPC arrays and fans out per element
```

Anchor ids are dotted, lowercase, and namespaced by area: `^[a-z][a-z0-9]*(\.[a-z0-9][a-z0-9-]*)+$`.
Use the lane prefix the work belongs to (`tm.` for task market, `ag.` for agency).

Fenced code blocks are skipped by the scanner, so documenting the convention — including this file —
never registers an anchor.

## The arity rule

A lookup returns a verdict determined entirely by how many times the anchor appears:

| Occurrences | Verdict     | Meaning                                                        |
| ----------- | ----------- | -------------------------------------------------------------- |
| exactly 1   | `resolved`  | Evidence found; current line number is derived, never stored.  |
| 0           | `missing`   | The anchored content was deleted. Hard failure, not a warning. |
| 2 or more   | `ambiguous` | The convention was violated; the anchor identifies nothing.    |

Uniqueness is the whole mechanism. An anchor that appears twice is worse than no anchor, because it
looks authoritative while pointing at two different things.

## Digests

Each anchor carries a digest of its sentence, normalized by collapsing whitespace and lowercasing,
so that reflowing or re-indenting does not read as a meaning change. A task records the digest it
was verified against, giving three states:

- **digest matches** — evidence unchanged, task stays verified at zero token cost;
- **digest differs** — the sentence was reworded, so the task needs semantic re-verification;
- **unresolvable** — the anchor is missing or ambiguous, so the task fails verification.

This is what makes semantic verification a one-time cost per task rather than a per-run cost.
Steady-state re-verification is a hash comparison.

## Placing anchors

Anchor the claim, not the implementation. A good anchor marks the sentence a task is _about_ — the
behaviour, invariant, or defect — so that changing unrelated code nearby does not invalidate it.

Do not anchor:

- lines that change for formatting reasons;
- generated files, fixtures, or vendored code;
- anything inside a fenced example.

## Enforcement

`npm run code:index` reports duplicate ids and malformed anchors, and
`tests/knowledge/anchors.test.ts` fails the release gate when the repository contains an ambiguous
or malformed anchor. A convention that is not enforced by CI decays into false confidence within
weeks, so the test is the convention.
