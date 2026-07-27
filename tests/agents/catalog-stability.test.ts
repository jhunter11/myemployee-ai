import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { listAgentProfiles } from '../../src/agents/profile-catalog';
import baseline from './__fixtures__/catalog-baseline.json';

/**
 * V2 intentionally adds eleven approved static profiles: the missing Growth,
 * Delivery, and Knowledge roles plus the Finance and Marketing pods. This
 * suite pins that reviewed 45-profile catalog so any further behavioural drift
 * fails loudly.
 *
 * Never update the expected digest merely to match new output:
 * `ProfileAccessBootstrap` publishes the same digest as `catalogSha256`, so an
 * unreviewed catalog change invalidates every issued blueprint grant.
 */
const BASELINE_PROFILE_COUNT = 45;
const BASELINE_SHA256 = 'cdcffef38070d30bd49c85c886bdb1de7de887534a4b3d17e4afeb8abf0515d9';

describe('agent profile catalog stability', () => {
  it('generates the approved catalog byte-for-byte', () => {
    expect(listAgentProfiles()).toHaveLength(BASELINE_PROFILE_COUNT);
    expect(listAgentProfiles()).toEqual(baseline);
  });

  it('preserves the published catalog digest', () => {
    const digest = createHash('sha256')
      .update(JSON.stringify(listAgentProfiles()), 'utf8')
      .digest('hex');

    expect(digest).toBe(BASELINE_SHA256);
  });

  it('keeps profile ordering stable', () => {
    expect(listAgentProfiles().map(({ id }) => id)).toEqual(
      baseline.map(({ id }: { id: string }) => id)
    );
  });
});
