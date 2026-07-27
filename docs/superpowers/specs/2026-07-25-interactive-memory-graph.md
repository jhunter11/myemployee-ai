# Interactive Memory and Code Graph

**Date:** 2026-07-25  
**Status:** implementation specification

## Orientation summary

**Domains involved:** scoped Markdown memory, harness code indexing, local dashboard interaction,
accessibility, browser performance, artifact freshness, and loopback operations.

**Key assumptions to validate:**

- The operator wants visual exploration and relationship discovery, not in-browser note editing.
- The existing validated Markdown index is sufficient for the memory topology.
- The ignored harness Graphify artifact may be visualized only through a strict server projection.
- A dependency-free canvas plus native controls can handle the current 896-node code graph.

**Stakeholder alignment needed:** no external alignment; this is a single-operator local surface.

**Existing constraints:** tenant-private notes never enter the global graph; browser requests cannot
select a tenant, path, scope, or Graphify partition; the dashboard CSP is self-only; Graphify output
is optional, host-specific, and may be stale.

**Attachment risk:** the visual “wow” must not turn into an unbounded animation, hide unavailable or
stale evidence, or weaken the tenant boundary.

**Ready for implementation:** yes. The requested attachment is the tactile Obsidian-like
exploration, not a particular visualization library.

## Decisions

1. `/api/v1/dashboard/graph` remains the Markdown source of truth and stays backward-compatible.
2. Graphify is a separate lazy read model at `/api/v1/dashboard/code-graph`.
3. The code-graph route accepts an empty query only and reads one server-fixed harness artifact:
   `graphify-out/graph.json`.
4. The server validates the raw artifact, then returns only bounded structural fields. It never
   serves Graphify HTML, reports, manifests, cache files, query logs, physical roots, excerpts,
   confidence, or semantic context.
5. Missing or invalid Graphify output disables only Code mode. Memory mode remains usable.
6. The visualization is a deterministic canvas constellation with native accessible controls and
   a native result/neighbor inspector.
7. Memory and Code modes retain independent selection. Reciprocal Markdown links draw once while
   the inspector preserves inbound and outbound evidence.

## Safe code-graph projection

The response carries:

- a fixed schema version, `source: "graphify"`, and `scope: "harness"`;
- artifact time and built commit, plus comparison with the repository HEAD when it is safely known;
- AST/code nodes with ID, title, repository-relative `src/` path, line, and community;
- extracted structural edges with allowlisted relation names;
- an explicit count of inferred/non-structural edges omitted from the projection.

The reader requires a regular non-symlink file no larger than 2 MiB, no more than 2,500 nodes and
10,000 links, unique bounded IDs, safe relative source paths, valid line/community values, and
complete adjacency. Any failed invariant makes the optional source unavailable.

## Interaction contract

- Switch between **Memory** and **Code · Graphify** without replacing the saved-page memory widget.
- Pan the background, zoom by wheel or labeled buttons, fit the graph, drag nodes, and click nodes.
- Search by title, ID, type, path, or relation metadata; cap only the DOM result list, not the
  already-bounded canvas graph.
- Show selected-node metadata and interactive neighbors.
- Explain loading, unavailable, empty, stale-revision, and truncated states without inventing data.
- At mobile width, keep the canvas bounded and touch gestures contained inside it; page scrolling
  remains available outside the graph.
- Respect reduced motion and expose selection through native controls rather than the canvas alone.

## Verification

- Unit-test Graphify projection, redaction, bounds, malformed adjacency, traversal, and symlinks.
- Unit-test graph normalization, reciprocal-link handling, deterministic layout, search, selection,
  pan/zoom, and hit testing.
- Test route query rejection, no-store headers, missing-source isolation, and static shell labels.
- Exercise Memory and Code modes live at desktop and 390 px, including keyboard controls, console
  errors, server errors, and horizontal overflow.
