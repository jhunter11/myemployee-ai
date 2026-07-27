# Hierarchy-scoped knowledge registry

## Orientation summary

- Domains: agent authorization, tenant isolation, SQLite metadata, code and memory retrieval, and future Graphify integration.
- Existing constraint: Jarvis already separates global operational metadata from client-private SQLite and Markdown memory.
- Core assumption: query callers need a scoped retrieval capability, not direct access to a repository or filesystem path.
- Concrete output: a hierarchy registry, a principal-bound query service, and an adapter contract keyed by an opaque graph partition.

## Scope hierarchy

| Bound principal | Exact scope                 | Descendant scope | Parent or sibling scope          |
| --------------- | --------------------------- | ---------------- | -------------------------------- |
| Harness         | Metadata or bounded excerpt | Metadata only    | Denied                           |
| Project         | Metadata or bounded excerpt | Metadata only    | Denied                           |
| Client          | Metadata or bounded excerpt | Not applicable   | Denied before adapter resolution |

The service is constructed with one principal. A query cannot provide or replace that principal. This makes the service instance a capability that can safely be injected into a sandboxed agent.

## Storage boundary

`knowledge_scopes` stores only identifiers and deterministic logical bindings:

- `knowledge/<kind>/<subject>` is a logical root key, never an absolute filesystem root.
- `graphify/<kind>/<subject>` is an opaque, unique graph partition.
- Client rows contain a client identifier and foreign key, not client content.
- The global database does not store indexed document bodies, source paths, or arbitrary graph metadata.

Actual code, Markdown, or graph data remains in the scope-specific store selected by an adapter. A Graphify adapter may privately map a partition to a preconfigured graph location, but `project_path`, arbitrary paths, and Graphify installation controls are absent from the query contract.

Every adapter must also declare one of two validated query-log controls:

- logging disabled with `GRAPHIFY_QUERY_LOG_DISABLE=1`; or
- a protected log partition that exactly matches the target graph partition.

The declared graph partition must match the registered target. A client adapter can therefore never be backed by Jarvis's shared harness graph at `graphify-out/graph.json`.

## Query boundary

1. Parse a strict request containing target scope, search text, projection, and limit.
2. For a client capability, reject any non-exact target before target lookup or adapter resolution.
3. Verify that the bound principal matches a registered scope.
4. Authorize only the exact scope or a registered descendant.
5. Downgrade every descendant content request to metadata.
6. Resolve the adapter by the registry-owned graph partition.
7. Copy only allowlisted fields into the result. Never return physical paths, arbitrary metadata, full content, or adapter-specific fields.

This seam supports separate Graphify graphs without making Graphify a global runtime dependency. Installing or enabling a specific Graphify implementation remains an explicit deployment decision after its code and filesystem policy are reviewed.
