(function (root, factory) {
  'use strict';

  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.JarvisRevenueWidget = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  const PROSPECT_STATUSES = ['identified', 'qualified', 'paused', 'archived'];
  const OFFER_STATUSES = ['draft', 'review_ready', 'reviewed', 'archived'];

  function safeObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  function safeArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function safeCount(value) {
    return Number.isSafeInteger(value) && value > 0 ? value : 0;
  }

  function plural(value, word) {
    return `${value} ${word}${value === 1 ? '' : 's'}`;
  }

  function label(value) {
    return String(value).replace(/_/g, ' ');
  }

  function statusSummary(items, statuses) {
    return statuses
      .map((status) => [status, items.filter((item) => safeObject(item).status === status).length])
      .filter(([, count]) => count > 0)
      .map(([status, count]) => `${count} ${label(status)}`)
      .join(', ');
  }

  function entitySummary(total, word, items, statuses) {
    const base = plural(total, word);
    const summary = statusSummary(items, statuses);
    if (!summary) return base;
    return `${base} (${summary}${items.length === total ? '' : ' in returned records'})`;
  }

  function formatUsd(amountMicrousd) {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 6
    }).format(safeCount(amountMicrousd) / 1_000_000);
  }

  function proposedValue(offers) {
    return offers.reduce((total, item) => {
      const quote = safeObject(safeObject(item).quote);
      return quote.basis === 'proposed' ? total + safeCount(quote.amountMicrousd) : total;
    }, 0);
  }

  function prospectContactNote(prospect) {
    return safeObject(prospect).hasContactReference === true
      ? ' · contact reference present (details withheld)'
      : '';
  }

  function outreachReviewSummary(agencyInput) {
    const agency = safeObject(agencyInput);
    const drafts = safeArray(agency.outreachDrafts);
    const declaredTotal = safeCount(safeObject(agency.counts).outreachDrafts);
    return {
      readyForReview: drafts.filter((draft) => safeObject(draft).status === 'review_ready').length,
      reviewed: drafts.filter((draft) => safeObject(draft).status === 'reviewed').length,
      returned: drafts.length,
      total: Math.max(declaredTotal, drafts.length)
    };
  }

  function agencyCard(lanes) {
    const agency = safeObject(lanes.agency);
    const counts = safeObject(agency.counts);
    const prospects = safeArray(agency.prospects);
    const offers = safeArray(agency.offers);
    return {
      title: 'Agency pipeline',
      content: `${entitySummary(safeCount(counts.prospects), 'prospect', prospects, PROSPECT_STATUSES)} · ${entitySummary(safeCount(counts.offers), 'proposed offer', offers, OFFER_STATUSES)} · ${formatUsd(proposedValue(offers))} bounded proposal value · recognized revenue: none.`
    };
  }

  function contractSummary(activation) {
    if (!['contract_only', 'simulation'].includes(activation.state)) {
      return 'Contract: not initialized';
    }
    const digest = /^[a-f0-9]{64}$/.test(activation.contractDigest)
      ? ` (${activation.contractDigest.slice(0, 12)})`
      : '';
    return `Contract: ${label(activation.state)}${digest}`;
  }

  function simulationSummary(simulations) {
    if (!simulations.length) return 'simulation evidence: 0 returned';
    const passed = simulations.filter((item) => safeObject(item).outcome === 'pass').length;
    return `simulation evidence: ${passed}/${simulations.length} pass`;
  }

  function taskMarketCard(lanes) {
    const taskMarket = safeObject(lanes.task_market);
    const activation = safeObject(taskMarket.activation);
    const x402 = safeObject(activation.x402);
    const quote = safeObject(x402.quote);
    const simulations = safeArray(taskMarket.simulations);
    const paymentMode = ['blocked', 'simulated'].includes(x402.paymentMode)
      ? x402.paymentMode
      : 'blocked';
    const quoteSummary =
      quote.basis === 'simulation'
        ? `${formatUsd(quote.amountMicrousd)} simulation quote`
        : 'no simulation quote';
    return {
      title: 'x402 / task market',
      content: `${contractSummary(activation)} · x402 mode: ${paymentMode} · ${quoteSummary} · ${simulationSummary(simulations)} · external payment: blocked · recognized revenue: none.`
    };
  }

  function revenuePipelineCards(revenue) {
    const lanes = safeObject(safeObject(revenue).lanes);
    return [agencyCard(lanes), taskMarketCard(lanes)];
  }

  return Object.freeze({ revenuePipelineCards, prospectContactNote, outreachReviewSummary });
});
