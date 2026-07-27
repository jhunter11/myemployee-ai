# Objections and Acceptance

## Honest objection responses

### “Our CRM already does this.”

That may mean there is no fit. Ask to see the existing daily workflow at a high level. Proceed only
if there is a specific manual gap that the CRM cannot economically solve; do not sell duplicate
automation.

### “I do not want AI deciding which homeowners matter.”

The pilot uses written deterministic rules and a human-reviewed output. It does not ask a model to
invent a score, reject a homeowner, or contact anyone. If the buyer cannot express acceptable rules,
do not run the pilot.

### “We cannot expose customer data.”

Start with synthetic data. A real sample is optional until the signed data boundary, minimized fields,
secure transfer, retention, and deletion are approved. If policy prohibits the export, stop.

### “Storm volume changes too much.”

The pilot has explicit row and byte caps and fails closed rather than silently dropping work. Size the
contract against both normal and storm-day volume before activation; expansion requires a new scope.

### “$750 is too much for a test.”

Do not discount before validating value. Narrow the scope or decline. The first month covers one
source, written rules, a compartment, evidence, shadow operation, and one revision; it does not carry
an ROI promise.

### “Can you guarantee more booked roofs?”

No. The deliverable is reliable triage under agreed rules. Bookings depend on lead quality, sales
response, pricing, weather, and other factors Jarvis does not control.

### “Can it text every lead immediately?”

Not in this pilot. Automated customer communications introduce consent, content, deliverability, and
recovery risks. They require separate legal, policy, and implementation review.

### “How long will setup take?”

Do not quote a date until the export and rules are inspected. After that, provide a written milestone
plan. Missing or unstable fields pause the schedule rather than expanding scope silently.

### “What happens when it fails?”

The run records failure evidence and does not publish an unrecognized or partial report. The human
owner uses the existing source system; no CRM state or homeowner message is changed by this pilot.

### “Why not just use a spreadsheet filter?”

If a saved filter reliably solves the workflow, use it. The pilot is justified only when repeatable
execution, bounded failure handling, evidence, and delivery remove meaningful recurring work.

## Acceptance criteria

The pilot is accepted only when all items below have named buyer and agency reviewers.

### Contract and data

- One authoritative source, export owner, schema version, maximum rows, and maximum bytes are written.
- Every accepted field has purpose, type, validation, retention, and output treatment.
- Qualification rules are deterministic examples, not prose delegated to a model.
- Synthetic acceptance rows cover each rule branch before real data enters the compartment.

### Functional result

- Every valid source row is accounted for exactly once in the run totals.
- Expected qualified rows match the signed rule table on the acceptance fixture.
- Replaying identical normalized input and rules produces identical business content; timestamps and
  run IDs may differ.
- Malformed, oversized, missing, changed, or unsafe-path input fails without publishing a new report.
- A successful API result equals the committed report artifact.

### Isolation and recovery

- The worker is bound to the exact client and registered automation.
- Raw client rows do not appear in global Markdown memory, Graphify, dashboard summaries, logs, or
  model telemetry.
- Interrupted staging recovers to a recognized prior or candidate artifact and records bounded
  evidence.
- The operator can stop the workflow and complete the agreed deletion/offboarding procedure.

### Commercial truth

- The buyer signs the $750 first-month scope before invoicing or real-data work.
- Any payment state is backed by actual invoice/payment evidence.
- **No revenue claim**, conversion claim, booked-roof claim, ROI claim, or profit claim is inferred
  from processed rows.
- Continuation at $1,250/month requires a separate explicit approval after first-month review.

## Stop / no-go conditions

Stop outreach or delivery on any explicit refusal, opt-out, uncertain channel permission, missing
decision authority, unsafe data path, untestable qualification rule, tenant-boundary failure,
unresolved artifact mismatch, request for autonomous customer contact, or demand for guaranteed
financial results.

The send gate remains `blocked_pending_operator_review` until a human approves one exact external
action. Approval to review is not approval to send.
