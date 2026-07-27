import { createRequire } from 'node:module';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

interface RevenueWidgetCard {
  title: string;
  content: string;
}

interface RevenueWidgetModule {
  revenuePipelineCards(revenue: unknown): RevenueWidgetCard[];
  prospectContactNote(prospect: unknown): string;
  outreachReviewSummary(agency: unknown): {
    readyForReview: number;
    reviewed: number;
    returned: number;
    total: number;
  };
}

const requireAsset = createRequire(__filename);
const widget = requireAsset(
  join(__dirname, '..', '..', 'public', 'dashboard', 'assets', 'revenue-widget.js')
) as RevenueWidgetModule;

describe('saved-page revenue pipeline widget', () => {
  it('renders honest Agency and x402/task-market evidence from only the fixed lanes', () => {
    const cards = widget.revenuePipelineCards({
      tenantId: 'should-not-render',
      privateNotes: 'should-not-render',
      lanes: {
        agency: {
          counts: { prospects: 2, offers: 2 },
          prospects: [
            { status: 'identified', contactReference: 'secret-contact' },
            { status: 'qualified', privateNotes: 'secret-note' }
          ],
          offers: [
            { status: 'draft', quote: { basis: 'proposed', amountMicrousd: 750_000_000 } },
            {
              status: 'review_ready',
              quote: { basis: 'proposed', amountMicrousd: 1_250_000_000 },
              paymentAction: 'charge-now'
            }
          ]
        },
        task_market: {
          activation: {
            state: 'simulation',
            contractDigest: 'a'.repeat(64),
            x402: {
              paymentMode: 'simulated',
              quote: { basis: 'simulation', amountMicrousd: 500_000 }
            }
          },
          simulations: [
            { outcome: 'pass', revenueRecognition: 'none' },
            { outcome: 'pass', revenueRecognition: 'none' },
            { outcome: 'fail', revenueRecognition: 'none' }
          ],
          safety: { externalPayment: 'blocked', revenueRecognition: 'none' }
        },
        acme_private: { privateNotes: 'must never be selected' }
      }
    });

    expect(cards).toHaveLength(2);
    expect(cards[0]).toEqual({
      title: 'Agency pipeline',
      content:
        '2 prospects (1 identified, 1 qualified) · 2 proposed offers (1 draft, 1 review ready) · $2,000.00 bounded proposal value · recognized revenue: none.'
    });
    expect(cards[1]).toEqual({
      title: 'x402 / task market',
      content:
        'Contract: simulation (aaaaaaaaaaaa) · x402 mode: simulated · $0.50 simulation quote · simulation evidence: 2/3 pass · external payment: blocked · recognized revenue: none.'
    });
    expect(JSON.stringify(cards)).not.toMatch(
      /tenant|acme|private|secret|contact|charge|send|wallet/i
    );
  });

  it('keeps missing data explicit without inventing offers, contracts, payments, or revenue', () => {
    expect(widget.revenuePipelineCards({ lanes: {} })).toEqual([
      {
        title: 'Agency pipeline',
        content:
          '0 prospects · 0 proposed offers · $0.00 bounded proposal value · recognized revenue: none.'
      },
      {
        title: 'x402 / task market',
        content:
          'Contract: not initialized · x402 mode: blocked · no simulation quote · simulation evidence: 0 returned · external payment: blocked · recognized revenue: none.'
      }
    ]);
  });

  it('does not describe opaque contact references or review-ready drafts as reviewed', () => {
    expect(
      widget.prospectContactNote({
        hasContactReference: true,
        contactReference: 'contact:must-not-render'
      })
    ).toBe(' · contact reference present (details withheld)');
    expect(widget.prospectContactNote({ hasContactReference: false })).toBe('');

    expect(
      widget.outreachReviewSummary({
        counts: { outreachDrafts: 6 },
        outreachDrafts: [
          { status: 'draft' },
          { status: 'review_ready' },
          { status: 'review_ready' },
          { status: 'reviewed' }
        ]
      })
    ).toEqual({ readyForReview: 2, reviewed: 1, returned: 4, total: 6 });
  });
});
