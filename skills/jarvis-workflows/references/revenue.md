# Revenue workflow

Use this lane for prospects, offers, outreach drafts, first-client readiness, x402, A2A, or the
task-market lane.

## Work toward evidence, not simulated revenue

- Separate the AI agency and task-market lanes while sharing bounded queue and economics evidence.
- Record real prospect provenance, fit evidence, an offer, a reviewed draft, and status transitions.
- Never send outreach, submit forms, publish offers, charge a buyer, or represent earnings without
  explicit user authority for that external action.
- Do not store wallet private keys or payment secrets in Jarvis. Keep x402 in contract or simulation
  mode first; testnet requires an explicit gate and mainnet remains blocked until a separate reviewed
  enablement record exists.
- Treat A2A as task discovery/lifecycle and x402 as a payment gate. Do not claim either protocol is
  a marketplace by itself.

## Build the next useful artifact

1. Inspect the current proof automation, target customer, and offer economics.
2. Prefer a narrow deliverable with deterministic acceptance criteria and a reversible pilot.
3. Store bounded outreach drafts locally with review state; keep private contact data out of global
   memory and telemetry.
4. Queue the next operator-approved step with a visible reason and cost ceiling.
5. Report pipeline counts and evidence separately from booked or collected revenue.

## Verify

Test strict state transitions, provenance, duplicate prospects, tenant isolation, redaction,
simulation-only payment states, and denial of outbound or mainnet actions.
