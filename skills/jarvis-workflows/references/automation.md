# Client automation workflow

Use this lane for workers, client scaffolding, policies, execution, artifacts, escalation, or recovery.

## Inspect

- `src/agents/contracts.ts`, `worker-registry.ts`, and `supervisor.ts` define execution ownership.
- `src/config/policies.ts` and checked-in YAML define tool and network authority.
- `src/clients/` owns tenant lifecycle and filesystem boundaries.
- `clients/<client_id>/automations/` owns client-specific worker code.
- Run, audit, frequency, graph, and Mermaid repositories provide durable evidence.

## Implement

1. Define input, output, side effects, and failure evidence before editing code.
2. Register a worker only for the exact client and automation pair.
3. Require the complete transaction lifecycle when a worker publishes artifacts: execute/stage, commit, rollback, and release.
4. Use exclusive creation, no-follow descriptors, bounded reads, ownership checks, atomic replacement, and restart recovery for tenant files.
5. Enforce deny-first tool and network policy. Never broaden authority to make a test pass.
6. Record run status, audit evidence, memory, diagram, and frequency without leaking raw tenant inputs or outputs.

## Verify

Test success, worker failure, evidence failure, concurrent finalize/rollback, restart recovery, symlink and size races, tenant mismatch, and bounded API responses.
