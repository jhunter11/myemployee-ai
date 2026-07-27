import type SQLite from 'better-sqlite3';

import type { ModelProviderId } from './contracts';

const RESET_GRACE_MS = 5 * 60_000;
const UNKNOWN_RESET_COOLDOWN_MS = 60 * 60_000;
export const MAX_PROVIDER_CLAIM_LEASE_MS = 630_000;
const PROVIDERS = new Set<ModelProviderId>(['claude', 'codex', 'gemini']);

export type ProviderRateLimitCircuitState = 'open' | 'half_open';

export interface ProviderRateLimitCircuitRecord {
  provider: ModelProviderId;
  state: ProviderRateLimitCircuitState;
  detectedAt: number;
  resetAt: number | null;
  notBefore: number;
  lastCheckedAt: number;
  /** Present only while one bounded half-open trial owns the provider claim. */
  claimExpiresAt: number | null;
}

export interface ProviderRateLimitClaim {
  allowed: boolean;
  halfOpen: boolean;
  /** Earliest safe retry when this caller did not win the claim. */
  retryAt: number | null;
  /** Fencing token required to complete a half-open claim. */
  claimToken: number | null;
}

interface StoredCircuitRecord {
  provider: ModelProviderId;
  state: ProviderRateLimitCircuitState;
  detected_at: number;
  reset_at: number | null;
  not_before: number;
  last_checked_at: number;
  claim_expires_at: number | null;
}

function assertProvider(provider: ModelProviderId): void {
  if (!PROVIDERS.has(provider)) {
    throw new TypeError('provider must be a registered subscription provider');
  }
}

function timestamp(value: number, field: string, requiredHeadroom = 0): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > Number.MAX_SAFE_INTEGER - requiredHeadroom
  ) {
    throw new TypeError(`${field} must be a non-negative safe integer timestamp`);
  }
  return value;
}

function claimLease(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PROVIDER_CLAIM_LEASE_MS) {
    throw new TypeError(`leaseMs must be an integer between 1 and ${MAX_PROVIDER_CLAIM_LEASE_MS}`);
  }
  return value;
}

function record(row: StoredCircuitRecord): ProviderRateLimitCircuitRecord {
  return {
    provider: row.provider,
    state: row.state,
    detectedAt: row.detected_at,
    resetAt: row.reset_at,
    notBefore: row.not_before,
    lastCheckedAt: row.last_checked_at,
    claimExpiresAt: row.claim_expires_at
  };
}

/**
 * Durable, host-global cooldown state for provider subscription rate limits.
 *
 * A missing row is a closed circuit and permits an ordinary call. An open row
 * suppresses calls until `notBefore`. At that boundary a compare-and-set admits
 * exactly one half-open trial; every other caller continues to its fallback.
 * Only bounded provider/timestamp metadata is persisted.
 */
export class ProviderRateLimitCircuit {
  private readonly clock: () => number;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly sqlite: SQLite.Database,
    options: { clock?: () => number } = {}
  ) {
    this.clock = options.clock ?? Date.now;
  }

  claim(provider: ModelProviderId, leaseMsInput: number): ProviderRateLimitClaim {
    assertProvider(provider);
    const leaseMs = claimLease(leaseMsInput);
    const now = this.now(leaseMs);
    const claimExpiresAt = now + leaseMs;
    const result = this.sqlite.transaction(
      ():
        | { claim: ProviderRateLimitClaim; changed: true }
        | { claim: ProviderRateLimitClaim; changed: false } => {
        const claimed = this.sqlite
          .prepare(
            `UPDATE provider_rate_limit_circuits
              SET state = 'half_open',
                  last_checked_at = ?,
                  claim_expires_at = ?
            WHERE provider = ?
              AND (
                (state = 'open' AND not_before <= ?) OR
                (
                  state = 'half_open' AND
                  claim_expires_at IS NOT NULL AND
                  claim_expires_at <= ?
                )
              )`
          )
          .run(now, claimExpiresAt, provider, now, now);
        if (claimed.changes === 1) {
          return {
            claim: {
              allowed: true,
              halfOpen: true,
              retryAt: null,
              claimToken: claimExpiresAt
            },
            changed: true
          };
        }

        const existing = this.sqlite
          .prepare(
            `SELECT state, not_before, claim_expires_at
             FROM provider_rate_limit_circuits
            WHERE provider = ?`
          )
          .get(provider) as
          | {
              state: ProviderRateLimitCircuitState;
              not_before: number;
              claim_expires_at: number | null;
            }
          | undefined;
        if (existing === undefined) {
          return {
            claim: {
              allowed: true,
              halfOpen: false,
              retryAt: null,
              claimToken: null
            },
            changed: false
          };
        }

        const retryAt =
          existing.state === 'open'
            ? timestamp(existing.not_before, 'notBefore')
            : timestamp(existing.claim_expires_at ?? Number.NaN, 'claimExpiresAt');
        return {
          claim: {
            allowed: false,
            halfOpen: false,
            retryAt,
            claimToken: null
          },
          changed: false
        };
      }
    )();

    if (result.changed) this.notifyChanged();
    return result.claim;
  }

  open(
    provider: ModelProviderId,
    input: { detectedAt: number; resetAt: number | null },
    claimTokenInput?: number
  ): void {
    assertProvider(provider);
    const detectedAt = timestamp(input.detectedAt, 'detectedAt', UNKNOWN_RESET_COOLDOWN_MS);
    const resetAt =
      input.resetAt !== null &&
      Number.isSafeInteger(input.resetAt) &&
      input.resetAt > detectedAt &&
      input.resetAt <= Number.MAX_SAFE_INTEGER - RESET_GRACE_MS
        ? input.resetAt
        : null;
    const notBefore =
      resetAt === null ? detectedAt + UNKNOWN_RESET_COOLDOWN_MS : resetAt + RESET_GRACE_MS;

    if (claimTokenInput !== undefined) {
      const claimToken = timestamp(claimTokenInput, 'claimToken');
      const reopened = this.sqlite
        .prepare(
          `UPDATE provider_rate_limit_circuits
              SET state = 'open',
                  detected_at = CASE
                    WHEN ? >= not_before THEN ?
                    ELSE detected_at
                  END,
                  reset_at = CASE
                    WHEN ? >= not_before THEN ?
                    ELSE reset_at
                  END,
                  not_before = MAX(not_before, ?),
                  last_checked_at = MAX(last_checked_at, ?),
                  claim_expires_at = NULL
            WHERE provider = ?
              AND state = 'half_open'
              AND claim_expires_at = ?`
        )
        .run(
          notBefore,
          detectedAt,
          notBefore,
          resetAt,
          notBefore,
          detectedAt,
          provider,
          claimToken
        );
      if (reopened.changes === 1) this.notifyChanged();
      return;
    }

    const opened = this.sqlite
      .prepare(
        `INSERT INTO provider_rate_limit_circuits (
           provider, state, detected_at, reset_at, not_before, last_checked_at,
           claim_expires_at
         ) VALUES (?, 'open', ?, ?, ?, ?, NULL)
         ON CONFLICT(provider) DO UPDATE SET
           state = 'open',
           detected_at = CASE
             WHEN excluded.not_before >= provider_rate_limit_circuits.not_before
               THEN excluded.detected_at
             ELSE provider_rate_limit_circuits.detected_at
           END,
           reset_at = CASE
             WHEN excluded.not_before >= provider_rate_limit_circuits.not_before
               THEN excluded.reset_at
             ELSE provider_rate_limit_circuits.reset_at
           END,
           not_before = MAX(
             provider_rate_limit_circuits.not_before,
             excluded.not_before
           ),
           last_checked_at = MAX(
             provider_rate_limit_circuits.last_checked_at,
             excluded.last_checked_at
           ),
           claim_expires_at = NULL
         WHERE provider_rate_limit_circuits.state = 'open'`
      )
      .run(provider, detectedAt, resetAt, notBefore, detectedAt);
    if (opened.changes === 1) this.notifyChanged();
  }

  close(provider: ModelProviderId, claimTokenInput: number): void {
    assertProvider(provider);
    const claimToken = timestamp(claimTokenInput, 'claimToken');
    const closed = this.sqlite
      .prepare(
        `DELETE FROM provider_rate_limit_circuits
          WHERE provider = ?
            AND state = 'half_open'
            AND claim_expires_at = ?`
      )
      .run(provider, claimToken);
    if (closed.changes === 1) this.notifyChanged();
  }

  release(provider: ModelProviderId, claimTokenInput: number): void {
    assertProvider(provider);
    const claimToken = timestamp(claimTokenInput, 'claimToken');
    const now = this.now();
    const released = this.sqlite
      .prepare(
        `UPDATE provider_rate_limit_circuits
            SET state = 'open',
                last_checked_at = MAX(last_checked_at, ?),
                claim_expires_at = NULL
          WHERE provider = ?
            AND state = 'half_open'
            AND claim_expires_at = ?`
      )
      .run(now, provider, claimToken);
    if (released.changes === 1) this.notifyChanged();
  }

  listDue(): ProviderRateLimitCircuitRecord[] {
    const now = this.now();
    const rows = this.sqlite
      .prepare(
        `SELECT provider, state, detected_at, reset_at, not_before, last_checked_at,
                claim_expires_at
           FROM provider_rate_limit_circuits
          WHERE (state = 'open' AND not_before <= ?)
             OR (
               state = 'half_open' AND
               claim_expires_at IS NOT NULL AND
               claim_expires_at <= ?
             )
          ORDER BY CASE
                     WHEN state = 'open' THEN not_before
                     ELSE claim_expires_at
                   END,
                   provider`
      )
      .all(now, now) as StoredCircuitRecord[];
    return rows.map(record);
  }

  /**
   * Returns the next boundary requiring reconciliation. For an open circuit this
   * is its original cooldown evidence (`not_before`); for an in-flight half-open
   * trial it is the bounded claim expiry.
   */
  nextNotBefore(): number | null {
    const now = this.now();
    const row = this.sqlite
      .prepare(
        `SELECT MIN(effective_at) AS next_not_before
           FROM (
             SELECT CASE
                      WHEN state = 'open' THEN not_before
                      ELSE claim_expires_at
                    END AS effective_at
               FROM provider_rate_limit_circuits
           )
          WHERE effective_at > ?`
      )
      .get(now) as { next_not_before: number | null };
    return row.next_not_before === null ? null : timestamp(row.next_not_before, 'nextNotBefore');
  }

  /**
   * Subscribes to successful durable state changes. Listener failures are
   * contained after the SQLite write and can never roll it back.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.listeners.delete(listener);
    };
  }

  private notifyChanged(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // Durable state is authoritative; an observer cannot invalidate it.
      }
    }
  }

  private now(requiredHeadroom = 0): number {
    return timestamp(this.clock(), 'clock', requiredHeadroom);
  }
}
