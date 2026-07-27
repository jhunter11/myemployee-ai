# First-client local bootstrap

Run from the repository root. The operator command defaults to a read-only dry run:

```sh
npm run revenue:first-client
```

Review the bounded JSON result, especially `reviewGatePlans` and the persisted proposed amount of
zero. To seed the validated records into the local SQLite ledger, add the explicit apply flag:

```sh
npm run revenue:first-client -- --apply
```

`--apply` is idempotent. It keeps all prospects at `identified`, creates no offer or outreach row,
and permits no sending, fetching, calling, payment, wallet, settlement, or revenue recognition. It
also creates two tenant-`jarvis` review queue entries that are excluded from automation-only queue
claims. The x402 contract and evidence remain simulation-only.

Use `--project-root`, `--pack`, and `--database` only with absolute, normalized paths when operating
on a non-default checkout or database. Unknown flags fail closed and errors do not echo paths or
input values.
