import { readFileSync } from 'fs';

const processors = JSON.parse(readFileSync(new URL('../rates/processors.json', import.meta.url)));
const interchangeTable = JSON.parse(readFileSync(new URL('../rates/interchange.json', import.meta.url)));

// Index interchange by card_mix_key for fast lookup
const interchangeByKey = {};
for (const row of interchangeTable) {
  interchangeByKey[row.card_mix_key] = row;
}

// ── Default card mixes by business type ───────────────────────────────────────
const DEFAULT_CARD_MIXES = {
  restaurant: {
    visa_credit_cp:  0.33, mc_credit_cp: 0.14, visa_rewards_cp: 0.05,
    mc_world_cp:     0.03, visa_debit_cp: 0.18, mc_debit_cp: 0.10,
    amex:            0.12, discover_cp: 0.05,
  },
  retail: {
    visa_credit_cp:  0.28, mc_credit_cp: 0.13, visa_rewards_cp: 0.05,
    mc_world_cp:     0.03, visa_debit_cp: 0.17, mc_debit_cp: 0.10,
    pin_debit:       0.08, amex: 0.10, discover_cp: 0.06,
  },
  ecommerce: {
    visa_credit_cnp: 0.32, mc_credit_cnp: 0.16, visa_debit_cnp: 0.13,
    mc_debit_cnp:    0.07, amex: 0.14, discover_cnp: 0.05,
    mc_world_cp:     0.08, visa_rewards_cp: 0.05,
  },
  services: {
    visa_credit_cp:  0.30, mc_credit_cp: 0.14, visa_rewards_cp: 0.06,
    mc_world_cp:     0.04, visa_debit_cp: 0.16, mc_debit_cp: 0.09,
    amex:            0.12, discover_cp: 0.05, visa_business_cp: 0.04,
  },
  default: {
    visa_credit_cp:  0.30, mc_credit_cp: 0.13, visa_rewards_cp: 0.05,
    mc_world_cp:     0.03, visa_debit_cp: 0.18, mc_debit_cp: 0.10,
    amex:            0.11, discover_cp: 0.05, pin_debit: 0.05,
  },
};

// ── Business type normalization ───────────────────────────────────────────────
const BUSINESS_TYPE_MAP = [
  { keywords: ['restaurant', 'cafe', 'bar', 'diner', 'food', 'bistro', 'pizza', 'grill'], type: 'restaurant' },
  { keywords: ['retail', 'store', 'shop', 'boutique', 'hardware', 'grocery'], type: 'retail' },
  { keywords: ['ecommerce', 'e-commerce', 'online', 'web', 'internet'], type: 'ecommerce' },
  { keywords: ['service', 'salon', 'spa', 'clinic', 'dental', 'auto', 'repair', 'consulting'], type: 'services' },
];

function normalizeBusinessType(raw) {
  if (!raw) return 'default';
  const lower = raw.toLowerCase();
  for (const { keywords, type } of BUSINESS_TYPE_MAP) {
    if (keywords.some(k => lower.includes(k))) return type;
  }
  return 'default';
}

// ── Resolve card mix ──────────────────────────────────────────────────────────
function resolveCardMix(statementData, businessType) {
  const base = DEFAULT_CARD_MIXES[businessType] ?? DEFAULT_CARD_MIXES.default;

  // If Claude extracted network-level percentages, use them to scale the default splits
  const { card_mix } = statementData;
  if (!card_mix) return { mix: base, source: `default_${businessType}` };

  const visa_pct    = (card_mix.visa_percent    ?? 0) / 100;
  const mc_pct      = (card_mix.mc_percent      ?? 0) / 100;
  const amex_pct    = (card_mix.amex_percent    ?? 0) / 100;
  const discover_pct = (card_mix.discover_percent ?? 0) / 100;
  const total = visa_pct + mc_pct + amex_pct + discover_pct;
  if (total < 0.5) return { mix: base, source: `default_${businessType}` }; // too sparse, use default

  // Distribute visa/mc across CP/CNP sub-categories using the same proportions as the default
  const isOnline = businessType === 'ecommerce';
  const result = {};

  if (visa_pct > 0) {
    const cpShare = isOnline ? 0.15 : 0.85;
    result.visa_credit_cp  = visa_pct * cpShare * 0.65;
    result.visa_debit_cp   = visa_pct * cpShare * 0.25;
    result.visa_rewards_cp = visa_pct * cpShare * 0.10;
    result.visa_credit_cnp = visa_pct * (1 - cpShare) * 0.70;
    result.visa_debit_cnp  = visa_pct * (1 - cpShare) * 0.30;
  }
  if (mc_pct > 0) {
    const cpShare = isOnline ? 0.15 : 0.85;
    result.mc_credit_cp  = mc_pct * cpShare * 0.65;
    result.mc_debit_cp   = mc_pct * cpShare * 0.25;
    result.mc_world_cp   = mc_pct * cpShare * 0.10;
    result.mc_credit_cnp = mc_pct * (1 - cpShare) * 0.70;
    result.mc_debit_cnp  = mc_pct * (1 - cpShare) * 0.30;
  }
  if (amex_pct > 0)    result.amex       = amex_pct;
  if (discover_pct > 0) result.discover_cp = discover_pct;

  return { mix: result, source: 'extracted' };
}

// ── Amex OptBlue rate lookup ──────────────────────────────────────────────────
function getAmexRate(processor, monthly_volume) {
  const annualVolume = monthly_volume * 12;
  for (const tier of processor.amex_optblue_tiers) {
    if (tier.max_annual_volume === null || annualVolume <= tier.max_annual_volume) {
      return tier.rate_bps;
    }
  }
  return processor.amex_optblue_tiers.at(-1).rate_bps;
}

// ── Pros / cons generation ────────────────────────────────────────────────────
function generateProsCons(statementData, processor, costResult, businessType) {
  const pros = [];
  const cons = [];
  const { monthly_savings } = costResult;

  if (processor.pci_fee === 0)               pros.push('No PCI compliance fee');
  if (processor.statement_fee === 0)         pros.push('No statement fee');
  if (processor.monthly_fee < 10)            pros.push('Low monthly account fee');
  if (processor.per_txn_cents <= 7)          pros.push('Low per-transaction cost');
  if (processor.early_termination === 0)     pros.push('No early termination fee');
  if (processor.equipment === 'free_terminal') pros.push('Free terminal included');
  if (processor.boarding_speed === 'same_day') pros.push('Same-day boarding');
  if (processor.supports_high_risk)          pros.push('Supports high-risk merchants');
  if (monthly_savings != null && monthly_savings > 300) pros.push('High savings potential for your volume');
  if (businessType === 'restaurant' && processor.name.includes('Kurv')) pros.push('Restaurant-optimized reporting');
  if (businessType === 'ecommerce' && processor.supported_business_types.includes('ecommerce')) pros.push('Full e-commerce gateway support');

  if (processor.statement_fee > 0)           cons.push(`$${processor.statement_fee}/mo statement fee`);
  if (processor.pci_fee > 12)               cons.push('Higher PCI compliance fee');
  if (processor.early_termination > 0)       cons.push(`$${processor.early_termination} early termination fee`);
  if (!processor.supported_business_types.includes(businessType) && businessType !== 'default') {
    cons.push('Not optimized for your business type');
  }
  if (monthly_savings != null && monthly_savings < 50)  cons.push('Modest savings — minimal switching incentive');
  if (processor.equipment === 'purchase')    cons.push('Terminal purchase required');

  if (pros.length === 0) pros.push('Competitive interchange-plus rates');
  if (cons.length === 0) cons.push('Newer to market — less name recognition');

  return { pros: pros.slice(0, 4), cons: cons.slice(0, 3) };
}

// ── Core per-processor cost calculation ──────────────────────────────────────
function computeProcessorCost(statementData, cardMix, cardMixSource, processor, agentMarginDecimal) {
  const { monthly_volume, transaction_count, total_fees } = statementData;

  let interchange_cost = 0;
  let per_txn_cost = 0;
  let amex_rate_bps = null;

  for (const [key, share] of Object.entries(cardMix)) {
    if (share <= 0) continue;
    const cat = interchangeByKey[key];
    if (!cat) continue;

    const vol  = monthly_volume * share;
    const txns = transaction_count * share;

    if (cat.id === 'amex_optblue') {
      amex_rate_bps = getAmexRate(processor, monthly_volume);
      interchange_cost += vol * (amex_rate_bps / 10000);
      // per-txn for amex included in processor buy rate, not interchange
    } else {
      interchange_cost += vol * (cat.rate_bps / 10000) + txns * (cat.per_txn_cents / 100);
    }
    per_txn_cost += txns * (processor.per_txn_cents / 100);
  }

  const processor_markup = monthly_volume * (processor.interchange_plus_bps / 10000);
  const agent_margin     = monthly_volume * agentMarginDecimal;
  const batch_count      = processor.batch_fee > 0
    ? Math.ceil(transaction_count / (processor.avg_batch_size || 50))
    : 0;
  const batch_fees       = batch_count * processor.batch_fee;
  const fixed_fees       = processor.monthly_fee + processor.pci_fee + processor.statement_fee;

  const estimated_monthly_fees = parseFloat(
    (interchange_cost + processor_markup + per_txn_cost + agent_margin + batch_fees + fixed_fees).toFixed(2)
  );
  const effective_rate    = parseFloat(((estimated_monthly_fees / monthly_volume) * 100).toFixed(2));
  const monthly_savings   = total_fees != null ? parseFloat((total_fees - estimated_monthly_fees).toFixed(2)) : null;
  const annual_savings    = monthly_savings != null ? parseFloat((monthly_savings * 12).toFixed(2)) : null;
  const monthly_residual  = parseFloat((monthly_volume * agentMarginDecimal).toFixed(2));
  const annual_residual   = parseFloat((monthly_residual * 12).toFixed(2));

  return {
    estimated_monthly_fees,
    effective_rate,
    monthly_savings,
    annual_savings,
    our_residual: { monthly: monthly_residual, annual: annual_residual },
    breakdown: {
      interchange:        parseFloat(interchange_cost.toFixed(2)),
      processor_markup:   parseFloat(processor_markup.toFixed(2)),
      per_transaction:    parseFloat(per_txn_cost.toFixed(2)),
      agent_margin:       parseFloat(agent_margin.toFixed(2)),
      batch_fees:         parseFloat(batch_fees.toFixed(2)),
      fixed_fees:         parseFloat(fixed_fees.toFixed(2)),
      card_mix_used:      cardMixSource,
      amex_rate_bps,
    },
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Compare all processors for a given merchant.
 *
 * @param {object} statementData - output of analyzeStatement()
 * @param {number} [agentMarginPct=0.30] - agent margin in basis points (e.g. 30 = 0.30%)
 * @returns {Array} ranked processor comparison array
 */
export function compareRates(statementData, agentMarginBps = 30) {
  const { monthly_volume, transaction_count } = statementData;

  if (!monthly_volume || monthly_volume <= 0) {
    throw new Error('Cannot compare rates: monthly_volume is required');
  }

  // Estimate transaction count if missing (~$85 avg ticket)
  const txn_count = transaction_count && transaction_count > 0
    ? transaction_count
    : Math.round(monthly_volume / 85);

  const data = { ...statementData, transaction_count: txn_count };

  const businessType = normalizeBusinessType(statementData.business_type);
  const { mix: cardMix, source: cardMixSource } = resolveCardMix(data, businessType);
  const agentMarginDecimal = agentMarginBps / 10000;

  const results = [];

  for (const [id, processor] of Object.entries(processors)) {
    try {
      const costResult = computeProcessorCost(data, cardMix, cardMixSource, processor, agentMarginDecimal);
      const { pros, cons } = generateProsCons(data, processor, costResult, businessType);
      results.push({
        processor_id:   id,
        processor_name: processor.name,
        ...costResult,
        pros,
        cons,
      });
    } catch (err) {
      console.warn(`[compare-rates] skipped ${id}:`, err.message);
    }
  }

  return results
    .sort((a, b) => {
      // Sort by monthly_savings desc; if null, push to end
      if (a.monthly_savings == null) return 1;
      if (b.monthly_savings == null) return -1;
      return b.monthly_savings - a.monthly_savings;
    })
    .map((r, i) => ({ rank: i + 1, ...r }));
}
