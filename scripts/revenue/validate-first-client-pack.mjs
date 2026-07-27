#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(scriptDirectory, '..', '..');
const packPath = join(projectRoot, 'docs', 'revenue', 'first-client-pack.json');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function isHttpsUrl(value) {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

const pack = JSON.parse(await readFile(packPath, 'utf8'));

assert(pack.schema === 'jarvis.first-client-pack.v1', 'Unexpected pack schema');
assert(pack.asOf === '2026-07-18', 'Research date must be explicit');
assert(pack.purpose === 'review_only_first_client_acquisition', 'Pack must be review-only');

const range = pack.offer?.blueprintMonthlyRange;
const pilot = pack.offer?.foundingPilot;
assert(range?.minimumUsd === 500, 'Blueprint minimum must be $500');
assert(range?.minimumMicrousd === range.minimumUsd * 1_000_000, 'Minimum micro-USD mismatch');
assert(range?.maximumUsd === 2_000, 'Blueprint maximum must be $2,000');
assert(range?.maximumMicrousd === range.maximumUsd * 1_000_000, 'Maximum micro-USD mismatch');
assert(pilot?.firstMonthUsd === 750, 'Founding first month must be $750');
assert(
  pilot?.firstMonthMicrousd === pilot.firstMonthUsd * 1_000_000,
  'Founding first-month micro-USD mismatch'
);
assert(pilot?.standardMonthlyUsd === 1_250, 'Standard continuation must be $1,250');
assert(
  pilot?.standardMonthlyMicrousd === pilot.standardMonthlyUsd * 1_000_000,
  'Standard monthly micro-USD mismatch'
);
assert(pilot?.externalPaymentState === 'blocked', 'External payment must remain blocked');

const gate = pack.sendGate;
assert(gate?.state === 'blocked_pending_operator_review', 'Outbound gate must be blocked');
assert(gate?.operatorApprovalRequired === true, 'Operator approval must be required');
assert(gate?.automationMaySend === false, 'Automation must not send');
assert(gate?.formsMayBeSubmitted === false, 'Automation must not submit forms');
assert(gate?.callsMayBePlaced === false, 'Automation must not place calls');

assert(Array.isArray(pack.prospects), 'Prospects must be an array');
assert(pack.prospects.length === 10, 'Pack must contain exactly ten prospects');
assert(new Set(pack.prospects.map(({ id }) => id)).size === 10, 'Prospect IDs must be unique');
assert(
  new Set(pack.prospects.map(({ contactPageUrl }) => contactPageUrl)).size === 10,
  'Contact-page URLs must be unique'
);

for (const prospect of pack.prospects) {
  assert(prospect.status === 'research_only', `${prospect.id}: status must be research_only`);
  assert(typeof prospect.businessLabel === 'string', `${prospect.id}: business label missing`);
  assert(prospect.locationLabel === 'Charlotte metro, NC', `${prospect.id}: market mismatch`);
  assert(isHttpsUrl(prospect.contactPageUrl), `${prospect.id}: invalid contact-page URL`);
  assert(
    prospect.qualification?.maximumScore === 5 &&
      prospect.qualification.score >= 3 &&
      prospect.qualification.score <= 5,
    `${prospect.id}: invalid public-fit score`
  );
  assert(
    Array.isArray(prospect.provenanceUrls) && prospect.provenanceUrls.length > 0,
    `${prospect.id}: provenance missing`
  );
  assert(
    prospect.provenanceUrls.every(isHttpsUrl),
    `${prospect.id}: provenance must use HTTPS URLs`
  );
}

const serialized = JSON.stringify(pack);
assert(!/@[A-Za-z0-9.-]+/.test(serialized), 'Personal or role email data is forbidden');
assert(
  !/"(?:email|phone|personalName|ownerName)"\s*:/i.test(serialized),
  'Personal contact fields are forbidden'
);

process.stdout.write(
  `PASS first-client pack: ${pack.prospects.length} research-only prospects; outbound blocked\n`
);
