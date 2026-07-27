# Markdown graph memory workflow

Use this lane for memory notes, Obsidian compatibility, Graphify code traversal, graph indexes,
backlinks, recovery, scoped knowledge queries, or tenant memory.

## Architecture

- Keep the global graph under `memory/graph/` to agency metadata, client identifiers, automation metadata, run status, and operator page manifests.
- Keep tenant-private notes under `clients/<client_id>/memory/notes/`; never link their content into the global graph.
- Use Markdown with YAML frontmatter and `[[wiki-links]]`. Treat Obsidian as an optional viewer, not a runtime dependency.
- Treat `graph.json` as a generated, validated index. Markdown is the durable source of truth.
- Register harness, project, and client scopes before indexing. Resolve every query through the
  caller principal and its exact registered graph partition.
- Build the harness Graphify corpus from structural code only. Build each project or client index
  separately; never merge client-private content into the harness or another client graph.
- Disable Graphify query logging with `GRAPHIFY_QUERY_LOG_DISABLE=1` for client work unless the
  log itself is protected inside the exact same scope.
- Never expose Graphify MCP or `project_path` to a client agent. Give the agent only a scoped query
  capability whose filesystem path is server-controlled and absent from the returned DTO.

## Change safely

1. Inspect `src/memory/markdown-graph.ts`, `src/memory/graph-cli.ts`, and focused memory tests.
2. Add a failing test for the graph invariant or crash window.
3. Validate IDs, manifests, paths, sizes, and adjacency before exposing data.
4. Reject symlink traversal and duplicate or broken nodes.
5. Use atomic writes plus a durable journal for multi-file publication.
6. Rebuild with `npm run memory:graph -- --root .` and inspect the result.
7. For Graphify traversal, query only the exact registered graph partition, cap the output budget,
   and return allowlisted metadata or bounded excerpts.

## Verify

Test normal publication, idempotent retry, conflict, malformed input, symlink traversal, ordinary rollback, and startup recovery from every durable journal stage.
