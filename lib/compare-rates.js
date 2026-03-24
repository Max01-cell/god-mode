import processors from '../rates/processors.js';

// ── Interchange estimation ────────────────────────────────────────────────────
// Blended interchange rates by business type (weighted avg of Visa/MC/Debit mix)
const BLENDED_INTERCHANGE = {
  restaurant: 0.0152,
  retail:     0.0155,
  ecommerce:  0.0178,
  services:   0.0160,
  moto:       0.0178,
  default:    0.0158,
};

// Estimated Amex share of total volume by business type
const AMEX_SHARE = {
  restaurant: 0.10,
  retail:     0.10,
  ecommerce:  0.14,
  services:   0.12,
  default:    0.10,
};

function normalizeBusinessType(raw) {
  if (!raw) return 'default';
  const s = raw.toLowerCase();
  if (/restaurant|cafe|bar|diner|food|bistro|pizza|grill/.test(s)) return 'restaurant';
  if (/retail|store|shop|boutique|hardware|grocery/.test(s))        return 'retail';
  if (/ecommerce|e-commerce|online|web|internet/.test(s))           return 'ecommerce';
  if (/service|salon|spa|clinic|dental|auto|repair/.test(s))        return 'services';
  if (/moto|mail|telephone|order/.test(s))                          return 'moto';
  return 'default';
}

function estimateInterchange(monthly_volume, businessType) {
  const rate = BLENDED_INTERCHANGE[businessType] ?? BLENDED_INTERCHANGE.default;
  return monthly_volume * rate;
}

function estimateAmexVolume(monthly_volume, businessType, card_mix) {
  if (card_mix?.amex_percent != null) {
    return monthly_volume * (card_mix.amex_percent / 100);
  }
  return monthly_volume * (AMEX_SHARE[businessType] ?? AMEX_SHARE.default);
}

// ── Floor cost calculators ────────────────────────────────────────────────────

function kurvFloor(monthly_volume, transaction_count, interchange) {
  const c = processors.kurv.costs;
  const bin_sponsorship   = monthly_volume  * c.bin_sponsorship_percent;
  const auth_fees         = transaction_count * c.auth_fee_bank_card_ip;
  const avs               = transaction_count * c.avs_fee;
  const batch_fees        = 30 * c.batch_fee;                     // 30 batches/month
  const tech_compliance   = c.semi_annual_tech_compliance / 6;    // amortized monthly
  const monthly_fixed     = c.monthly_access_fee + c.monthly_breach_protection + c.platinum_club + tech_compliance;

  const floor = interchange + bin_sponsorship + auth_fees + avs + batch_fees + monthly_fixed;
  return {
    floor: parseFloat(floor.toFixed(2)),
    breakdown: {
      interchange:     parseFloat(interchange.toFixed(2)),
      bin_sponsorship: parseFloat(bin_sponsorship.toFixed(2)),
      auth_fees:       parseFloat(auth_fees.toFixed(2)),
      avs:             parseFloat(avs.toFixed(2)),
      batch_fees:      parseFloat(batch_fees.toFixed(2)),
      monthly_fixed:   parseFloat(monthly_fixed.toFixed(2)),
    },
  };
}

function epiOptionBFloor(monthly_volume, transaction_count, interchange, amex_volume) {
  const t = processors.epi.tiers.option_b;
  const bin_sponsorship   = monthly_volume  * t.bin_sponsorship_percent;
  const auth_fees         = transaction_count * t.auth_fee_cygma;
  const avs               = transaction_count * t.avs_fee;
  const amex_optblue      = amex_volume * t.amex_optblue_percent;
  const monthly_fixed     = t.platform_admin_monthly + t.pci_compliance_monthly +
                            t.regulatory_compliance_monthly + t.account_on_file_monthly +
                            processors.epi.statement_fee_required;

  const floor = interchange + bin_sponsorship + auth_fees + avs + amex_optblue + monthly_fixed;
  return {
    floor: parseFloat(floor.toFixed(2)),
    breakdown: {
      interchange:     parseFloat(interchange.toFixed(2)),
      bin_sponsorship: parseFloat(bin_sponsorship.toFixed(2)),
      auth_fees:       parseFloat(auth_fees.toFixed(2)),
      avs:             parseFloat(avs.toFixed(2)),
      amex_optblue:    parseFloat(amex_optblue.toFixed(2)),
      monthly_fixed:   parseFloat(monthly_fixed.toFixed(2)),
    },
  };
}

function epiOptionAFloor(monthly_volume, transaction_count, interchange, amex_volume) {
  const t = processors.epi.tiers.option_a;
  // Option A: ZERO auth fee on Cygma, lower amex OptBlue rate
  const bin_sponsorship   = monthly_volume  * (t.cbd_bin_percent ?? 0.0002);
  const auth_fees         = transaction_count * t.auth_fee_cygma; // 0.00
  const avs               = transaction_count * t.avs_fee;
  const amex_optblue      = amex_volume * t.amex_optblue_percent; // 0.10%
  const monthly_fixed     = t.platform_admin_monthly;

  const floor = interchange + bin_sponsorship + auth_fees + avs + amex_optblue + monthly_fixed;
  return {
    floor: parseFloat(floor.toFixed(2)),
    breakdown: {
      interchange:     parseFloat(interchange.toFixed(2)),
      bin_sponsorship: parseFloat(bin_sponsorship.toFixed(2)),
      auth_fees:       parseFloat(auth_fees.toFixed(2)),       // $0
      avs:             parseFloat(avs.toFixed(2)),
      amex_optblue:    parseFloat(amex_optblue.toFixed(2)),
      monthly_fixed:   parseFloat(monthly_fixed.toFixed(2)),
    },
  };
}

// ── Margin strategy ───────────────────────────────────────────────────────────

function applyMargin(floorCost, currentFees) {
  const savings_gap         = currentFees - floorCost;
  const merchant_savings    = parseFloat((savings_gap * 0.70).toFixed(2));
  const our_gross_margin    = parseFloat((savings_gap * 0.30).toFixed(2));
  const proposed_fees       = parseFloat((currentFees - merchant_savings).toFixed(2));
  return { savings_gap: parseFloat(savings_gap.toFixed(2)), merchant_savings, our_gross_margin, proposed_fees };
}

// ── Upfront bonus calculation ─────────────────────────────────────────────────

function epiUpfrontBonus(monthly_residual, tier_key) {
  const t = processors.epi.tiers[tier_key];
  const activation  = t.activation_bonus ?? 0;
  const multiplier  = t.multiplier ?? 0;
  const cap         = t.multiplier_cap ?? 0;
  const multiplier_bonus = multiplier > 0 ? Math.min(monthly_residual * multiplier, cap) : 0;
  return parseFloat((activation + multiplier_bonus).toFixed(2));
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Compare Kurv, EPI Option A, and EPI Option B for a given merchant statement.
 * Uses 70/30 margin strategy: merchant gets 70% of savings gap, we keep 30%.
 *
 * @param {object} statementData - output of analyzeStatement (monthly_volume, total_fees, etc.)
 * @returns {object} full comparison with processor_comparison array, recommendation, margin_strategy
 */
export function compareRates(statementData) {
  const {
    monthly_volume,
    total_fees: current_fees,
    transaction_count: raw_txn_count,
    business_type: raw_business_type,
    card_mix,
  } = statementData;

  if (!monthly_volume || monthly_volume <= 0) {
    throw new Error('Cannot compare rates: monthly_volume is required');
  }
  if (!current_fees || current_fees <= 0) {
    throw new Error('Cannot compare rates: total_fees (current fees) is required');
  }

  const businessType     = normalizeBusinessType(raw_business_type);
  const transaction_count = raw_txn_count && raw_txn_count > 0
    ? raw_txn_count
    : Math.round(monthly_volume / 85); // estimate from ~$85 avg ticket

  const interchange  = estimateInterchange(monthly_volume, businessType);
  const amex_volume  = estimateAmexVolume(monthly_volume, businessType, card_mix);

  // Floor costs
  const kurv    = kurvFloor(monthly_volume, transaction_count, interchange);
  const epi_b   = epiOptionBFloor(monthly_volume, transaction_count, interchange, amex_volume);
  const epi_a   = epiOptionAFloor(monthly_volume, transaction_count, interchange, amex_volume);

  // Margin strategy per option
  const margin_kurv  = applyMargin(kurv.floor, current_fees);
  const margin_epi_b = applyMargin(epi_b.floor, current_fees);
  const margin_epi_a = applyMargin(epi_a.floor, current_fees);

  // Residuals (our monthly take)
  const residual_kurv  = parseFloat((margin_kurv.our_gross_margin  * processors.kurv.residual_split).toFixed(2));
  const residual_epi_b = parseFloat((margin_epi_b.our_gross_margin * processors.epi.tiers.option_b.residual_split).toFixed(2));
  const residual_epi_a = parseFloat((margin_epi_a.our_gross_margin * processors.epi.tiers.option_a.residual_split).toFixed(2));

  // EPI upfront bonuses
  const bonus_epi_b = epiUpfrontBonus(residual_epi_b, 'option_b');
  const bonus_epi_a = epiUpfrontBonus(residual_epi_a, 'option_a');

  const proposed_rate = (v, fees) => parseFloat(((fees / monthly_volume) * 100).toFixed(2));

  const options = [
    {
      processor:               'Kurv (EMS)',
      tier:                    'Retail 80%',
      floor_cost:              kurv.floor,
      floor_breakdown:         kurv.breakdown,
      proposed_merchant_fees:  margin_kurv.proposed_fees,
      proposed_effective_rate: proposed_rate(monthly_volume, margin_kurv.proposed_fees),
      merchant_monthly_savings: margin_kurv.merchant_savings,
      merchant_annual_savings:  parseFloat((margin_kurv.merchant_savings * 12).toFixed(2)),
      our_gross_margin:        margin_kurv.our_gross_margin,
      our_monthly_residual:    residual_kurv,
      upfront_bonus:           processors.kurv.bonuses.activation_bonus,
      first_year_total_income: parseFloat((processors.kurv.bonuses.activation_bonus + residual_kurv * 12).toFixed(2)),
    },
    {
      processor:               'EPI',
      tier:                    'Option B — 6x Multiplier',
      floor_cost:              epi_b.floor,
      floor_breakdown:         epi_b.breakdown,
      proposed_merchant_fees:  margin_epi_b.proposed_fees,
      proposed_effective_rate: proposed_rate(monthly_volume, margin_epi_b.proposed_fees),
      merchant_monthly_savings: margin_epi_b.merchant_savings,
      merchant_annual_savings:  parseFloat((margin_epi_b.merchant_savings * 12).toFixed(2)),
      our_gross_margin:        margin_epi_b.our_gross_margin,
      our_monthly_residual:    residual_epi_b,
      upfront_bonus:           bonus_epi_b,
      first_year_total_income: parseFloat((bonus_epi_b + residual_epi_b * 12).toFixed(2)),
    },
    {
      processor:               'EPI',
      tier:                    'Option A — Zero Auth Fee',
      floor_cost:              epi_a.floor,
      floor_breakdown:         epi_a.breakdown,
      proposed_merchant_fees:  margin_epi_a.proposed_fees,
      proposed_effective_rate: proposed_rate(monthly_volume, margin_epi_a.proposed_fees),
      merchant_monthly_savings: margin_epi_a.merchant_savings,
      merchant_annual_savings:  parseFloat((margin_epi_a.merchant_savings * 12).toFixed(2)),
      our_gross_margin:        margin_epi_a.our_gross_margin,
      our_monthly_residual:    residual_epi_a,
      upfront_bonus:           bonus_epi_a,
      first_year_total_income: parseFloat((bonus_epi_a + residual_epi_a * 12).toFixed(2)),
    },
  ];

  // Rankings
  const best_for_merchant      = [...options].sort((a, b) => b.merchant_monthly_savings - a.merchant_monthly_savings)[0];
  const best_for_agent_longterm = [...options].sort((a, b) => b.our_monthly_residual - a.our_monthly_residual)[0];
  const best_for_agent_upfront  = [...options].sort((a, b) => b.first_year_total_income - a.first_year_total_income)[0];

  return {
    processor_comparison: options,
    recommendation: {
      best_for_merchant:       `${best_for_merchant.processor} — ${best_for_merchant.tier}`,
      best_for_agent_long_term: `${best_for_agent_longterm.processor} — ${best_for_agent_longterm.tier}`,
      best_for_agent_upfront:  `${best_for_agent_upfront.processor} — ${best_for_agent_upfront.tier}`,
      recommended:             `${best_for_merchant.processor} — ${best_for_merchant.tier}`,
      reason:                  `Lowest proposed fees at $${best_for_merchant.proposed_merchant_fees}/mo, saving merchant $${best_for_merchant.merchant_monthly_savings}/mo ($${best_for_merchant.merchant_annual_savings}/yr).`,
    },
    margin_strategy: {
      savings_gap:           margin_kurv.savings_gap, // representative — all options start from same current_fees
      merchant_gets_percent: 70,
      we_keep_percent:       30,
    },
    // Convenience fields for email/follow-up-call compatibility
    best: best_for_merchant,
  };
}
