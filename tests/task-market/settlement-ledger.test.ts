import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import SQLite from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  SettlementLedger,
  SuccessfulSettlementInputSchema
} from '../../src/task-market/settlement-ledger';

const settledAt = '2026-07-20T16:00:00.000Z';
const transactionHash = `0x${'a'.repeat(64)}`;
const payerAddress = `0x${'b'.repeat(40)}`;

function settlement(
  overrides: Partial<{
    schemaVersion: number;
    mode: string;
    productId: string;
    network: string;
    transactionHash: string;
    amountBaseUnits: string;
    payerAddress: string;
    settledAt: string;
  }> = {}
) {
  return {
    schemaVersion: 1,
    mode: 'testnet',
    productId: 'edge-validation-v1',
    network: 'base-sepolia',
    transactionHash,
    amountBaseUnits: '500000',
    payerAddress,
    settledAt,
    ...overrides
  };
}

describe('SettlementLedger', () => {
  let temporaryRoot: string;
  let databaseFile: string;
  let ledger: SettlementLedger | undefined;

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'jarvis-settlement-ledger-test-'));
    databaseFile = join(temporaryRoot, 'settlements.sqlite');
  });

  afterEach(async () => {
    ledger?.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  it('accepts only the strict successful exact-settlement contract', () => {
    expect(SuccessfulSettlementInputSchema.parse(settlement())).toEqual(settlement());

    const invalid: unknown[] = [
      { ...settlement(), schemaVersion: 2 },
      { ...settlement(), unknown: true },
      settlement({ mode: 'mainnet_blocked' }),
      settlement({ productId: 'other-product' }),
      settlement({ network: 'base' }),
      settlement({ mode: 'mainnet_enabled', network: 'base-sepolia' }),
      settlement({ transactionHash: `0x${'a'.repeat(63)}` }),
      settlement({ transactionHash: 'not-a-transaction' }),
      settlement({ amountBaseUnits: '0' }),
      settlement({ amountBaseUnits: '-1' }),
      settlement({ amountBaseUnits: '01' }),
      settlement({ amountBaseUnits: '1.5' }),
      settlement({ amountBaseUnits: '1e6' }),
      settlement({ amountBaseUnits: 'unknown' }),
      settlement({ amountBaseUnits: (1n << 256n).toString() }),
      settlement({ payerAddress: `0x${'b'.repeat(39)}` }),
      settlement({ settledAt: 'not-a-timestamp' })
    ];

    for (const input of invalid) {
      expect(() => SuccessfulSettlementInputSchema.parse(input)).toThrow();
    }
  });

  it('hashes a normalized payer address before persistence and never returns it', () => {
    ledger = new SettlementLedger(databaseFile);
    const mixedCasePayer = `0x${'Bb'.repeat(20)}`;

    const result = ledger.record(settlement({ payerAddress: mixedCasePayer }));

    expect(result).toMatchObject({
      status: 'recorded',
      settlement: {
        mode: 'testnet',
        productId: 'edge-validation-v1',
        network: 'base-sepolia',
        transactionHash,
        amountBaseUnits: '500000',
        payerPresent: true,
        settledAt
      }
    });
    expect(result.evidenceDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toContain(mixedCasePayer);
    ledger.close();
    ledger = undefined;

    const raw = new SQLite(databaseFile, { readonly: true });
    const row = raw
      .prepare(
        'SELECT payer_sha256, transaction_hash, amount_base_units FROM x402_successful_settlements'
      )
      .get() as Record<string, unknown>;
    raw.close();
    expect(row.payer_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(row)).not.toContain(mixedCasePayer);
    expect(row).toMatchObject({ transaction_hash: transactionHash, amount_base_units: '500000' });
  });

  it('returns duplicate for an exact replay without double counting', () => {
    ledger = new SettlementLedger(databaseFile);
    const first = ledger.record(settlement());
    const replay = ledger.record(settlement());

    expect(first.status).toBe('recorded');
    expect(replay).toEqual({ ...first, status: 'duplicate' });
    expect(ledger.summary().testnet.successfulSettlementCount).toBe(1);

    ledger.close();
    ledger = new SettlementLedger(databaseFile);
    expect(ledger.record(settlement())).toEqual({ ...first, status: 'duplicate' });
    expect(ledger.record(settlement({ settledAt: '2026-07-20T16:00:01.000Z' }))).toEqual({
      ...first,
      status: 'duplicate'
    });
    expect(ledger.summary().testnet.successfulSettlementCount).toBe(1);
  });

  it('rejects changed reuse of a network and transaction identity', () => {
    ledger = new SettlementLedger(databaseFile);
    ledger.record(settlement());

    for (const conflict of [
      settlement({ amountBaseUnits: '500001' }),
      settlement({ payerAddress: `0x${'c'.repeat(40)}` })
    ]) {
      expect(() => ledger?.record(conflict)).toThrow(
        'Settlement replay conflicts with stored evidence'
      );
    }
    expect(ledger.summary().testnet.successfulSettlementCount).toBe(1);
  });

  it('makes successful settlement rows append-only at the SQLite boundary', () => {
    ledger = new SettlementLedger(databaseFile);
    ledger.record(settlement());
    ledger.close();
    ledger = undefined;

    const raw = new SQLite(databaseFile);
    expect(() =>
      raw.prepare("UPDATE x402_successful_settlements SET amount_base_units = '1'").run()
    ).toThrow(/append-only/i);
    expect(() => raw.prepare('DELETE FROM x402_successful_settlements').run()).toThrow(
      /append-only/i
    );
    raw.close();
  });

  it('keeps testnet settlement totals separate and never recognizes them as revenue', () => {
    ledger = new SettlementLedger(databaseFile);
    ledger.record(settlement({ amountBaseUnits: '500000' }));

    const summary = ledger.summary();

    expect(summary).toEqual({
      schemaVersion: 1,
      testnet: {
        successfulSettlementCount: 1,
        settledAmountBaseUnits: '500000'
      },
      mainnet: {
        successfulSettlementCount: 0,
        facilitatorReportedAmountBaseUnits: '0',
        recognizedRevenue: {
          basis: 'requires_independent_chain_reconciliation',
          amountBaseUnits: '0',
          fiatValue: { basis: 'unknown' }
        }
      },
      economics: {
        settlementCost: { basis: 'unknown' },
        netRevenue: { basis: 'unknown' }
      }
    });
    expect(JSON.stringify(summary)).not.toMatch(/walletBalance|wallet_balance/i);
  });

  it('recognizes only exact mainnet settlement sums without Number precision loss', () => {
    ledger = new SettlementLedger(databaseFile);
    ledger.record(
      settlement({
        mode: 'mainnet_enabled',
        network: 'base',
        transactionHash: `0x${'c'.repeat(64)}`,
        amountBaseUnits: '9007199254740993',
        payerAddress: undefined
      })
    );
    ledger.record(
      settlement({
        mode: 'mainnet_enabled',
        network: 'base',
        transactionHash: `0x${'d'.repeat(64)}`,
        amountBaseUnits: '9007199254740997',
        payerAddress: undefined
      })
    );
    ledger.record(settlement({ amountBaseUnits: '999999999999999999' }));

    const summary = ledger.summary();

    expect(summary.testnet).toEqual({
      successfulSettlementCount: 1,
      settledAmountBaseUnits: '999999999999999999'
    });
    expect(summary.mainnet).toEqual({
      successfulSettlementCount: 2,
      facilitatorReportedAmountBaseUnits: '18014398509481990',
      recognizedRevenue: {
        basis: 'requires_independent_chain_reconciliation',
        amountBaseUnits: '0',
        fiatValue: { basis: 'unknown' }
      }
    });
    expect(summary.economics.settlementCost).toEqual({ basis: 'unknown' });
    expect(summary.economics.netRevenue).toEqual({ basis: 'unknown' });
  });

  it('refuses to attach the settlement tables to a non-dedicated database', () => {
    const raw = new SQLite(databaseFile);
    raw.exec('CREATE TABLE client_registry (id TEXT PRIMARY KEY)');
    raw.close();

    expect(() => new SettlementLedger(databaseFile)).toThrow(
      'Settlement ledger requires a dedicated database'
    );
  });
});
