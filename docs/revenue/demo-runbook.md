# Demo and Delivery Runbook

## What the current proof honestly demonstrates

The checked-in `acme_corp/daily-report` worker reads a bounded exact-schema CSV from its trusted
client directory, rejects unsafe or malformed input, selects rows whose status is `qualified`,
stages and atomically commits `output/report.json`, and records run/trace evidence. The synthetic
fixture has 10 rows and 5 qualified rows.

It does not yet prove a prospect's CRM integration, scheduled delivery, customer messaging, custom
qualification rules, or financial outcome. Say that before the demo.

## Five-minute synthetic proof

From the repository root:

```bash
npx vitest run tests/gateway/server.test.ts \
  -t "executes the checked-in acme daily report through the production registry" \
  --coverage.enabled=false
```

Expected result: one selected end-to-end test passes. The assertions require a successful registered
worker run, `sourceRows: 10`, `qualifiedCount: 5`, a committed report equal to the API result, a
Mermaid success trace, and a Markdown run note.

Show the synthetic source without exposing any real contact data:

```bash
sed -n '1,12p' clients/acme_corp/data/sample-leads.csv
```

All addresses in that fixture use the reserved `.test` domain. Never replace the fixture with a
prospect export during an introductory demo.

## Demo narrative

1. **Boundary:** “This worker is registered to one exact client and automation.”
2. **Input contract:** “Unexpected headers, statuses, sizes, symlinks, and paths fail closed.”
3. **Deterministic rule:** “`qualified` is an agreed input state, not an AI prediction.”
4. **Artifact:** “The same result is staged, committed, and returned.”
5. **Evidence:** “The run status, diagram, and Markdown note are independently asserted.”
6. **Commercial question:** “Would mapping your current export to this shape remove real manual
   work, or is your existing system already sufficient?”

Stop at ten minutes unless the buyer asks to continue. Do not show unrelated dashboard features,
PMQS, x402, remote access, or internal architecture during the first sales demo.

## Discovery-to-pilot runbook

### 1. Qualify before requesting data

- Complete the discovery rubric in `offer-and-qualification.md`.
- Identify the workflow owner, decision authority, one source, normal volume, fields, qualification
  rules, delivery recipient, retention period, and success measure.
- Disqualify if the buyer wants autonomous calls, model-made eligibility decisions, unbounded inbox
  access, or a revenue guarantee in the first pilot.

### 2. Sign the bounded scope

Record the price, term, one source, schema, rule table, run schedule, output fields, delivery method,
retention/deletion, support boundary, acceptance tests, and stop procedure. Proposed pricing is not
revenue until agreement and payment evidence exist.

### 3. Build with synthetic rows first

- Scaffold an exact client compartment.
- Create 10–20 synthetic rows covering every accepted and rejected rule branch.
- Write failing tests for the client's schema and acceptance table before adapting the worker.
- Verify no source row, output, error body, or private note reaches global memory or telemetry.

### 4. Accept one minimal real sample

Use the agreed secure transfer mechanism; never ask for data over an outreach channel. Minimize
fields, cap rows and bytes, document retention, and keep the sample in the exact client compartment.
Re-run boundary, malformed-input, recovery, and expected-output tests.

### 5. Shadow before relying

For at least three agreed business days, generate the brief without changing CRM state or contacting
homeowners. The client's named reviewer compares it with the source export and signs exceptions.

### 6. Review first-month evidence

Report observed runs, success/failure, source rows, qualified rows under the agreed rules, exceptions,
and measured delivery cost. Do not infer sales, ROI, or recovered revenue. Continue at $1,250/month
only with explicit buyer approval.

### 7. Offboard cleanly

Stop the schedule, export only agreed buyer artifacts, revoke access, delete data according to the
signed retention rule, preserve only bounded audit evidence, and record completion. A cancellation
must never depend on a model or sales approval.

## Demo failure rule

If any test, tenant boundary, report comparison, or recovery check is red, do not improvise around
it. Label the demo unsuccessful, preserve bounded evidence, fix and re-run locally, then request a new
review.
