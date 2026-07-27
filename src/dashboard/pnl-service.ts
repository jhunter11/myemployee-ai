/**
 * Operator P&L projection: per-sleeve and system-wide.
 *
 * Two deliberate accounting constraints are load-bearing here, and both keep
 * this projection from overstating the business.
 *
 * **Revenue is never recognized.** Every revenue surface in this repository
 * reports `revenueRecognition: 'none'` (src/revenue/contracts.ts, the pipeline
 * repository, the first-client bootstrap). No settlement has been verified, so
 * this service reports recognized revenue as exactly 0 and carries the pipeline
 * count alongside it as a separate, explicitly unrecognized figure. Pipeline
 * value is never added into a net line.
 *
 * **Expenses are only counted where dollars are known.** Per ADR-003 / SPEC §15
 * a flat-rate subscription call has a genuinely unknown per-call cost, so it is
 * reported as uncovered rather than as $0. A net line is therefore only
 * meaningful when coverage is `complete`; the `netIsComplete` flag says whether
 * it is, instead of silently presenting a partial number as final.
 */

import type { SleeveExpenseRollup, SleeveExpenseTotals } from '../db/model-usage-repository';

export interface PnlRevenueReader {
  /**
   * Counts of pipeline entries per lane. Deliberately counts, not amounts:
   * an unrecognized pipeline has no defensible dollar value.
   */
  pipelineCounts(): Promise<{ agency: number; taskMarket: number }>;
}

export interface SleevePnlRow {
  sleeveId: string;
  label: string;
  expense: {
    knownMicroUsd: number;
    coverage: 'none' | 'partial' | 'complete';
    /** Calls whose dollar cost is genuinely unknown (subscription/unknown basis). */
    uncoveredEvents: number;
    requestCount: number;
  };
  revenue: {
    recognizedMicroUsd: 0;
    recognition: 'none';
  };
  /** recognizedRevenue - knownExpense. Negative while revenue stays unrecognized. */
  netMicroUsd: number;
  /** False when uncovered spend means the net line is a floor, not a total. */
  netIsComplete: boolean;
}

export interface PnlSnapshot {
  generatedAt: string;
  currency: 'USD';
  recognition: 'none';
  sleeves: SleevePnlRow[];
  system: SleevePnlRow;
  pipeline: {
    recognized: false;
    agencyCount: number;
    taskMarketCount: number;
  };
  /** Operator-facing statement of why revenue reads zero. Rendered verbatim. */
  disclosure: string;
}

const DISCLOSURE =
  'Recognized revenue is 0 because no settlement has been verified anywhere in this system. ' +
  'Pipeline entries are counts only and are never valued or added to net. ' +
  'Expenses count known dollars only; subscription and unknown-basis calls are reported as uncovered.';

function labelForSleeve(sleeveId: string): string {
  if (sleeveId === 'system') return 'System (no tenant sleeve)';
  return `${sleeveId} sleeve`;
}

function rowFrom(sleeveId: string, label: string, totals: SleeveExpenseTotals): SleevePnlRow {
  return {
    sleeveId,
    label,
    expense: {
      knownMicroUsd: totals.knownMicroUsd,
      coverage: totals.coverage,
      uncoveredEvents: totals.uncoveredEvents,
      requestCount: totals.requestCount
    },
    revenue: { recognizedMicroUsd: 0, recognition: 'none' },
    // Recognized revenue is structurally 0, so net is the negation of known spend.
    netMicroUsd: -totals.knownMicroUsd,
    netIsComplete: totals.uncoveredEvents === 0
  };
}

export interface PnlServiceOptions {
  expenses: { sleeveExpenseRollup(): Promise<SleeveExpenseRollup> };
  revenue?: PnlRevenueReader;
  /** ISO-8601 clock, matching the gateway's injected `now`. */
  now?: () => string;
}

export class PnlService {
  constructor(private readonly options: PnlServiceOptions) {}

  async snapshot(): Promise<PnlSnapshot> {
    const generatedAt = this.options.now?.() ?? new Date().toISOString();
    const [rollup, pipeline] = await Promise.all([
      this.options.expenses.sleeveExpenseRollup(),
      this.options.revenue?.pipelineCounts() ?? Promise.resolve({ agency: 0, taskMarket: 0 })
    ]);

    return {
      generatedAt,
      currency: 'USD',
      recognition: 'none',
      sleeves: rollup.sleeves.map((sleeve) =>
        rowFrom(sleeve.sleeveId, labelForSleeve(sleeve.sleeveId), sleeve)
      ),
      system: rowFrom('__system__', 'All sleeves', rollup.system),
      pipeline: {
        recognized: false,
        agencyCount: pipeline.agency,
        taskMarketCount: pipeline.taskMarket
      },
      disclosure: DISCLOSURE
    };
  }
}
