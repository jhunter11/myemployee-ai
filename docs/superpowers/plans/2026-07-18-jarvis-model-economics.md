# Jarvis Model Economics Implementation Plan

1. Add failing tests for the pure routing policy and context budgeter.
2. Implement strict economics contracts, a deterministic logical router, and provenance-preserving context selection.
3. Add a checked SQLite migration plus a repository that writes bounded call metadata and calculates honest aggregates.
4. Add failing dashboard/Page Studio tests for unavailable and populated economics states.
5. Wire the repository into the dashboard service and production composition.
6. Add the Economics view and declarative Page Studio widget without synthetic values.
7. Update the technical specification, operator documentation, and decision log.
8. Run focused tests, full coverage, typecheck, lint, format checks, build, memory-graph validation, and a live dashboard smoke test.
