import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import SQLite from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDatabase } from '../../src/db/database';
import {
  ProviderRateLimitCircuit,
  type ProviderRateLimitCircuitRecord
} from '../../src/models/provider-rate-limit-circuit';

const projectRoot = join(__dirname, '..', '..');
const migrationPath = join(
  projectRoot,
  'src',
  'db',
  'migrations',
  '021_provider_rate_limit_circuits.sql'
);

describe('durable provider rate-limit circuit', () => {
  let sqlite: SQLite.Database;
  let now: number;
  let circuit: ProviderRateLimitCircuit;

  beforeEach(async () => {
    sqlite = new SQLite(':memory:');
    sqlite.exec(await readFile(migrationPath, 'utf8'));
    now = 1_800_000_000_000;
    circuit = new ProviderRateLimitCircuit(sqlite, { clock: () => now });
  });

  afterEach(() => {
    sqlite.close();
  });

  function rows(): ProviderRateLimitCircuitRecord[] {
    return sqlite
      .prepare(
        `SELECT provider, state, detected_at, reset_at, not_before, last_checked_at,
                claim_expires_at
           FROM provider_rate_limit_circuits
          ORDER BY provider`
      )
      .all()
      .map((row) => {
        const stored = row as {
          provider: ProviderRateLimitCircuitRecord['provider'];
          state: ProviderRateLimitCircuitRecord['state'];
          detected_at: number;
          reset_at: number | null;
          not_before: number;
          last_checked_at: number;
          claim_expires_at: number | null;
        };
        return {
          provider: stored.provider,
          state: stored.state,
          detectedAt: stored.detected_at,
          resetAt: stored.reset_at,
          notBefore: stored.not_before,
          lastCheckedAt: stored.last_checked_at,
          claimExpiresAt: stored.claim_expires_at
        };
      });
  }

  it('allows ordinary calls when no circuit row exists', () => {
    expect(circuit.claim('claude', 30_000)).toEqual({
      allowed: true,
      halfOpen: false,
      retryAt: null,
      claimToken: null
    });
    expect(circuit.listDue()).toEqual([]);
    expect(circuit.nextNotBefore()).toBeNull();
  });

  it('uses a trustworthy future reset plus five minutes and admits exactly one half-open trial', () => {
    const detectedAt = now;
    const resetAt = detectedAt + 20 * 60_000;
    circuit.open('claude', { detectedAt, resetAt });

    const notBefore = resetAt + 5 * 60_000;
    expect(circuit.nextNotBefore()).toBe(notBefore);
    expect(circuit.claim('claude', 30_000)).toEqual({
      allowed: false,
      halfOpen: false,
      retryAt: notBefore,
      claimToken: null
    });
    expect(circuit.listDue()).toEqual([]);

    now = notBefore;
    expect(circuit.listDue()).toEqual([
      {
        provider: 'claude',
        state: 'open',
        detectedAt,
        resetAt,
        notBefore,
        lastCheckedAt: detectedAt,
        claimExpiresAt: null
      }
    ]);
    expect(circuit.claim('claude', 30_000)).toEqual({
      allowed: true,
      halfOpen: true,
      retryAt: null,
      claimToken: notBefore + 30_000
    });
    expect(circuit.claim('claude', 30_000)).toEqual({
      allowed: false,
      halfOpen: false,
      retryAt: notBefore + 30_000,
      claimToken: null
    });
    expect(circuit.listDue()).toEqual([]);
    expect(circuit.nextNotBefore()).toBe(notBefore + 30_000);
    expect(rows()[0]).toMatchObject({
      state: 'half_open',
      lastCheckedAt: notBefore,
      claimExpiresAt: notBefore + 30_000
    });
  });

  it('falls back to one hour for missing, stale, or invalid reset timestamps', () => {
    const detectedAt = now;
    circuit.open('claude', { detectedAt, resetAt: null });
    circuit.open('codex', { detectedAt, resetAt: detectedAt });
    circuit.open('gemini', { detectedAt, resetAt: Number.NaN });

    expect(rows()).toEqual([
      {
        provider: 'claude',
        state: 'open',
        detectedAt,
        resetAt: null,
        notBefore: detectedAt + 60 * 60_000,
        lastCheckedAt: detectedAt,
        claimExpiresAt: null
      },
      {
        provider: 'codex',
        state: 'open',
        detectedAt,
        resetAt: null,
        notBefore: detectedAt + 60 * 60_000,
        lastCheckedAt: detectedAt,
        claimExpiresAt: null
      },
      {
        provider: 'gemini',
        state: 'open',
        detectedAt,
        resetAt: null,
        notBefore: detectedAt + 60 * 60_000,
        lastCheckedAt: detectedAt,
        claimExpiresAt: null
      }
    ]);
  });

  it('releases only a half-open claim and closes a recovered provider by deleting its row', () => {
    circuit.open('codex', { detectedAt: now, resetAt: null });
    now += 60 * 60_000;

    const firstClaim = circuit.claim('codex', 30_000);
    expect(firstClaim).toMatchObject({ allowed: true, halfOpen: true });
    expect(firstClaim.claimToken).not.toBeNull();
    circuit.release('codex', firstClaim.claimToken as number);
    expect(rows()[0]).toMatchObject({
      state: 'open',
      lastCheckedAt: now,
      claimExpiresAt: null
    });
    const secondClaim = circuit.claim('codex', 30_000);
    expect(secondClaim).toMatchObject({ allowed: true, halfOpen: true });
    expect(secondClaim.claimToken).not.toBeNull();

    circuit.close('codex', secondClaim.claimToken as number);
    expect(rows()).toEqual([]);
    expect(circuit.claim('codex', 30_000)).toMatchObject({ allowed: true, halfOpen: false });
  });

  it('returns due open records in deterministic order and ignores an in-flight half-open row', () => {
    circuit.open('gemini', { detectedAt: now - 3_600_000, resetAt: null });
    circuit.open('claude', { detectedAt: now - 3_900_000, resetAt: null });
    circuit.open('codex', { detectedAt: now - 3_700_000, resetAt: null });

    expect(circuit.claim('codex', 30_000)).toMatchObject({ allowed: true, halfOpen: true });
    expect(circuit.listDue().map(({ provider }) => provider)).toEqual(['claude', 'gemini']);
    expect(circuit.nextNotBefore()).toBe(now + 30_000);
  });

  it('schedules the earliest future boundary even while another open circuit remains due', () => {
    circuit.open('claude', { detectedAt: now - 60 * 60_000, resetAt: null });
    const futureResetAt = now + 10 * 60_000;
    circuit.open('codex', { detectedAt: now, resetAt: futureResetAt });

    expect(circuit.listDue().map(({ provider }) => provider)).toEqual(['claude']);
    expect(circuit.nextNotBefore()).toBe(futureResetAt + 5 * 60_000);
  });

  it('reclaims an expired half-open lease after restart and atomically fences a second claimant', () => {
    circuit.open('claude', { detectedAt: now - 3_600_000, resetAt: null });
    expect(circuit.claim('claude', 30_000)).toMatchObject({ allowed: true, halfOpen: true });
    expect(circuit.listDue()).toEqual([]);
    expect(circuit.nextNotBefore()).toBe(now + 30_000);

    now += 30_000;
    expect(circuit.listDue()).toEqual([
      expect.objectContaining({
        provider: 'claude',
        state: 'half_open',
        claimExpiresAt: now
      })
    ]);

    const restartedA = new ProviderRateLimitCircuit(sqlite, { clock: () => now });
    const restartedB = new ProviderRateLimitCircuit(sqlite, { clock: () => now });
    const claims = [restartedA.claim('claude', 45_000), restartedB.claim('claude', 45_000)];
    expect(claims.filter(({ allowed }) => allowed)).toHaveLength(1);
    expect(claims.filter(({ retryAt }) => retryAt === now + 45_000)).toHaveLength(1);
    expect(circuit.listDue()).toEqual([]);
    expect(circuit.nextNotBefore()).toBe(now + 45_000);
  });

  it('fences stale claim completion after a newer claimant wins the expired lease', () => {
    circuit.open('claude', { detectedAt: now - 60 * 60_000, resetAt: null });
    const stale = circuit.claim('claude', 30_000);
    expect(stale.claimToken).toBe(now + 30_000);

    now += 30_000;
    const current = circuit.claim('claude', 45_000);
    expect(current.claimToken).toBe(now + 45_000);
    const currentRow = rows()[0];

    circuit.close('claude', stale.claimToken as number);
    circuit.release('claude', stale.claimToken as number);
    circuit.open(
      'claude',
      { detectedAt: now, resetAt: now + 60 * 60_000 },
      stale.claimToken as number
    );
    circuit.open('claude', {
      detectedAt: now,
      resetAt: now + 90 * 60_000
    });
    expect(rows()[0]).toEqual(currentRow);

    circuit.close('claude', current.claimToken as number);
    expect(rows()).toEqual([]);
  });

  it('validates a bounded lease and rejects timestamp addition overflow', () => {
    expect(() => circuit.claim('claude', 0)).toThrow(/leaseMs/);
    expect(circuit.claim('claude', 630_000)).toMatchObject({ allowed: true });
    expect(() => circuit.claim('claude', 630_001)).toThrow(/leaseMs/);

    const overflow = new ProviderRateLimitCircuit(sqlite, {
      clock: () => Number.MAX_SAFE_INTEGER - 999
    });
    expect(() => overflow.claim('claude', 1_000)).toThrow(/clock/);
  });

  it('rejects the local provider at runtime without creating circuit state', () => {
    expect(() => circuit.claim('ollama', 30_000)).toThrow(/subscription provider/);
    expect(() => circuit.open('ollama', { detectedAt: now, resetAt: null })).toThrow(
      /subscription provider/
    );
    expect(rows()).toEqual([]);
  });

  it('keeps the longest cooldown and its evidence when quota failures finish out of order', () => {
    const longResetAt = now + 60 * 60_000;
    circuit.open('claude', { detectedAt: now, resetAt: longResetAt });
    const expectedNotBefore = longResetAt + 5 * 60_000;

    const laterDetection = now + 5_000;
    circuit.open('claude', {
      detectedAt: laterDetection,
      resetAt: laterDetection + 5 * 60_000
    });

    expect(rows()).toEqual([
      {
        provider: 'claude',
        state: 'open',
        detectedAt: now,
        resetAt: longResetAt,
        notBefore: expectedNotBefore,
        lastCheckedAt: laterDetection,
        claimExpiresAt: null
      }
    ]);
  });

  it('notifies state changes without letting a listener failure break durable updates', () => {
    const observed: string[] = [];
    const unsubscribe = circuit.subscribe(() => {
      observed.push('first');
      throw new Error('listener failed');
    });
    circuit.subscribe(() => observed.push('second'));

    circuit.open('claude', { detectedAt: now, resetAt: null });
    expect(rows()).toHaveLength(1);
    expect(observed).toEqual(['first', 'second']);

    unsubscribe();
    circuit.open('codex', { detectedAt: now, resetAt: null });
    expect(observed).toEqual(['first', 'second', 'second']);
  });

  it('rejects invalid detection timestamps without persisting state', () => {
    expect(() =>
      circuit.open('claude', { detectedAt: Number.POSITIVE_INFINITY, resetAt: null })
    ).toThrow(/detectedAt/);
    expect(rows()).toEqual([]);
  });

  it('registers the circuit migration in the global database composition', async () => {
    const database = await createDatabase({ projectRoot, filename: ':memory:' });
    try {
      const columns = database.sqlite
        .prepare('PRAGMA table_info(provider_rate_limit_circuits)')
        .all()
        .map((row) => (row as { name: string }).name);
      expect(columns).toEqual([
        'provider',
        'state',
        'detected_at',
        'reset_at',
        'not_before',
        'last_checked_at',
        'claim_expires_at'
      ]);
    } finally {
      await database.destroy();
    }
  });
});
