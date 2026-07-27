import { createHash } from 'node:crypto';

import SQLite from 'better-sqlite3';
import { z } from 'zod';

const PRODUCT_ID = 'edge-validation-v1' as const;
const TESTNET_NETWORK = 'base-sepolia' as const;
const MAINNET_NETWORK = 'base' as const;
const TABLE_NAME = 'x402_successful_settlements';
const UINT256_MAX = (1n << 256n) - 1n;
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const TransactionHashSchema = z.string().regex(/^0x[a-fA-F0-9]{64}$/);
const PayerAddressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
const BaseUnitAmountSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,77}$/)
  .refine((value) => BigInt(value) <= UINT256_MAX, 'amount exceeds the uint256 limit');

export const SuccessfulSettlementInputSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    mode: z.enum(['testnet', 'mainnet_enabled']),
    productId: z.literal(PRODUCT_ID),
    network: z.enum([TESTNET_NETWORK, MAINNET_NETWORK]),
    transactionHash: TransactionHashSchema,
    amountBaseUnits: BaseUnitAmountSchema,
    payerAddress: PayerAddressSchema.optional(),
    settledAt: z.iso.datetime()
  })
  .superRefine((settlement, context) => {
    const expectedNetwork = settlement.mode === 'testnet' ? TESTNET_NETWORK : MAINNET_NETWORK;
    if (settlement.network !== expectedNetwork) {
      context.addIssue({
        code: 'custom',
        path: ['network'],
        message: 'network does not match settlement mode'
      });
    }
  });

export type SuccessfulSettlementInput = z.infer<typeof SuccessfulSettlementInputSchema>;

interface NormalizedSettlement {
  mode: SuccessfulSettlementInput['mode'];
  productId: typeof PRODUCT_ID;
  network: SuccessfulSettlementInput['network'];
  transactionHash: string;
  amountBaseUnits: string;
  payerSha256: string | null;
  settledAt: string;
  evidenceDigest: string;
}

export interface SettlementReceipt {
  status: 'recorded' | 'duplicate';
  evidenceDigest: string;
  settlement: {
    mode: SuccessfulSettlementInput['mode'];
    productId: typeof PRODUCT_ID;
    network: SuccessfulSettlementInput['network'];
    transactionHash: string;
    amountBaseUnits: string;
    payerPresent: boolean;
    settledAt: string;
  };
}

export interface SettlementSummary {
  schemaVersion: 1;
  testnet: {
    successfulSettlementCount: number;
    settledAmountBaseUnits: string;
  };
  mainnet: {
    successfulSettlementCount: number;
    facilitatorReportedAmountBaseUnits: string;
    recognizedRevenue: {
      basis: 'requires_independent_chain_reconciliation';
      amountBaseUnits: string;
      fiatValue: { basis: 'unknown' };
    };
  };
  economics: {
    settlementCost: { basis: 'unknown' };
    netRevenue: { basis: 'unknown' };
  };
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS x402_successful_settlements (
  id INTEGER PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  settlement_status TEXT NOT NULL CHECK (settlement_status = 'successful'),
  payment_scheme TEXT NOT NULL CHECK (payment_scheme = 'exact'),
  mode TEXT NOT NULL CHECK (mode IN ('testnet', 'mainnet_enabled')),
  product_id TEXT NOT NULL CHECK (product_id = 'edge-validation-v1'),
  network TEXT NOT NULL CHECK (network IN ('base-sepolia', 'base')),
  transaction_hash TEXT NOT NULL
    CHECK (
      length(transaction_hash) = 66 AND
      substr(transaction_hash, 1, 2) = '0x' AND
      substr(transaction_hash, 3) NOT GLOB '*[^a-f0-9]*'
    ),
  amount_base_units TEXT NOT NULL
    CHECK (
      length(amount_base_units) BETWEEN 1 AND 78 AND
      amount_base_units NOT GLOB '*[^0-9]*' AND
      substr(amount_base_units, 1, 1) BETWEEN '1' AND '9'
    ),
  payer_sha256 TEXT
    CHECK (
      payer_sha256 IS NULL OR
      (length(payer_sha256) = 64 AND payer_sha256 NOT GLOB '*[^a-f0-9]*')
    ),
  settled_at TEXT NOT NULL CHECK (unixepoch(settled_at) IS NOT NULL),
  evidence_sha256 TEXT NOT NULL
    CHECK (length(evidence_sha256) = 64 AND evidence_sha256 NOT GLOB '*[^a-f0-9]*'),
  UNIQUE (network, transaction_hash),
  CHECK (
    (mode = 'testnet' AND network = 'base-sepolia') OR
    (mode = 'mainnet_enabled' AND network = 'base')
  )
);

CREATE TRIGGER IF NOT EXISTS x402_successful_settlements_no_update
BEFORE UPDATE ON x402_successful_settlements
BEGIN
  SELECT RAISE(ABORT, 'x402 successful settlements are append-only');
END;

CREATE TRIGGER IF NOT EXISTS x402_successful_settlements_no_delete
BEFORE DELETE ON x402_successful_settlements
BEGIN
  SELECT RAISE(ABORT, 'x402 successful settlements are append-only');
END;
`;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function payerDigest(address: string | undefined): string | null {
  return address === undefined ? null : sha256(`jarvis.x402.payer.v1:${address.toLowerCase()}`);
}

function canonicalSettlement(settlement: Omit<NormalizedSettlement, 'evidenceDigest'>): string {
  return JSON.stringify({
    schemaVersion: 1,
    settlementStatus: 'successful',
    paymentScheme: 'exact',
    mode: settlement.mode,
    productId: settlement.productId,
    network: settlement.network,
    transactionHash: settlement.transactionHash,
    amountBaseUnits: settlement.amountBaseUnits,
    payerSha256: settlement.payerSha256
  });
}

function normalize(rawInput: unknown): NormalizedSettlement {
  const input = SuccessfulSettlementInputSchema.parse(rawInput);
  const normalized = {
    mode: input.mode,
    productId: PRODUCT_ID,
    network: input.network,
    transactionHash: input.transactionHash.toLowerCase(),
    amountBaseUnits: input.amountBaseUnits,
    payerSha256: payerDigest(input.payerAddress),
    settledAt: new Date(input.settledAt).toISOString()
  } as const;
  return { ...normalized, evidenceDigest: sha256(canonicalSettlement(normalized)) };
}

function receipt(
  settlement: NormalizedSettlement,
  status: SettlementReceipt['status']
): SettlementReceipt {
  return {
    status,
    evidenceDigest: settlement.evidenceDigest,
    settlement: {
      mode: settlement.mode,
      productId: settlement.productId,
      network: settlement.network,
      transactionHash: settlement.transactionHash,
      amountBaseUnits: settlement.amountBaseUnits,
      payerPresent: settlement.payerSha256 !== null,
      settledAt: settlement.settledAt
    }
  };
}

function assertDedicatedDatabase(database: SQLite.Database): void {
  const tables = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )
    .all() as Array<{ name: string }>;
  if (tables.some(({ name }) => name !== TABLE_NAME)) {
    throw new Error('Settlement ledger requires a dedicated database');
  }
}

function safeAmount(value: unknown): bigint {
  const parsed = BaseUnitAmountSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error('Settlement ledger contains an invalid amount');
  }
  return BigInt(parsed.data);
}

export class SettlementLedger {
  private readonly database: SQLite.Database;
  private closed = false;

  constructor(filename: string) {
    const database = new SQLite(filename);
    try {
      assertDedicatedDatabase(database);
      database.exec(SCHEMA_SQL);
      this.database = database;
    } catch (error) {
      database.close();
      throw error;
    }
  }

  record(rawInput: unknown): SettlementReceipt {
    const settlement = normalize(rawInput);
    const performRecord = this.database.transaction(() => {
      const insertion = this.database
        .prepare(
          `INSERT OR IGNORE INTO x402_successful_settlements (
            schema_version, settlement_status, payment_scheme, mode, product_id,
            network, transaction_hash, amount_base_units, payer_sha256,
            settled_at, evidence_sha256
          ) VALUES (1, 'successful', 'exact', ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          settlement.mode,
          settlement.productId,
          settlement.network,
          settlement.transactionHash,
          settlement.amountBaseUnits,
          settlement.payerSha256,
          settlement.settledAt,
          settlement.evidenceDigest
        );
      if (insertion.changes === 1) return receipt(settlement, 'recorded');

      const existingRaw = this.database
        .prepare(
          `SELECT evidence_sha256 AS evidenceDigest, settled_at AS settledAt
           FROM x402_successful_settlements
           WHERE network = ? AND transaction_hash = ?`
        )
        .get(settlement.network, settlement.transactionHash) as
        { evidenceDigest: unknown; settledAt: unknown } | undefined;
      const existing = z
        .strictObject({ evidenceDigest: Sha256Schema, settledAt: z.iso.datetime() })
        .safeParse(existingRaw);
      if (!existing.success) {
        throw new Error('Settlement ledger could not verify replay evidence');
      }
      if (existing.data.evidenceDigest !== settlement.evidenceDigest) {
        throw new Error('Settlement replay conflicts with stored evidence');
      }
      return receipt(
        { ...settlement, settledAt: new Date(existing.data.settledAt).toISOString() },
        'duplicate'
      );
    });
    return performRecord();
  }

  summary(): SettlementSummary {
    const rows = this.database
      .prepare('SELECT mode, amount_base_units AS amountBaseUnits FROM x402_successful_settlements')
      .all() as Array<{ mode: unknown; amountBaseUnits: unknown }>;
    let testnetCount = 0;
    let mainnetCount = 0;
    let testnetAmount = 0n;
    let mainnetAmount = 0n;

    for (const row of rows) {
      const amount = safeAmount(row.amountBaseUnits);
      if (row.mode === 'testnet') {
        testnetCount += 1;
        testnetAmount += amount;
      } else if (row.mode === 'mainnet_enabled') {
        mainnetCount += 1;
        mainnetAmount += amount;
      } else {
        throw new Error('Settlement ledger contains an invalid mode');
      }
    }

    return {
      schemaVersion: 1,
      testnet: {
        successfulSettlementCount: testnetCount,
        settledAmountBaseUnits: testnetAmount.toString()
      },
      mainnet: {
        successfulSettlementCount: mainnetCount,
        facilitatorReportedAmountBaseUnits: mainnetAmount.toString(),
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
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }
}
