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

function beaconCardConnectFloor(monthly_volume, transaction_count, interchange, amex_volume) {
  const c = processors.beacon.platforms.cardconnect.costs;
  const bin_sponsorship = monthly_volume  * c.bin_sponsorship_percent;
  const auth_fees       = transaction_count * c.auth_fee_bankcard;
  const avs             = transaction_count * c.avs_fee;
  const batch_fees      = 30 * c.batch_fee;
  const amex_optblue    = amex_volume * c.amex_optblue_bin_sponsorship;
  const monthly_fixed   = c.transarmor_monthly + c.monthly_platform_fee; // $10/mo baseline (no Clover)

  const floor = interchange + bin_sponsorship + auth_fees + avs + batch_fees + amex_optblue + monthly_fixed;
  return {
    floor: parseFloat(floor.toFixed(2)),
    breakdown: {
      interchange:     parseFloat(interchange.toFixed(2)),
      bin_sponsorship: parseFloat(bin_sponsorship.toFixed(2)),
      auth_fees:       parseFloat(auth_fees.toFixed(2)),
      avs:             parseFloat(avs.toFixed(2)),
      batch_fees:      parseFloat(batch_fees.toFixed(2)),
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

// ── Upfront bonus calculations ────────────────────────────────────────────────

function beaconUpfrontBonus(monthly_residual) {
  const b = processors.beacon.bonuses;
  // 8x first-month residual, capped at $5,000; advance of $1,000 is the floor
  const multiplier_result = Math.min(monthly_residual * b.multiplier, b.multiplier_cap);
  return parseFloat(Math.max(b.advance_per_account, multiplier_result).toFixed(2));
}

function epiUpfrontBonus(monthly_residual, tier_key) {
  const t = processors.epi.tiers[tier_key];
  const activation  = t.activation_bonus ?? 0;
  const multiplier  = t.multiplier ?? 0;
  const cap         = t.multiplier_cap ?? 0;
  const multiplier_bonus = multiplier > 0 ? Math.min(monthly_residual * multiplier, cap) : 0;
  return parseFloat((activation + multiplier_bonus).toFixed(2));
}

// ── POS system routing ────────────────────────────────────────────────────────

function posSystemRouting(pos_system, best_merchant_savings) {
  const pos = (pos_system ?? '').toLowerCase().trim();

  if (!pos || pos === 'unknown' || pos === "i don't know" || pos === 'other' || pos === 'not provided') {
    return {
      pos_compatible: null,
      pos_locked: false,
      pos_recommendation: 'POS system unknown — verify equipment compatibility before closing',
      equipment_action: 'verify',
      negotiate_existing: false,
      preferred_processor: null,
      deal_difficulty_factor: 'unknown',
    };
  }

  if (/pax/.test(pos)) {
    return {
      pos_compatible: true,
      pos_locked: false,
      pos_recommendation: 'Merchant uses Pax — can reprogram existing terminal, no hardware change needed',
      equipment_action: 'reprogram',
      negotiate_existing: false,
      preferred_processor: null,
      deal_difficulty_factor: 'easy',
    };
  }

  if (/dejavoo/.test(pos)) {
    return {
      pos_compatible: true,
      pos_locked: false,
      pos_recommendation: 'Merchant uses Dejavoo — can reprogram existing terminal',
      equipment_action: 'reprogram',
      negotiate_existing: false,
      preferred_processor: null,
      deal_difficulty_factor: 'easy',
    };
  }

  if (/verifone/.test(pos)) {
    return {
      pos_compatible: true,
      pos_locked: false,
      pos_recommendation: 'Merchant uses Verifone — can reprogram existing terminal',
      equipment_action: 'reprogram',
      negotiate_existing: false,
      preferred_processor: null,
      deal_difficulty_factor: 'easy',
    };
  }

  if (/ingenico/.test(pos)) {
    return {
      pos_compatible: true,
      pos_locked: false,
      pos_recommendation: 'Merchant uses Ingenico — can reprogram existing terminal',
      equipment_action: 'reprogram',
      negotiate_existing: false,
      preferred_processor: null,
      deal_difficulty_factor: 'easy',
    };
  }

  if (/clover/.test(pos)) {
    return {
      pos_compatible: true,
      pos_locked: false,
      pos_recommendation: 'Merchant uses Clover — can keep existing hardware with Beacon (native Clover integration, $5/mo platform fee). Beacon Flex Sell available at 50% split. Kurv: flag for manual review. EPI: does not natively support Clover.',
      equipment_action: 'keep',
      negotiate_existing: false,
      preferred_processor: 'Beacon Payments',
      deal_difficulty_factor: 'easy',
    };
  }

  if (/square/.test(pos)) {
    return {
      pos_compatible: false,
      pos_locked: true,
      pos_recommendation: 'Merchant on Square — must switch hardware. Free terminal via EPI or Kurv. Free Clover via Beacon Flex Sell if volume qualifies. Highlight savings from eliminating Square flat rate (2.6% + $0.10) vs interchange-plus.',
      equipment_action: 'replace',
      negotiate_existing: false,
      preferred_processor: null,
      deal_difficulty_factor: 'medium',
    };
  }

  if (/toast/.test(pos)) {
    const threshold = 400;
    if (best_merchant_savings != null && best_merchant_savings < threshold) {
      return {
        pos_compatible: false,
        pos_locked: true,
        pos_recommendation: `Savings may not justify switching from Toast ($${best_merchant_savings}/mo savings vs $${threshold}/mo threshold). Consider helping merchant negotiate with Toast directly.`,
        equipment_action: 'negotiate existing',
        negotiate_existing: true,
        preferred_processor: null,
        deal_difficulty_factor: 'hard',
      };
    }
    return {
      pos_compatible: false,
      pos_locked: true,
      pos_recommendation: 'Merchant on Toast — must switch hardware. Savings justify switch. Recommend Beacon with Clover or EPI with Exatouch as replacement.',
      equipment_action: 'replace',
      negotiate_existing: false,
      preferred_processor: 'Beacon Payments',
      deal_difficulty_factor: 'medium',
    };
  }

  if (/heartland|genius/.test(pos)) {
    const threshold = 500;
    if (best_merchant_savings != null && best_merchant_savings < threshold) {
      return {
        pos_compatible: false,
        pos_locked: true,
        pos_recommendation: `Merchant on Heartland Genius — locked system. Savings ($${best_merchant_savings}/mo) below $${threshold}/mo threshold. Recommend helping merchant negotiate better rates directly with Heartland.`,
        equipment_action: 'negotiate existing',
        negotiate_existing: true,
        preferred_processor: null,
        deal_difficulty_factor: 'hard',
      };
    }
    return {
      pos_compatible: false,
      pos_locked: true,
      pos_recommendation: 'Merchant on Heartland Genius — locked system. Savings exceed $500/mo threshold — recommend full POS switch with Beacon (Clover) or EPI (Exatouch).',
      equipment_action: 'replace',
      negotiate_existing: false,
      preferred_processor: 'Beacon Payments',
      deal_difficulty_factor: 'hard',
    };
  }

  if (/spoton/.test(pos)) {
    const threshold = 400;
    if (best_merchant_savings != null && best_merchant_savings < threshold) {
      return {
        pos_compatible: false,
        pos_locked: true,
        pos_recommendation: `Savings may not justify switching from SpotOn ($${best_merchant_savings}/mo savings vs $${threshold}/mo threshold). Consider negotiating with SpotOn directly.`,
        equipment_action: 'negotiate existing',
        negotiate_existing: true,
        preferred_processor: null,
        deal_difficulty_factor: 'hard',
      };
    }
    return {
      pos_compatible: false,
      pos_locked: true,
      pos_recommendation: 'Merchant on SpotOn — must switch hardware. Savings justify switch.',
      equipment_action: 'replace',
      negotiate_existing: false,
      preferred_processor: null,
      deal_difficulty_factor: 'medium',
    };
  }

  if (/shopify|lightspeed|revel/.test(pos)) {
    return {
      pos_compatible: false,
      pos_locked: true,
      pos_recommendation: `Merchant on ${pos_system} — bundled POS system, processing tied to software. More involved to switch. Show the numbers and let savings make the case.`,
      equipment_action: 'replace',
      negotiate_existing: false,
      preferred_processor: null,
      deal_difficulty_factor: 'medium',
    };
  }

  // Unknown system
  return {
    pos_compatible: null,
    pos_locked: false,
    pos_recommendation: `POS system "${pos_system}" — verify equipment compatibility before closing`,
    equipment_action: 'verify',
    negotiate_existing: false,
    preferred_processor: null,
    deal_difficulty_factor: 'unknown',
  };
}

// ── Volume tier ───────────────────────────────────────────────────────────────

function volumeTier(monthly_volume) {
  if (monthly_volume < 10000)  return 'Less than $10,000';
  if (monthly_volume < 25000)  return '$10,000 - $25,000';
  if (monthly_volume < 50000)  return '$25,000 - $50,000';
  if (monthly_volume < 100000) return '$50,000 - $100,000';
  return '$100,000+';
}

function volumeNote(tier, options) {
  const epiA  = options.find(o => o.tier.includes('Option A'));
  const kurv  = options.find(o => o.processor === 'Kurv (EMS)');

  if (tier === 'Less than $10,000') {
    return { preferred_processor: epiA ?? null, note: 'Low volume merchant — EPI Option A zero auth fee recommended. Verify minimum fee requirements.' };
  }
  if (tier === '$100,000+') {
    return { preferred_processor: kurv ?? null, note: 'Enterprise volume — Kurv 80% residual split is the long-term play. EPI Option A zero auth fee also strong if transaction count is very high.' };
  }
  if (tier === '$50,000 - $100,000') {
    return { preferred_processor: kurv ?? null, note: 'High volume — Kurv 80% split very attractive for long-term residual. Beacon Flex Sell qualifies for 1-2 free POS stations.' };
  }
  if (tier === '$25,000 - $50,000') {
    return { preferred_processor: null, note: 'Mid-tier merchant — all processors competitive. Beacon Flex Sell qualifies for free handheld or mini POS.' };
  }
  // $10k-$25k
  return { preferred_processor: null, note: 'Small-mid merchant — EPI or Kurv both solid. Beacon Flex Sell may not qualify for free POS at this volume.' };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Compare Kurv, EPI Option A, EPI Option B, and Beacon Payments for a given merchant statement.
 * Applies POS routing and volume tier logic to the recommendation.
 * Uses 70/30 margin strategy: merchant gets 70% of savings gap, we keep 30%.
 *
 * @param {object} statementData - output of analyzeStatement (monthly_volume, total_fees, etc.)
 * @returns {object} full comparison with processor_comparison array, recommendation, routing fields
 */
export function compareRates(statementData) {
  const {
    monthly_volume,
    total_fees: current_fees,
    transaction_count: raw_txn_count,
    business_type: raw_business_type,
    card_mix,
    pos_system = null,
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
  const kurv       = kurvFloor(monthly_volume, transaction_count, interchange);
  const epi_b      = epiOptionBFloor(monthly_volume, transaction_count, interchange, amex_volume);
  const epi_a      = epiOptionAFloor(monthly_volume, transaction_count, interchange, amex_volume);
  const beacon_cc  = beaconCardConnectFloor(monthly_volume, transaction_count, interchange, amex_volume);

  // Margin strategy per option
  const margin_kurv     = applyMargin(kurv.floor, current_fees);
  const margin_epi_b    = applyMargin(epi_b.floor, current_fees);
  const margin_epi_a    = applyMargin(epi_a.floor, current_fees);
  const margin_beacon   = applyMargin(beacon_cc.floor, current_fees);

  // Residuals (our monthly take)
  const residual_kurv   = parseFloat((margin_kurv.our_gross_margin   * processors.kurv.residual_split).toFixed(2));
  const residual_epi_b  = parseFloat((margin_epi_b.our_gross_margin  * processors.epi.tiers.option_b.residual_split).toFixed(2));
  const residual_epi_a  = parseFloat((margin_epi_a.our_gross_margin  * processors.epi.tiers.option_a.residual_split).toFixed(2));
  const residual_beacon = parseFloat((margin_beacon.our_gross_margin * processors.beacon.platforms.cardconnect.residual_split).toFixed(2));

  // Upfront bonuses
  const bonus_epi_b  = epiUpfrontBonus(residual_epi_b, 'option_b');
  const bonus_epi_a  = epiUpfrontBonus(residual_epi_a, 'option_a');
  const bonus_beacon = beaconUpfrontBonus(residual_beacon);

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
    {
      processor:               'Beacon Payments',
      tier:                    'CardConnect — 60% Split',
      floor_cost:              beacon_cc.floor,
      floor_breakdown:         beacon_cc.breakdown,
      proposed_merchant_fees:  margin_beacon.proposed_fees,
      proposed_effective_rate: proposed_rate(monthly_volume, margin_beacon.proposed_fees),
      merchant_monthly_savings: margin_beacon.merchant_savings,
      merchant_annual_savings:  parseFloat((margin_beacon.merchant_savings * 12).toFixed(2)),
      our_gross_margin:        margin_beacon.our_gross_margin,
      our_monthly_residual:    residual_beacon,
      upfront_bonus:           bonus_beacon,
      first_year_total_income: parseFloat((bonus_beacon + residual_beacon * 12).toFixed(2)),
    },
  ];

  // Rankings (pure rate-based)
  const best_for_merchant       = [...options].sort((a, b) => b.merchant_monthly_savings - a.merchant_monthly_savings)[0];
  const best_for_agent_longterm = [...options].sort((a, b) => b.our_monthly_residual - a.our_monthly_residual)[0];
  const best_for_agent_upfront  = [...options].sort((a, b) => b.first_year_total_income - a.first_year_total_income)[0];

  // POS routing — needs best savings to evaluate locked-POS thresholds
  const posRouting = posSystemRouting(pos_system, best_for_merchant.merchant_monthly_savings);

  // Volume tier + note
  const tier = volumeTier(monthly_volume);
  const { preferred_processor: volPreferred, note: volumeNote_ } = volumeNote(tier, options);

  // Resolve final recommended processor:
  // POS routing takes priority over volume routing; rate-based best is the fallback
  let recommendedOption = best_for_merchant;
  if (posRouting.negotiate_existing) {
    // Don't recommend a processor — advise negotiating with current provider
  } else if (posRouting.preferred_processor) {
    const found = options.find(o => o.processor === posRouting.preferred_processor);
    if (found) recommendedOption = found;
  } else if (volPreferred) {
    recommendedOption = volPreferred;
  }

  const recommended = posRouting.negotiate_existing
    ? 'negotiate_existing'
    : `${recommendedOption.processor} — ${recommendedOption.tier}`;

  // Deal difficulty: negotiate_existing → hard; use POS factor unless unknown (then medium)
  let deal_difficulty;
  if (posRouting.negotiate_existing) {
    deal_difficulty = 'hard';
  } else if (posRouting.deal_difficulty_factor === 'easy') {
    deal_difficulty = 'easy';
  } else if (posRouting.deal_difficulty_factor === 'hard') {
    deal_difficulty = 'hard';
  } else if (posRouting.deal_difficulty_factor === 'medium') {
    deal_difficulty = 'medium';
  } else {
    deal_difficulty = 'medium'; // unknown POS — assume medium
  }

  return {
    processor_comparison: options,
    recommendation: {
      best_for_merchant:        `${best_for_merchant.processor} — ${best_for_merchant.tier}`,
      best_for_agent_long_term: `${best_for_agent_longterm.processor} — ${best_for_agent_longterm.tier}`,
      best_for_agent_upfront:   `${best_for_agent_upfront.processor} — ${best_for_agent_upfront.tier}`,
      recommended,
      reason: posRouting.negotiate_existing
        ? posRouting.pos_recommendation
        : `${recommendedOption.processor} — ${recommendedOption.tier}: $${recommendedOption.proposed_merchant_fees}/mo proposed, saving merchant $${recommendedOption.merchant_monthly_savings}/mo ($${recommendedOption.merchant_annual_savings}/yr).`,
      volume_note: volumeNote_,
    },
    margin_strategy: {
      savings_gap:           margin_kurv.savings_gap,
      merchant_gets_percent: 70,
      we_keep_percent:       30,
    },
    // POS and volume routing fields
    pos_system,
    pos_compatible:     posRouting.pos_compatible,
    pos_locked:         posRouting.pos_locked,
    pos_recommendation: posRouting.pos_recommendation,
    equipment_action:   posRouting.equipment_action,
    volume_tier:        tier,
    deal_difficulty,
    // Convenience fields for email/follow-up-call compatibility
    best: recommendedOption,
  };
}
